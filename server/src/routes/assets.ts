import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  Asset,
  Memory,
  Page,
  TimelineBucket,
  UploadCheckResponse,
  UploadResult,
} from '@platen/shared';
import { sql } from '../db/index.js';
import { badRequest, forbidden, notFound, quotaExceeded } from '../lib/errors.js';
import { assetColumns, assetColumnsWithExif, toAssetDto, type AssetRow } from '../lib/mappers.js';
import { classify } from '../lib/media-types.js';
import { queryBoolean } from '../lib/query.js';
import { IMMUTABLE_PRIVATE, sendFile } from '../lib/send-file.js';
import {
  buildStoragePath,
  commitUpload,
  discardOriginal,
  discardUpload,
  externalRootPath,
  libraryPath,
  originalPathFor,
  stageUpload,
  thumbDir,
  thumbsPath,
} from '../lib/storage.js';
import { auth, MEDIA_ROUTE, requireAuth } from '../middleware/auth.js';
import { getCached, previewKey, setCached, thumbKey } from '../services/cache.js';
import { enqueue } from '../jobs/queue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeCursor(takenAt: Date, id: string): string {
  return Buffer.from(`${takenAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { takenAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!iso || !id) return null;
    const takenAt = new Date(iso);
    if (Number.isNaN(takenAt.getTime())) return null;
    return { takenAt, id };
  } catch {
    return null;
  }
}

const filterSchema = z.object({
  albumId: z.string().uuid().optional(),
  personId: z.string().uuid().optional(),
  favorite: queryBoolean.optional(),
  archived: queryBoolean.optional(),
  trashed: queryBoolean.optional(),
  cursor: z.string().optional(),
  /**
   * Start the page at this instant instead of at the newest asset.
   *
   * Cursor paging alone can only walk backwards from the top, so reaching 2019
   * in a large library would mean loading every photo since. The scrubber needs
   * to land directly on a date.
   */
  from: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(120),
});

type Filters = z.infer<typeof filterSchema>;

/** Builds the shared WHERE clause for every timeline-ish query. */
function buildWhere(userId: string, f: Filters) {
  const parts = [sql`a.owner_id = ${userId}`];

  parts.push(f.trashed ? sql`a.deleted_at IS NOT NULL` : sql`a.deleted_at IS NULL`);

  // Archived assets are hidden from the main timeline but reachable directly.
  if (f.archived === true) parts.push(sql`a.is_archived = true`);
  else if (!f.albumId && !f.trashed) parts.push(sql`a.is_archived = false`);

  if (f.favorite) parts.push(sql`a.is_favorite = true`);
  if (f.albumId) {
    parts.push(sql`EXISTS (SELECT 1 FROM album_assets aa WHERE aa.asset_id = a.id AND aa.album_id = ${f.albumId})`);
  }
  if (f.personId) {
    parts.push(sql`EXISTS (SELECT 1 FROM faces fc WHERE fc.asset_id = a.id AND fc.person_id = ${f.personId})`);
  }

  return parts.reduce((acc, part) => sql`${acc} AND ${part}`);
}

async function loadOwnedAsset(assetId: string, userId: string): Promise<AssetRow> {
  const rows = await sql<AssetRow[]>`
    SELECT ${sql.unsafe(assetColumnsWithExif())}, l.path AS library_root
    FROM assets a
    LEFT JOIN asset_exif e ON e.asset_id = a.id
    LEFT JOIN external_libraries l ON l.id = a.library_id
    WHERE a.id = ${assetId}
  `;
  const row = rows[0];
  if (!row) throw notFound('That photo no longer exists.');

  if (row.owner_id !== userId) {
    // Shared albums grant read access to assets the viewer does not own.
    const shared = await sql`
      SELECT 1 FROM album_assets aa
      JOIN album_users au ON au.album_id = aa.album_id
      WHERE aa.asset_id = ${assetId} AND au.user_id = ${userId}
      LIMIT 1
    `;
    if (shared.length === 0) throw forbidden('You do not have access to that photo.');
  }
  return row;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * Pre-flight dedupe. The mobile app hashes its camera roll locally and asks
   * "which of these do you already have?" before sending a single byte. This is
   * what makes a re-scan of a 40k-photo library take seconds instead of hours.
   */
  app.post('/check', async (request) => {
    const { userId } = auth(request);
    const { checksums } = z
      .object({ checksums: z.array(z.string().regex(/^[a-f0-9]{64}$/i)).max(1000) })
      .parse(request.body);

    if (checksums.length === 0) return { existing: {} } satisfies UploadCheckResponse;

    // Hex text in, decoded server-side: postgres.js serialises a JS array of
    // Buffers as a single bytea rather than a bytea[], and decoding in SQL keeps
    // the (owner_id, checksum) index usable for the lookup.
    const lowered = checksums.map((c) => c.toLowerCase());
    const rows = await sql<{ id: string; checksum: Buffer }[]>`
      SELECT id, checksum FROM assets
      WHERE owner_id = ${userId}
        AND checksum IN (SELECT decode(hex, 'hex') FROM unnest(${lowered}::text[]) AS t(hex))
    `;

    const existing: Record<string, string> = {};
    for (const row of rows) existing[Buffer.from(row.checksum).toString('hex')] = row.id;
    return { existing } satisfies UploadCheckResponse;
  });

  /**
   * Upload one file. Multipart, streamed straight to disk while hashing.
   *
   * Returns 200 with `duplicate: true` rather than an error when the checksum
   * already exists — the client treats "already backed up" as success, which
   * keeps retry logic on the phone simple.
   */
  app.post('/upload', async (request, reply) => {
    const { userId } = auth(request);

    const data = await request.file();
    if (!data) throw badRequest('No file was included in the request.');

    // Client-supplied fields ride alongside the file part.
    const fields = data.fields as Record<string, { value?: unknown } | undefined>;
    const readField = (name: string): string | undefined => {
      const raw = fields[name]?.value;
      return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    };

    const filename = data.filename || 'upload';
    const { type, mime } = classify(data.mimetype || '', filename);

    const staged = await stageUpload(data.file);

    try {
      if (data.file.truncated) {
        throw badRequest('The upload was cut short. Please try again.');
      }

      // Quota check before we commit the bytes to the library.
      const [quotaRow] = await sql<{ quota_bytes: string | null; used: string }[]>`
        SELECT u.quota_bytes,
               COALESCE((SELECT SUM(file_size) FROM assets WHERE owner_id = u.id AND deleted_at IS NULL), 0)::text AS used
        FROM users u WHERE u.id = ${userId}
      `;
      if (quotaRow?.quota_bytes !== null && quotaRow !== undefined) {
        const quota = Number(quotaRow.quota_bytes);
        if (Number(quotaRow.used) + staged.size > quota) {
          throw quotaExceeded('This upload would exceed your storage quota.');
        }
      }

      const checksumBuffer = Buffer.from(staged.checksum, 'hex');

      /** An existing copy of these bytes, restored from the trash if it was there. */
      const existingCopy = async (): Promise<AssetRow | undefined> => {
        const duplicates = await sql<AssetRow[]>`
          SELECT ${sql.unsafe(assetColumnsWithExif())}
          FROM assets a
          LEFT JOIN asset_exif e ON e.asset_id = a.id
          WHERE a.owner_id = ${userId} AND a.checksum = ${checksumBuffer}
        `;
        const duplicate = duplicates[0];
        // Undelete if it was sitting in the trash; the user clearly wants it.
        if (duplicate?.deleted_at) {
          await sql`UPDATE assets SET deleted_at = NULL WHERE id = ${duplicate.id}`;
          duplicate.deleted_at = null;
        }
        return duplicate;
      };

      const duplicate = await existingCopy();
      if (duplicate) {
        await discardUpload(staged.tmpPath);
        return reply.send({ asset: toAssetDto(duplicate), duplicate: true } satisfies UploadResult);
      }

      // Provisional capture time from the client (file mtime on the phone);
      // the metadata job replaces it with EXIF DateTimeOriginal shortly after.
      const clientTakenAt = readField('takenAt');
      const parsedTakenAt = clientTakenAt ? new Date(clientTakenAt) : null;
      const takenAt =
        parsedTakenAt && !Number.isNaN(parsedTakenAt.getTime()) ? parsedTakenAt : new Date();

      const assetId = crypto.randomUUID();
      const storagePath = buildStoragePath(userId, assetId, takenAt, filename);

      await commitUpload(staged.tmpPath, storagePath);

      // From here the bytes sit in the library, so any failure has to take
      // them back out: an original with no row is invisible to the app and
      // never cleaned up by anything.
      let inserted: AssetRow[];
      try {
        // ON CONFLICT covers an identical upload (the web uploader and the
        // phone sending the same photo, say) that landed after the duplicate
        // check above but before this insert.
        inserted = await sql<AssetRow[]>`
          INSERT INTO assets (
            id, owner_id, checksum, type, original_filename, storage_path,
            mime_type, file_size, taken_at, device_id, device_asset_id
          ) VALUES (
            ${assetId}, ${userId}, ${checksumBuffer}, ${type}, ${filename}, ${storagePath},
            ${mime}, ${staged.size}, ${takenAt}, ${readField('deviceId') ?? null},
            ${readField('deviceAssetId') ?? null}
          )
          ON CONFLICT (owner_id, checksum) DO NOTHING
          RETURNING ${sql.unsafe(assetColumns())}
        `;
      } catch (err) {
        await discardOriginal(storagePath);
        throw err;
      }

      const row = inserted[0];
      if (!row) {
        await discardOriginal(storagePath);
        const winner = await existingCopy();
        if (!winner) throw badRequest('Could not record the upload. Please try again.');
        return reply.send({ asset: toAssetDto(winner), duplicate: true } satisfies UploadResult);
      }

      await enqueue('metadata', { assetId }, `metadata:${assetId}`);

      return reply.code(201).send({ asset: toAssetDto(row), duplicate: false } satisfies UploadResult);
    } catch (err) {
      await discardUpload(staged.tmpPath);
      throw err;
    }
  });

  /**
   * Every device-asset id this phone has already uploaded.
   *
   * Lets a reinstalled app rebuild its local "already backed up" ledger from
   * the server instead of re-uploading an entire camera roll only to discover
   * that every single file is a duplicate.
   */
  app.get('/device/:deviceId', async (request) => {
    const { userId } = auth(request);
    const { deviceId } = z.object({ deviceId: z.string().min(1).max(200) }).parse(request.params);

    const rows = await sql<{ device_asset_id: string }[]>`
      SELECT device_asset_id FROM assets
      WHERE owner_id = ${userId}
        AND device_id = ${deviceId}
        AND device_asset_id IS NOT NULL
        AND deleted_at IS NULL
    `;
    return { deviceAssetIds: rows.map((row) => row.device_asset_id) };
  });

  /** Day-bucketed counts, so the web grid can size its scrollbar without
   *  fetching every row. */
  app.get('/timeline/buckets', async (request) => {
    const { userId } = auth(request);
    const filters = filterSchema.parse(request.query);
    const where = buildWhere(userId, filters);

    const rows = await sql<{ date: string; count: number }[]>`
      SELECT to_char(a.taken_at, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
      FROM assets a
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1 DESC
    `;
    return rows satisfies TimelineBucket[];
  });

  /**
   * Photos taken on this date in earlier years.
   *
   * `month` and `day` are the client's, not the server's. A NAS in UTC and a
   * phone in Chicago disagree about what day it is for six hours out of every
   * twenty-four, and the viewer is right — so whoever is asking says which date
   * they mean, and the server only falls back to its own when not told.
   *
   * Matching is on the camera's wall clock rather than the stored instant, for
   * the same reason the timeline groups that way: a photo taken at 11pm on
   * someone's birthday should resurface on that birthday, not the day after.
   */
  app.get('/memories', async (request) => {
    const { userId } = auth(request);
    const query = z
      .object({
        month: z.coerce.number().int().min(1).max(12).optional(),
        day: z.coerce.number().int().min(1).max(31).optional(),
        /** Most recent years first; older ones are usually the better memory. */
        limitYears: z.coerce.number().int().min(1).max(20).default(8),
        perYear: z.coerce.number().int().min(1).max(60).default(24),
      })
      .parse(request.query);

    const now = new Date();
    const month = query.month ?? now.getMonth() + 1;
    const day = query.day ?? now.getDate();
    const thisYear = now.getFullYear();

    // The camera's wall clock: the stored instant shifted by the offset the
    // file recorded, exactly as the clients do when they group by day.
    const localTaken = sql`
      (a.taken_at AT TIME ZONE 'UTC' + COALESCE(a.taken_at_offset, '+00:00')::interval)
    `;

    const years = await sql<{ year: number; count: number }[]>`
      SELECT EXTRACT(YEAR FROM ${localTaken})::int AS year, COUNT(*)::int AS count
      FROM assets a
      WHERE a.owner_id = ${userId}
        AND a.deleted_at IS NULL
        AND a.is_archived = false
        AND EXTRACT(MONTH FROM ${localTaken}) = ${month}
        AND EXTRACT(DAY FROM ${localTaken}) = ${day}
      GROUP BY 1
      HAVING EXTRACT(YEAR FROM ${localTaken})::int < ${thisYear}
      ORDER BY 1 DESC
      LIMIT ${query.limitYears}
    `;

    const memories: Memory[] = [];
    for (const { year, count } of years) {
      const rows = await sql<AssetRow[]>`
        SELECT ${sql.unsafe(assetColumns())}
        FROM assets a
        WHERE a.owner_id = ${userId}
          AND a.deleted_at IS NULL
          AND a.is_archived = false
          AND EXTRACT(YEAR FROM ${localTaken}) = ${year}
          AND EXTRACT(MONTH FROM ${localTaken}) = ${month}
          AND EXTRACT(DAY FROM ${localTaken}) = ${day}
        ORDER BY a.taken_at
        LIMIT ${query.perYear}
      `;
      if (rows.length === 0) continue;

      memories.push({
        year,
        yearsAgo: thisYear - year,
        date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        assetCount: count,
        assets: rows.map(toAssetDto),
      });
    }

    return memories;
  });

  /** Cursor-paged asset list, newest first. */
  app.get('/', async (request) => {
    const { userId } = auth(request);
    const filters = filterSchema.parse(request.query);
    let where = buildWhere(userId, filters);

    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor);
      if (!cursor) throw badRequest('Invalid pagination cursor.');
      // Keyset pagination on (taken_at, id) — stable even while new photos
      // arrive mid-scroll, unlike OFFSET.
      where = sql`${where} AND (a.taken_at, a.id) < (${cursor.takenAt}, ${cursor.id})`;
    } else if (filters.from) {
      // A jump: begin at the first asset at or before this instant. The same
      // index serves it, so landing on an arbitrary date costs no more than
      // loading the top of the timeline.
      where = sql`${where} AND a.taken_at <= ${new Date(filters.from)}`;
    }

    const rows = await sql<AssetRow[]>`
      SELECT ${sql.unsafe(assetColumnsWithExif())}
      FROM assets a
      LEFT JOIN asset_exif e ON e.asset_id = a.id
      WHERE ${where}
      ORDER BY a.taken_at DESC, a.id DESC
      LIMIT ${filters.limit + 1}
    `;

    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toAssetDto),
      nextCursor: hasMore && last ? encodeCursor(last.taken_at, last.id) : null,
    } satisfies Page<Asset>;
  });

  app.get('/:id', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return toAssetDto(await loadOwnedAsset(id, userId));
  });

  /**
   * Serves a derivative, preferring the cache.
   *
   * Cache-aside rather than write-through: disk stays the source of truth and
   * Redis only ever holds a copy, so a cold, evicted or missing cache is just
   * a slower path rather than a missing image. Scrolling the grid fires
   * hundreds of these, which is why it is worth caching at all.
   */
  const sendDerivative = async (
    reply: FastifyReply,
    row: AssetRow,
    file: 'thumb.webp' | 'preview.webp',
    key: string,
  ): Promise<FastifyReply> => {
    const cached = await getCached(key);
    if (cached) {
      reply.header('Content-Type', 'image/webp');
      reply.header('Content-Length', cached.byteLength);
      reply.header('Cache-Control', IMMUTABLE_PRIVATE);
      reply.header('X-Cache', 'HIT');
      return reply.send(cached);
    }

    const path = join(thumbsPath(thumbDir(row.owner_id, row.id)), file);

    // Read once and serve from memory, so populating the cache costs no extra
    // disk read. Failures fall through to the streaming path, which also
    // produces the correct 404 when the derivative does not exist yet.
    try {
      const bytes = await readFile(path);
      void setCached(key, bytes);

      reply.header('Content-Type', 'image/webp');
      reply.header('Content-Length', bytes.byteLength);
      reply.header('Cache-Control', IMMUTABLE_PRIVATE);
      reply.header('X-Cache', 'MISS');
      return reply.send(bytes);
    } catch {
      return sendFile(reply, path, 'image/webp', { cacheControl: IMMUTABLE_PRIVATE });
    }
  };

  app.get('/:id/thumbnail', MEDIA_ROUTE, async (request, reply) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await loadOwnedAsset(id, userId);
    return sendDerivative(reply, row, 'thumb.webp', thumbKey(row.id));
  });

  app.get('/:id/preview', MEDIA_ROUTE, async (request, reply) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await loadOwnedAsset(id, userId);
    return sendDerivative(reply, row, 'preview.webp', previewKey(row.id));
  });

  app.get('/:id/original', MEDIA_ROUTE, async (request, reply) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ download: queryBoolean.optional() }).parse(request.query);
    const row = await loadOwnedAsset(id, userId);

    const absolute = row.library_root
      ? originalPathFor(row.storage_path, externalRootPath(row.library_root))
      : libraryPath(row.storage_path);

    return sendFile(reply, absolute, row.mime_type, {
      rangeHeader: request.headers.range,
      downloadName: query.download ? row.original_filename : undefined,
      cacheControl: IMMUTABLE_PRIVATE,
    });
  });

  app.patch('/:id', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        isFavorite: z.boolean().optional(),
        isArchived: z.boolean().optional(),
        takenAt: z.string().datetime().optional(),
      })
      .parse(request.body);

    const rows = await sql<AssetRow[]>`
      UPDATE assets a SET
        is_favorite = COALESCE(${body.isFavorite ?? null}, a.is_favorite),
        is_archived = COALESCE(${body.isArchived ?? null}, a.is_archived),
        taken_at    = COALESCE(${body.takenAt ? new Date(body.takenAt) : null}, a.taken_at)
      WHERE a.id = ${id} AND a.owner_id = ${userId}
      RETURNING ${sql.unsafe(assetColumns())}
    `;
    const row = rows[0];
    if (!row) throw notFound('That photo no longer exists.');
    return toAssetDto(row);
  });

  /** Soft delete by default; `?permanent=true` skips the trash entirely. */
  app.post('/delete', async (request, reply) => {
    const { userId } = auth(request);
    const { ids, permanent } = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(1000), permanent: z.boolean().default(false) })
      .parse(request.body);

    if (permanent) {
      const rows = await sql<
        { id: string; owner_id: string; storage_path: string; library_id: string | null }[]
      >`
        SELECT id, owner_id, storage_path, library_id FROM assets
        WHERE id = ANY(${ids}::uuid[]) AND owner_id = ${userId}
      `;
      const { deleteAssetFiles } = await import('../lib/storage.js');
      for (const row of rows) {
        // Never delete a file Platen did not write — an external original is
        // the user's own, and forgetting it is the most we may do.
        await deleteAssetFiles(row.owner_id, row.id, row.storage_path, row.library_id !== null);
      }
      await sql`DELETE FROM assets WHERE id = ANY(${ids}::uuid[]) AND owner_id = ${userId}`;
    } else {
      await sql`
        UPDATE assets SET deleted_at = now()
        WHERE id = ANY(${ids}::uuid[]) AND owner_id = ${userId} AND deleted_at IS NULL
      `;
    }
    return reply.code(204).send();
  });

  app.post('/restore', async (request, reply) => {
    const { userId } = auth(request);
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) }).parse(request.body);
    await sql`
      UPDATE assets SET deleted_at = NULL
      WHERE id = ANY(${ids}::uuid[]) AND owner_id = ${userId}
    `;
    return reply.code(204).send();
  });

  /** Re-runs derivative generation, e.g. after a failed batch. */
  app.post('/:id/regenerate', async (request, reply) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await loadOwnedAsset(id, userId);
    await sql`UPDATE assets SET thumb_status = 'pending' WHERE id = ${id}`;
    await sql`DELETE FROM jobs WHERE dedupe_key IN (${`metadata:${id}`}, ${`thumbnail:${id}`})`;
    await enqueue('metadata', { assetId: id }, `metadata:${id}`);
    return reply.code(202).send({ queued: true });
  });
}
