import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ShareLink } from '@aperture/shared';
import { sql } from '../db/index.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { assetColumnsWithExif, toAssetDto, type AssetRow } from '../lib/mappers.js';
import { libraryPath, thumbDir, thumbsPath } from '../lib/storage.js';
import { auth, requireAuth } from '../middleware/auth.js';
import { hashPassword, verifyPassword } from '../services/auth.js';

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
 * Resolves a public key to a live share.
 *
 * Password-protected links use a header rather than a cookie so the same
 * endpoint works from the web viewer and from a `curl` download without any
 * session machinery.
 */
async function resolveShare(key: string, password?: string): Promise<ShareRow> {
  const rows = await sql<ShareRow[]>`
    SELECT id, key, owner_id, album_id, asset_id, password_hash, allow_download,
           expires_at, view_count, created_at
    FROM share_links WHERE key = ${key}
  `;
  const row = rows[0];

  // Same message for "wrong key" and "expired" so a link cannot be probed.
  if (!row) throw notFound('This link is no longer available.');
  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    throw notFound('This link is no longer available.');
  }

  if (row.password_hash) {
    if (!password) throw unauthorized('This link is password protected.');
    if (!(await verifyPassword(row.password_hash, password))) {
      throw forbidden('That password is not correct.');
    }
  }

  return row;
}

/** Every asset reachable through a share, owner-scoped so a stale album
 *  membership can never leak someone else's photo. */
async function shareAssets(share: ShareRow): Promise<AssetRow[]> {
  if (share.asset_id) {
    return sql<AssetRow[]>`
      SELECT ${sql.unsafe(assetColumnsWithExif())}
      FROM assets a
      LEFT JOIN asset_exif e ON e.asset_id = a.id
      WHERE a.id = ${share.asset_id} AND a.deleted_at IS NULL
    `;
  }
  return sql<AssetRow[]>`
    SELECT ${sql.unsafe(assetColumnsWithExif())}
    FROM album_assets aa
    JOIN assets a ON a.id = aa.asset_id
    LEFT JOIN asset_exif e ON e.asset_id = a.id
    WHERE aa.album_id = ${share.album_id} AND a.deleted_at IS NULL
    ORDER BY a.taken_at DESC, a.id DESC
  `;
}

async function assertInShare(share: ShareRow, assetId: string): Promise<AssetRow> {
  const assets = await shareAssets(share);
  const match = assets.find((a) => a.id === assetId);
  if (!match) throw notFound('That photo is not part of this share.');
  return match;
}

async function streamPublic(
  reply: FastifyReply,
  absolutePath: string,
  contentType: string,
  rangeHeader?: string,
): Promise<FastifyReply> {
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    throw notFound('That file is not available yet.');
  }

  reply.header('Content-Type', contentType);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', 'public, max-age=3600');

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const start = Number(match[1] || 0);
      const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      if (!Number.isNaN(start) && !Number.isNaN(end) && start <= end && start < info.size) {
        reply.header('Content-Range', `bytes ${start}-${end}/${info.size}`);
        reply.header('Content-Length', end - start + 1);
        return reply.code(206).send(createReadStream(absolutePath, { start, end }));
      }
    }
  }

  reply.header('Content-Length', info.size);
  return reply.send(createReadStream(absolutePath));
}

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
    const rows = await sql<ShareRow[]>`
      SELECT id, key, owner_id, album_id, asset_id, password_hash, allow_download,
             expires_at, view_count, created_at
      FROM share_links WHERE key = ${key}
    `;
    const row = rows[0];
    if (!row || (row.expires_at && row.expires_at.getTime() < Date.now())) {
      throw notFound('This link is no longer available.');
    }

    let title = 'Shared photo';
    if (row.album_id) {
      const albums = await sql<{ name: string }[]>`SELECT name FROM albums WHERE id = ${row.album_id}`;
      title = albums[0]?.name ?? 'Shared album';
    }

    return {
      requiresPassword: row.password_hash !== null,
      allowDownload: row.allow_download,
      isAlbum: row.album_id !== null,
      title,
    };
  });

  app.get('/:key', async (request) => {
    const { key } = keyParam.parse(request.params);
    const share = await resolveShare(key, passwordHeader(request));

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
    };
  });

  app.get('/:key/asset/:assetId/thumbnail', async (request, reply) => {
    const { key, assetId } = assetParam.parse(request.params);
    const share = await resolveShare(key, passwordHeader(request));
    const asset = await assertInShare(share, assetId);
    return streamPublic(
      reply,
      join(thumbsPath(thumbDir(asset.owner_id, asset.id)), 'thumb.webp'),
      'image/webp',
    );
  });

  app.get('/:key/asset/:assetId/preview', async (request, reply) => {
    const { key, assetId } = assetParam.parse(request.params);
    const share = await resolveShare(key, passwordHeader(request));
    const asset = await assertInShare(share, assetId);
    return streamPublic(
      reply,
      join(thumbsPath(thumbDir(asset.owner_id, asset.id)), 'preview.webp'),
      'image/webp',
    );
  });

  app.get('/:key/asset/:assetId/original', async (request, reply) => {
    const { key, assetId } = assetParam.parse(request.params);
    const share = await resolveShare(key, passwordHeader(request));
    if (!share.allow_download) throw forbidden('Downloads are disabled for this link.');

    const asset = await assertInShare(share, assetId);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${asset.original_filename.replace(/["\\]/g, '')}"`,
    );
    return streamPublic(reply, libraryPath(asset.storage_path), asset.mime_type, request.headers.range);
  });
}
