import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Face, FaceStatus, Person } from '@platen/shared';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { assetColumnsWithExif, toAssetDto, type AssetRow } from '../lib/mappers.js';
import { thumbsPath } from '../lib/storage.js';
import { auth, requireAuth } from '../middleware/auth.js';
import { mergePeople } from '../services/clustering.js';
import { getFaceStatus } from '../services/faces.js';
import { enqueueMany } from '../jobs/queue.js';

interface PersonRow {
  id: string;
  name: string | null;
  cover_face_id: string | null;
  is_hidden: boolean;
  created_at: Date;
  face_count: number;
  asset_count: number;
}

const toPersonDto = (row: PersonRow): Person => ({
  id: row.id,
  name: row.name,
  coverFaceId: row.cover_face_id,
  faceCount: Number(row.face_count),
  assetCount: Number(row.asset_count),
  isHidden: row.is_hidden,
  createdAt: row.created_at.toISOString(),
});

async function loadOwnedPerson(personId: string, userId: string): Promise<PersonRow> {
  const rows = await sql<PersonRow[]>`
    SELECT p.id, p.name, p.cover_face_id, p.is_hidden, p.created_at,
           (SELECT COUNT(*)::int FROM faces f WHERE f.person_id = p.id) AS face_count,
           (SELECT COUNT(DISTINCT f.asset_id)::int FROM faces f WHERE f.person_id = p.id) AS asset_count
    FROM people p
    WHERE p.id = ${personId}
  `;
  const row = rows[0];
  if (!row) throw notFound('That person no longer exists.');

  const owned = await sql`SELECT 1 FROM people WHERE id = ${personId} AND owner_id = ${userId}`;
  if (owned.length === 0) throw forbidden('You do not have access to that person.');

  return row;
}

export async function peopleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Progress and model state, for the Settings panel. */
  app.get('/status', async (request) => {
    const { userId } = auth(request);
    const status = getFaceStatus();

    const [counts] = await sql<
      { total: number; scanned: number; people: number; faces: number }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE a.type = 'image')::int AS total,
        COUNT(*) FILTER (WHERE a.type = 'image' AND a.faces_scanned_at IS NOT NULL)::int AS scanned,
        (SELECT COUNT(*)::int FROM people WHERE owner_id = ${userId}) AS people,
        (SELECT COUNT(*)::int FROM faces f
           JOIN assets fa ON fa.id = f.asset_id
          WHERE fa.owner_id = ${userId}) AS faces
      FROM assets a
      WHERE a.owner_id = ${userId} AND a.deleted_at IS NULL
    `;

    return {
      enabled: config.ENABLE_FACES,
      state: status.state,
      message: status.message,
      total: counts?.total ?? 0,
      scanned: counts?.scanned ?? 0,
      pending: Math.max(0, (counts?.total ?? 0) - (counts?.scanned ?? 0)),
      people: counts?.people ?? 0,
      faces: counts?.faces ?? 0,
    } satisfies FaceStatus;
  });

  /**
   * People worth showing.
   *
   * Groups below the minimum size are withheld: clustering produces a long
   * tail of one-off faces — a stranger in the background of a single photo —
   * and showing every one of them buries the handful of people who matter.
   * A named person is always shown, however few faces it has.
   */
  app.get('/', async (request) => {
    const { userId } = auth(request);
    const { includeHidden } = z
      .object({ includeHidden: z.coerce.boolean().default(false) })
      .parse(request.query);

    const rows = await sql<PersonRow[]>`
      SELECT p.id, p.name, p.cover_face_id, p.is_hidden, p.created_at,
             COUNT(f.id)::int AS face_count,
             COUNT(DISTINCT f.asset_id)::int AS asset_count
      FROM people p
      LEFT JOIN faces f ON f.person_id = p.id
      WHERE p.owner_id = ${userId}
        ${includeHidden ? sql`` : sql`AND p.is_hidden = false`}
      GROUP BY p.id
      HAVING COUNT(f.id) >= ${config.FACE_MIN_CLUSTER_SIZE} OR p.name IS NOT NULL
      ORDER BY (p.name IS NULL), COUNT(f.id) DESC
    `;

    return rows.map(toPersonDto);
  });

  app.get('/:id', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return toPersonDto(await loadOwnedPerson(id, userId));
  });

  /** Every photo this person appears in. */
  app.get('/:id/assets', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await loadOwnedPerson(id, userId);

    const rows = await sql<AssetRow[]>`
      SELECT DISTINCT ${sql.unsafe(assetColumnsWithExif())}
      FROM faces f
      JOIN assets a ON a.id = f.asset_id
      LEFT JOIN asset_exif e ON e.asset_id = a.id
      WHERE f.person_id = ${id} AND a.deleted_at IS NULL AND a.owner_id = ${userId}
      ORDER BY a.taken_at DESC, a.id DESC
    `;
    return { items: rows.map(toAssetDto), nextCursor: null };
  });

  app.patch('/:id', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().max(120).nullable().optional(),
        isHidden: z.boolean().optional(),
        coverFaceId: z.string().uuid().optional(),
      })
      .parse(request.body);

    await loadOwnedPerson(id, userId);

    if (body.coverFaceId) {
      const valid = await sql`
        SELECT 1 FROM faces WHERE id = ${body.coverFaceId} AND person_id = ${id}
      `;
      if (valid.length === 0) throw badRequest('That face does not belong to this person.');
    }

    // An empty name means "forget the name", not a person literally called "".
    const name = body.name === undefined ? undefined : body.name?.trim() || null;

    await sql`
      UPDATE people SET
        name          = ${name === undefined ? sql`name` : name},
        is_hidden     = COALESCE(${body.isHidden ?? null}, is_hidden),
        cover_face_id = COALESCE(${body.coverFaceId ?? null}, cover_face_id)
      WHERE id = ${id}
    `;

    // Naming a person is a statement of fact about every face in the group, so
    // they stop being provisional and clustering will not reassign them.
    if (name) {
      await sql`UPDATE faces SET is_confirmed = true WHERE person_id = ${id}`;
    }

    return toPersonDto(await loadOwnedPerson(id, userId));
  });

  /** Folds other people into this one. */
  app.post('/:id/merge', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { personIds } = z
      .object({ personIds: z.array(z.string().uuid()).min(1).max(50) })
      .parse(request.body);

    if (personIds.includes(id)) throw badRequest('Cannot merge a person into themselves.');

    const moved = await mergePeople(userId, id, personIds);
    return { merged: personIds.length, facesMoved: moved };
  });

  /**
   * Detaches one face from its group.
   *
   * The face becomes its own person rather than disappearing — it is still a
   * real face, just not this one, and dropping it would mean re-detecting the
   * whole photo to get it back.
   */
  app.post('/faces/:faceId/detach', async (request) => {
    const { userId } = auth(request);
    const { faceId } = z.object({ faceId: z.string().uuid() }).parse(request.params);

    const rows = await sql<{ id: string; owner_id: string }[]>`
      SELECT f.id, a.owner_id FROM faces f
      JOIN assets a ON a.id = f.asset_id
      WHERE f.id = ${faceId}
    `;
    const face = rows[0];
    if (!face) throw notFound('That face no longer exists.');
    if (face.owner_id !== userId) throw forbidden('You do not have access to that face.');

    const [person] = await sql<{ id: string }[]>`
      INSERT INTO people (owner_id, cover_face_id) VALUES (${userId}, ${faceId}) RETURNING id
    `;
    await sql`
      UPDATE faces SET person_id = ${person!.id}, is_confirmed = true WHERE id = ${faceId}
    `;
    return { personId: person!.id };
  });

  /** Faces found in one photo, for the lightbox. */
  app.get('/faces/by-asset/:assetId', async (request) => {
    const { userId } = auth(request);
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);

    const rows = await sql<
      {
        id: string;
        asset_id: string;
        person_id: string | null;
        bbox_x: number;
        bbox_y: number;
        bbox_w: number;
        bbox_h: number;
        score: number;
        is_confirmed: boolean;
      }[]
    >`
      SELECT f.id, f.asset_id, f.person_id, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h,
             f.score, f.is_confirmed
      FROM faces f
      JOIN assets a ON a.id = f.asset_id
      WHERE f.asset_id = ${assetId} AND a.owner_id = ${userId}
      ORDER BY f.bbox_x
    `;

    return rows.map(
      (row): Face => ({
        id: row.id,
        assetId: row.asset_id,
        personId: row.person_id,
        x: row.bbox_x,
        y: row.bbox_y,
        width: row.bbox_w,
        height: row.bbox_h,
        score: row.score,
        isConfirmed: row.is_confirmed,
      }),
    );
  });

  /** The cropped face image used as an avatar. */
  app.get('/faces/:faceId/thumbnail', async (request, reply) => {
    const { userId } = auth(request);
    const { faceId } = z.object({ faceId: z.string().uuid() }).parse(request.params);

    const rows = await sql<{ thumb_path: string | null; owner_id: string }[]>`
      SELECT f.thumb_path, a.owner_id FROM faces f
      JOIN assets a ON a.id = f.asset_id
      WHERE f.id = ${faceId}
    `;
    const face = rows[0];
    if (!face?.thumb_path) throw notFound('No crop is available for that face.');
    if (face.owner_id !== userId) throw forbidden('You do not have access to that face.');

    const absolute = thumbsPath(face.thumb_path);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw notFound('That face crop is no longer on disk.');

    reply.header('Content-Type', 'image/webp');
    reply.header('Content-Length', info.size);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(createReadStream(absolute));
  });

  /** Queues a face scan across the library. */
  app.post('/rescan', async (request) => {
    const { userId } = auth(request);
    if (!config.ENABLE_FACES) {
      throw badRequest('Face grouping is disabled on this server (ENABLE_FACES=false).');
    }

    const { full } = z.object({ full: z.boolean().default(false) }).parse(request.body ?? {});

    // A full rescan re-examines everything; the default only picks up photos
    // that have never been looked at, which is what someone wants after
    // switching the feature on.
    const targets = await sql<{ id: string }[]>`
      SELECT id FROM assets
      WHERE owner_id = ${userId} AND deleted_at IS NULL AND type = 'image'
        ${full ? sql`` : sql`AND faces_scanned_at IS NULL`}
    `;

    const queued = await enqueueMany(
      'face-detect',
      targets.map((target) => target.id),
    );
    return { queued };
  });
}
