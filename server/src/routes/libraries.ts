import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ExternalLibrary } from '@aperture/shared';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { externalRootPath } from '../lib/storage.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { enqueue } from '../jobs/queue.js';

interface LibraryRow {
  id: string;
  name: string;
  path: string;
  exclusions: string[];
  is_enabled: boolean;
  last_scan_at: Date | null;
  last_scan_error: string | null;
  created_at: Date;
  asset_count: number;
  missing_count: number;
}

const toDto = (row: LibraryRow): ExternalLibrary => ({
  id: row.id,
  name: row.name,
  path: row.path,
  exclusions: row.exclusions,
  isEnabled: row.is_enabled,
  assetCount: Number(row.asset_count),
  missingCount: Number(row.missing_count),
  lastScanAt: row.last_scan_at ? row.last_scan_at.toISOString() : null,
  lastScanError: row.last_scan_error,
  createdAt: row.created_at.toISOString(),
});

/**
 * Rejects a path that escapes EXTERNAL_ROOT.
 *
 * `externalRootPath` already throws on traversal, but catching it here turns a
 * 500 into an explanation of what the person actually did wrong.
 */
function validatePath(input: string): string {
  const cleaned = input.trim().replace(/^\/+|\/+$/g, '');
  if (cleaned.length === 0) {
    throw badRequest('Enter a folder inside the mounted external directory.');
  }
  try {
    externalRootPath(cleaned);
  } catch {
    throw badRequest(
      `Libraries must live inside ${config.EXTERNAL_ROOT}. Mount the share you want to index there.`,
    );
  }
  return cleaned;
}

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  // Indexing arbitrary server paths is an administrative act, not a per-user
  // one — an ordinary account must not be able to point the scanner anywhere.
  app.addHook('preHandler', requireAdmin);

  app.get('/', async (request) => {
    const { userId } = auth(request);
    const rows = await sql<LibraryRow[]>`
      SELECT l.id, l.name, l.path, l.exclusions, l.is_enabled, l.last_scan_at,
             l.last_scan_error, l.created_at,
             (SELECT COUNT(*)::int FROM assets a
               WHERE a.library_id = l.id AND a.deleted_at IS NULL) AS asset_count,
             (SELECT COUNT(*)::int FROM assets a
               WHERE a.library_id = l.id AND a.missing_since IS NOT NULL) AS missing_count
      FROM external_libraries l
      WHERE l.owner_id = ${userId}
      ORDER BY l.created_at
    `;
    return rows.map(toDto);
  });

  /**
   * Lists folders under EXTERNAL_ROOT so a path can be picked rather than
   * typed. Typing a container-internal path from memory is the single most
   * error-prone step in setting this up.
   */
  app.get('/browse', async (request) => {
    const { path } = z.object({ path: z.string().default('') }).parse(request.query);

    const relative = path.trim().replace(/^\/+|\/+$/g, '');
    let absolute: string;
    try {
      absolute = relative ? externalRootPath(relative) : config.EXTERNAL_ROOT;
    } catch {
      throw badRequest('That path is outside the mounted external directory.');
    }

    const info = await stat(absolute).catch(() => null);
    if (!info?.isDirectory()) {
      return {
        root: config.EXTERNAL_ROOT,
        path: relative,
        exists: false,
        directories: [] as string[],
      };
    }

    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => (relative ? `${relative}/${entry.name}` : entry.name))
      .sort();

    return { root: config.EXTERNAL_ROOT, path: relative, exists: true, directories };
  });

  app.post('/', async (request, reply) => {
    const { userId } = auth(request);
    const body = z
      .object({
        name: z.string().min(1).max(120),
        path: z.string().min(1).max(1000),
        exclusions: z.array(z.string().max(200)).max(50).optional(),
      })
      .parse(request.body);

    const path = validatePath(body.path);

    const absolute = externalRootPath(path);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isDirectory()) {
      throw badRequest(
        `${config.EXTERNAL_ROOT}/${path} is not a readable folder inside the container. ` +
          'Check the volume mapping.',
      );
    }

    const existing = await sql`
      SELECT 1 FROM external_libraries WHERE owner_id = ${userId} AND path = ${path}
    `;
    if (existing.length > 0) throw conflict('That folder is already indexed.');

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO external_libraries (owner_id, name, path, exclusions)
      VALUES (
        ${userId}, ${body.name}, ${path},
        ${body.exclusions ?? sql`DEFAULT`}
      )
      RETURNING id
    `;
    if (!row) throw badRequest('Could not create the library.');

    // Scan straight away: a library that sits empty until some timer fires
    // looks broken.
    await enqueue('library-scan', { libraryId: row.id }, `library-scan:${row.id}`);

    return reply.code(201).send({ id: row.id, queued: true });
  });

  app.patch('/:id', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        isEnabled: z.boolean().optional(),
        exclusions: z.array(z.string().max(200)).max(50).optional(),
      })
      .parse(request.body);

    const owned = await sql`
      SELECT 1 FROM external_libraries WHERE id = ${id} AND owner_id = ${userId}
    `;
    if (owned.length === 0) throw notFound('No such library.');

    await sql`
      UPDATE external_libraries SET
        name       = COALESCE(${body.name ?? null}, name),
        is_enabled = COALESCE(${body.isEnabled ?? null}, is_enabled),
        exclusions = COALESCE(${body.exclusions ?? null}, exclusions)
      WHERE id = ${id}
    `;
    return { updated: true };
  });

  app.post('/:id/scan', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const owned = await sql`
      SELECT 1 FROM external_libraries WHERE id = ${id} AND owner_id = ${userId}
    `;
    if (owned.length === 0) throw notFound('No such library.');

    await enqueue('library-scan', { libraryId: id }, `library-scan:${id}`);
    return { queued: true };
  });

  /**
   * Removes the library and everything Aperture recorded about it.
   *
   * The photographs themselves are untouched — this un-indexes, it does not
   * delete. Said plainly in the response because that is the one thing anyone
   * removing a library actually wants to know.
   */
  app.delete('/:id', async (request) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM assets WHERE library_id = ${id}
    `;

    const deleted = await sql`
      DELETE FROM external_libraries WHERE id = ${id} AND owner_id = ${userId} RETURNING id
    `;
    if (deleted.length === 0) throw notFound('No such library.');

    return {
      removed: rows[0]?.count ?? 0,
      message: 'The folder and its photos were left exactly as they are on disk.',
    };
  });
}
