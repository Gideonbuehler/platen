import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ShareLink } from '@platen/shared';
import { sql } from '../db/index.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { assetColumnsWithExif, toAssetDto, type AssetRow } from '../lib/mappers.js';
import { sendFile } from '../lib/send-file.js';
import { externalRootPath, libraryPath, originalPathFor, thumbDir, thumbsPath } from '../lib/storage.js';
import { auth, requireAuth } from '../middleware/auth.js';
import { hashPassword, signShareToken, verifyPassword, verifyShareToken } from '../services/auth.js';

interface ShareRow {
  id: string;
  key: string;
  owner_id: string;
  album_id: string | null;
  asset_id: string | null;
  password_hash: string | null;
  allow_download: boolean;
  expires_at: Date | null;
  view_count: number;
  created_at: Date;
}

const toShareDto = (row: ShareRow): ShareLink => ({
  id: row.id,
  key: row.key,
  albumId: row.album_id,
  assetId: row.asset_id,
  hasPassword: row.password_hash !== null,
  allowDownload: row.allow_download,
  expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  viewCount: row.view_count,
  createdAt: row.created_at.toISOString(),
});

/**
 * Resolves a public key to a live share, without checking any password.
 *
 * Same message for "wrong key" and "expired" so a link cannot be probed.
 */
async function findShare(key: string): Promise<ShareRow> {
  const rows = await sql<ShareRow[]>`
    SELECT id, key, owner_id, album_id, asset_id, password_hash, allow_download,
           expires_at, view_count, created_at
    FROM share_links WHERE key = ${key}
  `;
  const row = rows[0];

  if (!row) throw notFound('This link is no longer available.');
  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    throw notFound('This link is no longer available.');
  }
  return row;
}

/**
 * Checks the password a viewer typed.
 *
 * It travels in a header rather than a cookie so the same endpoint works from
 * the web viewer and from `curl` without any session machinery. This is the
 * only place a password is verified; media requests carry the share token the
 * answer hands back instead, so the costly hash runs once per visit rather
 * than once per thumbnail.
 */
async function checkPassword(share: ShareRow, password?: string): Promise<void> {
  if (!share.password_hash) return;
  if (!password) throw unauthorized('This link is password protected.');
  if (!(await verifyPassword(share.password_hash, password))) {
    throw forbidden('That password is not correct.');
  }
}

/** Media access: open links need nothing, protected ones a share token. */
async function checkShareToken(share: ShareRow, request: FastifyRequest): Promise<void> {
  if (!share.password_hash) return;
  const token = (request.query as Record<string, unknown> | undefined)?.st;
  if (typeof token !== 'string' || !(await verifyShareToken(token, share.id))) {
    throw unauthorized('This link is password protected.');
  }
}

/**
 * Every asset reachable through a share.
 *
 * Owner-scoped: a public link exposes only its creator's photos. Collaborators
 * can add their own photos to a shared album, but agreeing to share with the
 * album's members is not agreeing to publish to anyone holding a URL.
 */
async function shareAssets(share: ShareRow): Promise<AssetRow[]> {
  if (share.asset_id) {
    return sql<AssetRow[]>`
      SELECT ${sql.unsafe(assetColumnsWithExif())}, l.path AS library_root
      FROM assets a
      LEFT JOIN asset_exif e ON e.asset_id = a.id
      LEFT JOIN external_libraries l ON l.id = a.library_id
      WHERE a.id = ${share.asset_id} AND a.owner_id = ${share.owner_id} AND a.deleted_at IS NULL
    `;
  }
  return sql<AssetRow[]>`
    SELECT ${sql.unsafe(assetColumnsWithExif())}, l.path AS library_root
    FROM album_assets aa
    JOIN assets a ON a.id = aa.asset_id
    LEFT JOIN asset_exif e ON e.asset_id = a.id
    LEFT JOIN external_libraries l ON l.id = a.library_id
    WHERE aa.album_id = ${share.album_id} AND a.owner_id = ${share.owner_id} AND a.deleted_at IS NULL
    ORDER BY a.taken_at DESC, a.id DESC
  `;
}

/**
 * One asset, if the share reaches it.
 *
 * A single lookup rather than loading the whole album and searching it: a
 * grid of a few hundred thumbnails would otherwise load the album a few
 * hundred times.
 */
async function assetInShare(share: ShareRow, assetId: string): Promise<AssetRow> {
  const membership = share.asset_id
    ? sql`a.id = ${share.asset_id}`
    : sql`EXISTS (SELECT 1 FROM album_assets aa WHERE aa.album_id = ${share.album_id} AND aa.asset_id = a.id)`;

  const rows = await sql<AssetRow[]>`
    SELECT ${sql.unsafe(assetColumnsWithExif())}, l.path AS library_root
    FROM assets a
    LEFT JOIN asset_exif e ON e.asset_id = a.id
    LEFT JOIN external_libraries l ON l.id = a.library_id
    WHERE a.id = ${assetId}
      AND a.owner_id = ${share.owner_id}
      AND a.deleted_at IS NULL
      AND ${membership}
  `;
  const match = rows[0];
  if (!match) throw notFound('That photo is not part of this share.');
  return match;
}

/** A password-protected photo must never land in a shared proxy cache. */
const shareCacheControl = (share: ShareRow) =>
  share.password_hash ? 'private, max-age=3600' : 'public, max-age=3600';

const passwordHeader = (request: { headers: Record<string, unknown> }): string | undefined => {
  const value = request.headers['x-share-password'];
  return typeof value === 'string' ? value : undefined;
};

// ---------------------------------------------------------------------------
// Authenticated: manage your own links
// ---------------------------------------------------------------------------

export async function shareAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (request) => {
    const { userId } = auth(request);
    const rows = await sql<ShareRow[]>`
      SELECT id, key, owner_id, album_id, asset_id, password_hash, allow_download,
             expires_at, view_count, created_at
      FROM share_links WHERE owner_id = ${userId}
      ORDER BY created_at DESC
    `;
    return rows.map(toShareDto);
  });

  app.post('/', async (request, reply) => {
    const { userId } = auth(request);
    const body = z
      .object({
        albumId: z.string().uuid().optional(),
        assetId: z.string().uuid().optional(),
        password: z.string().min(4).max(200).optional(),
        allowDownload: z.boolean().default(true),
        expiresAt: z.string().datetime().nullable().optional(),
      })
      .parse(request.body);

    if (!body.albumId === !body.assetId) {
      throw badRequest('Share exactly one album or one photo.');
    }

    // Ownership check before minting a public URL.
    if (body.albumId) {
      const owned = await sql`SELECT 1 FROM albums WHERE id = ${body.albumId} AND owner_id = ${userId}`;
      if (owned.length === 0) throw forbidden('You can only share albums you own.');
    } else {
      const owned = await sql`SELECT 1 FROM assets WHERE id = ${body.assetId ?? null} AND owner_id = ${userId}`;
      if (owned.length === 0) throw forbidden('You can only share photos you own.');
    }

    // 16 random bytes: unguessable, and still a short-ish URL.
    const key = randomBytes(16).toString('base64url');

    const [row] = await sql<ShareRow[]>`
      INSERT INTO share_links (owner_id, key, album_id, asset_id, password_hash, allow_download, expires_at)
      VALUES (
        ${userId}, ${key}, ${body.albumId ?? null}, ${body.assetId ?? null},
        ${body.password ? await hashPassword(body.password) : null},
        ${body.allowDownload},
        ${body.expiresAt ? new Date(body.expiresAt) : null}
      )
      RETURNING id, key, owner_id, album_id, asset_id, password_hash, allow_download,
                expires_at, view_count, created_at
    `;
    if (!row) throw badRequest('Could not create the share link.');
    return reply.code(201).send(toShareDto(row));
  });

  app.delete('/:id', async (request, reply) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await sql`DELETE FROM share_links WHERE id = ${id} AND owner_id = ${userId}`;
    return reply.code(204).send();
  });
}

// ---------------------------------------------------------------------------
// Public: no authentication, key in the path
// ---------------------------------------------------------------------------

export async function publicShareRoutes(app: FastifyInstance): Promise<void> {
  const keyParam = z.object({ key: z.string().min(8).max(64) });
  const assetParam = keyParam.extend({ assetId: z.string().uuid() });

  /** Metadata only — lets the viewer render a password prompt before loading. */
  app.get('/:key/info', async (request) => {
    const { key } = keyParam.parse(request.params);
    const share = await findShare(key);

    let title = 'Shared photo';
    if (share.album_id) {
      const albums = await sql<{ name: string }[]>`SELECT name FROM albums WHERE id = ${share.album_id}`;
      title = albums[0]?.name ?? 'Shared album';
    }

    return {
      requiresPassword: share.password_hash !== null,
      allowDownload: share.allow_download,
      isAlbum: share.album_id !== null,
      title,
    };
  });

  /**
   * The share's contents, and for a protected link the token its media URLs
   * need. Password attempts are throttled per address: a four-character
   * password is otherwise a short afternoon's work for a script.
   */
  app.get(
    '/:key',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          // Only guesses count, so reloading an open link is never throttled.
          allowList: (request: FastifyRequest) => passwordHeader(request) === undefined,
        },
      },
    },
    async (request) => {
      const { key } = keyParam.parse(request.params);
      const share = await findShare(key);
      await checkPassword(share, passwordHeader(request));

      await sql`UPDATE share_links SET view_count = view_count + 1 WHERE id = ${share.id}`;

      const assets = await shareAssets(share);
      let title = 'Shared photo';
      if (share.album_id) {
        const albums = await sql<{ name: string }[]>`SELECT name FROM albums WHERE id = ${share.album_id}`;
        title = albums[0]?.name ?? 'Shared album';
      }

      return {
        title,
        allowDownload: share.allow_download,
        isAlbum: share.album_id !== null,
        assets: assets.map(toAssetDto),
        token: share.password_hash ? await signShareToken(share.id, share.expires_at) : null,
      };
    },
  );

  const derivative = (file: 'thumb.webp' | 'preview.webp') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { key, assetId } = assetParam.parse(request.params);
      const share = await findShare(key);
      await checkShareToken(share, request);
      const asset = await assetInShare(share, assetId);
      return sendFile(reply, join(thumbsPath(thumbDir(asset.owner_id, asset.id)), file), 'image/webp', {
        cacheControl: shareCacheControl(share),
      });
    };

  app.get('/:key/asset/:assetId/thumbnail', derivative('thumb.webp'));
  app.get('/:key/asset/:assetId/preview', derivative('preview.webp'));

  app.get('/:key/asset/:assetId/original', async (request, reply) => {
    const { key, assetId } = assetParam.parse(request.params);
    const share = await findShare(key);
    await checkShareToken(share, request);
    if (!share.allow_download) throw forbidden('Downloads are disabled for this link.');

    const asset = await assetInShare(share, assetId);
    const absolute = asset.library_root
      ? originalPathFor(asset.storage_path, externalRootPath(asset.library_root))
      : libraryPath(asset.storage_path);
    return sendFile(reply, absolute, asset.mime_type, {
      rangeHeader: request.headers.range,
      downloadName: asset.original_filename,
      cacheControl: shareCacheControl(share),
    });
  });
}
