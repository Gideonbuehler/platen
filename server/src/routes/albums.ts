import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Album } from '@platen/shared';
import { sql } from '../db/index.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { assetColumnsWithExif, toAssetDto, type AssetRow } from '../lib/mappers.js';
import { auth, requireAuth } from '../middleware/auth.js';

interface AlbumRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  cover_asset_id: string | null;
  asset_count: number;
  created_at: Date;
  updated_at: Date;
  shared_with: { id: string; name: string; email: string }[] | null;
}

const toAlbumDto = (row: AlbumRow): Album => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  description: row.description,
  coverAssetId: row.cover_asset_id,
  assetCount: Number(row.asset_count),
  sharedWith: row.shared_with ?? [],
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/**
 * Albums a user can see: their own, plus any shared with them. `canEdit`
 * distinguishes "can add photos" from "can rename or delete".
 */
async function loadAccessibleAlbum(
  albumId: string,
  userId: string,
  need: 'read' | 'edit' | 'own',
): Promise<AlbumRow> {
  const rows = await sql<(AlbumRow & { can_edit: boolean | null })[]>`
    SELECT
      al.id, al.owner_id, al.name, al.description, al.cover_asset_id,
      al.created_at, al.updated_at,
      (SELECT COUNT(*)::int FROM album_assets WHERE album_id = al.id) AS asset_count,
      (SELECT COALESCE(json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email)), '[]'::json)
         FROM album_users au JOIN users u ON u.id = au.user_id
        WHERE au.album_id = al.id) AS shared_with,
      (SELECT au.can_edit FROM album_users au WHERE au.album_id = al.id AND au.user_id = ${userId}) AS can_edit
    FROM albums al
    WHERE al.id = ${albumId}
  `;

  const row = rows[0];
  if (!row) throw notFound('That album no longer exists.');

  const isOwner = row.owner_id === userId;
  const isShared = row.can_edit !== null;

  if (need === 'own' && !isOwner) throw forbidden('Only the album owner can do that.');
  if (need === 'edit' && !isOwner && row.can_edit !== true) {
    throw forbidden('You have read-only access to this album.');
  }
  if (need === 'read' && !isOwner && !isShared) {
    throw forbidden('You do not have access to that album.');
  }

  return row;
}

export async function albumRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (request) => {
    const { userId } = auth(request);
    const rows = await sql<AlbumRow[]>`
      SELECT
        al.id, al.owner_id, al.name, al.description, al.cover_asset_id,
        al.created_at, al.updated_at,
        (SELECT COUNT(*)::int FROM album_assets WHERE album_id = al.id) AS asset_count,
        (SELECT COALESCE(json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email)), '[]'::json)
           FROM album_users au JOIN users u ON u.id = au.user_id
          WHERE au.album_id = al.id) AS shared_with
      FROM albums al
      WHERE al.owner_id = ${userId}
         OR EXISTS (SELECT 1 FROM album_users au WHERE au.album_id = al.id AND au.user_id = ${userId})
      ORDER BY al.updated_at DESC
    `;
    return rows.map(toAlbumDto);
  });

  app.post('/', async (request, reply) => {
    const { userId } = auth(request);
    const body = z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        assetIds: z.array(z.string().uuid()).max(5000).optional(),
      })
      .parse(request.body);

    const albumId = await sql.begin(async (tx) => {
      const [album] = await tx<{ id: string }[]>`
        INSERT INTO albums (owner_id, name, description)
        VALUES (${userId}, ${body.name}, ${body.description ?? null})
        RETURNING id
      `;
      if (!album) throw badRequest('Could not create the album.');

      if (body.assetIds?.length) {
        // The owner filter here is what stops someone slipping another user's
        // asset id into the array.
        await tx`
          INSERT INTO album_assets (album_id, asset_id, added_by)
          SELECT ${album.id}, a.id, ${userId} FROM assets a
          WHERE a.id = ANY(${body.assetIds}::uuid[]) AND a.owner_id = ${userId}
          ON CONFLICT DO NOTHING
        `;
        await tx`
          UPDATE albums SET cover_asset_id = (
            SELECT asset_id FROM album_assets WHERE album_id = ${album.id} LIMIT 1
          ) WHERE id = ${album.id}
        `;
      }
      return album.id;
    });

    return reply.code(201).send(toAlbumDto(await loadAccessibleAlbum(albumId, userId, 'read')));
  });

  app.get('/:id', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return toAlbumDto(await loadAccessibleAlbum(id, userId, 'read'));
  });

  app.get('/:id/assets', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await loadAccessibleAlbum(id, userId, 'read');

    const rows = await sql<AssetRow[]>`
      SELECT ${sql.unsafe(assetColumnsWithExif())}
      FROM album_assets aa
      JOIN assets a ON a.id = aa.asset_id
      LEFT JOIN asset_exif e ON e.asset_id = a.id
      WHERE aa.album_id = ${id} AND a.deleted_at IS NULL
      ORDER BY a.taken_at DESC, a.id DESC
    `;
    return { items: rows.map(toAssetDto), nextCursor: null };
  });

  app.patch('/:id', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        coverAssetId: z.string().uuid().nullable().optional(),
      })
      .parse(request.body);

    await loadAccessibleAlbum(id, userId, 'own');

    await sql`
      UPDATE albums SET
        name           = COALESCE(${body.name ?? null}, name),
        description    = ${body.description === undefined ? sql`description` : body.description},
        cover_asset_id = ${body.coverAssetId === undefined ? sql`cover_asset_id` : body.coverAssetId}
      WHERE id = ${id}
    `;
    return toAlbumDto(await loadAccessibleAlbum(id, userId, 'read'));
  });

  app.delete('/:id', async (request, reply) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await loadAccessibleAlbum(id, userId, 'own');
    // Deleting an album never deletes the photos in it.
    await sql`DELETE FROM albums WHERE id = ${id}`;
    return reply.code(204).send();
  });

  app.post('/:id/assets', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { assetIds } = z
      .object({ assetIds: z.array(z.string().uuid()).min(1).max(5000) })
      .parse(request.body);

    await loadAccessibleAlbum(id, userId, 'edit');

    const added = await sql`
      INSERT INTO album_assets (album_id, asset_id, added_by)
      SELECT ${id}, a.id, ${userId} FROM assets a
      WHERE a.id = ANY(${assetIds}::uuid[]) AND a.owner_id = ${userId} AND a.deleted_at IS NULL
      ON CONFLICT DO NOTHING
      RETURNING asset_id
    `;

    await sql`
      UPDATE albums SET cover_asset_id = COALESCE(cover_asset_id, (
        SELECT asset_id FROM album_assets WHERE album_id = ${id} LIMIT 1
      )), updated_at = now() WHERE id = ${id}
    `;

    return { added: added.length };
  });

  app.delete('/:id/assets', async (request, reply) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { assetIds } = z
      .object({ assetIds: z.array(z.string().uuid()).min(1).max(5000) })
      .parse(request.body);

    await loadAccessibleAlbum(id, userId, 'edit');
    await sql`
      DELETE FROM album_assets WHERE album_id = ${id} AND asset_id = ANY(${assetIds}::uuid[])
    `;
    return reply.code(204).send();
  });

  /** In-app sharing with another account on this server. */
  app.post('/:id/share', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ email: z.string().email(), canEdit: z.boolean().default(false) })
      .parse(request.body);

    await loadAccessibleAlbum(id, userId, 'own');

    const targets = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${body.email}`;
    const target = targets[0];
    if (!target) throw notFound('No account on this server uses that email address.');
    if (target.id === userId) throw badRequest('You already own this album.');

    await sql`
      INSERT INTO album_users (album_id, user_id, can_edit)
      VALUES (${id}, ${target.id}, ${body.canEdit})
      ON CONFLICT (album_id, user_id) DO UPDATE SET can_edit = EXCLUDED.can_edit
    `;
    return toAlbumDto(await loadAccessibleAlbum(id, userId, 'read'));
  });

  app.delete('/:id/share/:userId', async (request, reply) => {
    const { userId } = auth(request);
    const params = z
      .object({ id: z.string().uuid(), userId: z.string().uuid() })
      .parse(request.params);

    await loadAccessibleAlbum(params.id, userId, 'own');
    await sql`DELETE FROM album_users WHERE album_id = ${params.id} AND user_id = ${params.userId}`;
    return reply.code(204).send();
  });
}
