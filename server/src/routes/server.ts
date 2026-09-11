import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { JobStats, JobType, ServerInfo, ServerStats } from '@aperture/shared';
import { API_VERSION } from '@aperture/shared';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { auth, requireAdmin, requireAuth } from '../middleware/auth.js';
import { hashPassword, revokeAllForUser, toUserDto, type UserRow } from '../services/auth.js';
import { enqueue, retryFailed, stats as jobStats } from '../jobs/queue.js';
import { getCacheStatus } from '../services/cache.js';
import { sidecarStatus } from '../services/sidecar.js';

const VERSION = '0.1.0';

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Unauthenticated. The mobile app hits this first to confirm a URL points at
   * an Aperture server before it shows a login form — much friendlier than
   * failing on the login request itself.
   */
  app.get('/info', async () => {
    const [row] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM users`;
    return {
      name: 'Aperture',
      version: VERSION,
      apiVersion: API_VERSION,
      needsOnboarding: (row?.count ?? 0) === 0,
      allowRegistration: config.ALLOW_REGISTRATION,
      features: { ml: config.ENABLE_ML, video: true, sharing: true },
    } satisfies ServerInfo;
  });

  /** Liveness probe for the Unraid/Docker health check. */
  app.get('/health', async (_request, reply) => {
    try {
      await sql`SELECT 1`;
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'degraded', reason: 'database unreachable' });
    }
  });

  app.get('/stats', { preHandler: requireAuth }, async (request) => {
    const { isAdmin, userId } = auth(request);

    // Non-admins see only their own library.
    const scope = isAdmin ? sql`TRUE` : sql`owner_id = ${userId}`;

    const [totals] = await sql<{ assets: number; photos: number; videos: number; usage: string }[]>`
      SELECT
        COUNT(*)::int AS assets,
        COUNT(*) FILTER (WHERE type = 'image')::int AS photos,
        COUNT(*) FILTER (WHERE type = 'video')::int AS videos,
        COALESCE(SUM(file_size), 0)::text AS usage
      FROM assets WHERE deleted_at IS NULL AND ${scope}
    `;

    const [users] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM users`;

    const raw = await jobStats();
    const sidecars = await sidecarStatus();
    const byType = new Map<string, JobStats>();
    for (const row of raw) {
      const entry = byType.get(row.type) ?? { type: row.type as JobType, pending: 0, active: 0, failed: 0 };
      if (row.status === 'pending') entry.pending = row.count;
      if (row.status === 'active') entry.active = row.count;
      if (row.status === 'failed') entry.failed = row.count;
      byType.set(row.type, entry);
    }

    return {
      cache: getCacheStatus(),
      users: users?.count ?? 0,
      assets: totals?.assets ?? 0,
      photos: totals?.photos ?? 0,
      videos: totals?.videos ?? 0,
      usageBytes: Number(totals?.usage ?? 0),
      jobs: [...byType.values()],
      sidecars,
    } satisfies ServerStats;
  });

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  app.get('/users', { preHandler: requireAdmin }, async () => {
    const rows = await sql<UserRow[]>`
      SELECT id, email, name, is_admin, quota_bytes, created_at FROM users ORDER BY created_at
    `;
    return Promise.all(rows.map(toUserDto));
  });

  /** Admin-created accounts: the invite path when self-registration is off. */
  app.post('/users', { preHandler: requireAdmin }, async (request, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        name: z.string().min(1).max(120),
        isAdmin: z.boolean().default(false),
        quotaBytes: z.number().int().positive().nullable().default(null),
      })
      .parse(request.body);

    const existing = await sql`SELECT 1 FROM users WHERE email = ${body.email}`;
    if (existing.length > 0) throw badRequest('An account with that email already exists.');

    const [row] = await sql<UserRow[]>`
      INSERT INTO users (email, password_hash, name, is_admin, quota_bytes)
      VALUES (${body.email}, ${await hashPassword(body.password)}, ${body.name}, ${body.isAdmin}, ${body.quotaBytes})
      RETURNING id, email, name, is_admin, quota_bytes, created_at
    `;
    return reply.code(201).send(await toUserDto(row!));
  });

  app.patch('/users/:id', { preHandler: requireAdmin }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        isAdmin: z.boolean().optional(),
        quotaBytes: z.number().int().positive().nullable().optional(),
        password: z.string().min(8).optional(),
      })
      .parse(request.body);

    const existing = await sql`SELECT 1 FROM users WHERE id = ${id}`;
    if (existing.length === 0) throw notFound('No such user.');

    // Refuse to remove the last admin, which would lock everyone out of the
    // admin pages with no recovery path short of editing the database.
    if (body.isAdmin === false) {
      const [admins] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM users WHERE is_admin = true AND id <> ${id}
      `;
      if ((admins?.count ?? 0) === 0) {
        throw badRequest('This is the only administrator account. Promote someone else first.');
      }
    }

    if (body.password) {
      await sql`UPDATE users SET password_hash = ${await hashPassword(body.password)} WHERE id = ${id}`;
      await revokeAllForUser(id);
    }

    const [row] = await sql<UserRow[]>`
      UPDATE users SET
        name        = COALESCE(${body.name ?? null}, name),
        is_admin    = COALESCE(${body.isAdmin ?? null}, is_admin),
        quota_bytes = ${body.quotaBytes === undefined ? sql`quota_bytes` : body.quotaBytes}
      WHERE id = ${id}
      RETURNING id, email, name, is_admin, quota_bytes, created_at
    `;
    return toUserDto(row!);
  });

  app.delete('/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    if (id === userId) throw badRequest('You cannot delete your own account.');

    const [admins] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM users WHERE is_admin = true AND id <> ${id}
    `;
    if ((admins?.count ?? 0) === 0) throw badRequest('You cannot delete the last administrator.');

    // ON DELETE CASCADE clears the rows; the files are swept by the purge job
    // because every asset row goes with the user.
    await sql`DELETE FROM users WHERE id = ${id}`;
    return reply.code(204).send();
  });

  /**
   * Force a sidecar reconciliation now rather than waiting for the daily one.
   *
   * The button exists because "my library describes itself" is a promise you
   * want to be able to check immediately after changing a lot of albums or
   * naming people, not one you take on trust until the next sweep.
   */
  app.post('/jobs/sidecars', { preHandler: requireAdmin }, async () => {
    await enqueue('sidecar-sweep', {}, 'sidecar-sweep:recurring');
    return { queued: true };
  });

  /** Re-queue work: failed thumbnails, or a full ML re-index. */
  app.post('/jobs/retry', { preHandler: requireAdmin }, async (request) => {
    const { type } = z
      .object({ type: z.string().optional() })
      .parse(request.body ?? {});
    const count = await retryFailed(type as JobType | undefined);
    return { requeued: count };
  });

  app.post('/jobs/reindex', { preHandler: requireAdmin }, async (request) => {
    const { what } = z
      .object({ what: z.enum(['thumbnails', 'metadata', 'embeddings']) })
      .parse(request.body);

    const targets = await sql<{ id: string }[]>`
      SELECT id FROM assets WHERE deleted_at IS NULL
    `;

    const jobType: JobType =
      what === 'embeddings' ? 'embedding' : what === 'metadata' ? 'metadata' : 'thumbnail';

    for (const target of targets) {
      await enqueue(jobType, { assetId: target.id }, `${jobType}:${target.id}`);
    }
    return { queued: targets.length, type: jobType };
  });
}
