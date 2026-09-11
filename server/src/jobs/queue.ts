import type { JobType } from '@platen/shared';
import { sql } from '../db/index.js';

export interface JobRow {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/**
 * Enqueue a unit of background work.
 *
 * `dedupeKey` makes enqueueing idempotent: re-uploading the same asset, or
 * restarting mid-import, will not pile up duplicate thumbnail jobs. We clear
 * the key when a job completes so the same work can legitimately be requested
 * again later (e.g. "regenerate all thumbnails" from the admin page).
 */
export async function enqueue(
  type: JobType,
  payload: Record<string, unknown> = {},
  dedupeKey?: string,
  runAt?: Date,
): Promise<void> {
  await sql`
    INSERT INTO jobs (type, payload, dedupe_key, run_at)
    VALUES (
      ${type},
      ${sql.json(payload as Record<string, never>)},
      ${dedupeKey ?? null},
      ${runAt ?? new Date()}
    )
    ON CONFLICT (dedupe_key) DO NOTHING
  `;
}

/**
 * Atomically claims up to `limit` runnable jobs.
 *
 * SKIP LOCKED is the whole trick: several workers (or several container
 * replicas) can poll the same table concurrently and never hand the same row
 * to two of them, without any external broker.
 */
export async function claim(limit: number, workerId: string): Promise<JobRow[]> {
  return sql<JobRow[]>`
    UPDATE jobs SET
      status = 'active',
      locked_at = now(),
      locked_by = ${workerId},
      attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_at <= now()
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id, type, payload, attempts, max_attempts
  `;
}

export async function complete(id: string): Promise<void> {
  // Deleting rather than marking done keeps the table small; the dedupe_key
  // unique index is freed at the same time.
  await sql`DELETE FROM jobs WHERE id = ${id}`;
}

/**
 * Records a failure. Retries use exponential backoff (30s, 2m, 8m) and the job
 * lands in `failed` once it is out of attempts, where the admin UI can see it.
 */
export async function fail(job: JobRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.max_attempts;

  if (exhausted) {
    await sql`
      UPDATE jobs SET status = 'failed', last_error = ${message}, locked_at = NULL, locked_by = NULL
      WHERE id = ${job.id}
    `;
    return;
  }

  const backoffSeconds = 30 * Math.pow(4, job.attempts - 1);
  await sql`
    UPDATE jobs SET
      status = 'pending',
      last_error = ${message},
      locked_at = NULL,
      locked_by = NULL,
      run_at = now() + ${`${backoffSeconds} seconds`}::interval
    WHERE id = ${job.id}
  `;
}

/**
 * Returns jobs orphaned by a crashed worker to the pending pool. Called
 * periodically; the 15-minute threshold is comfortably longer than the slowest
 * legitimate job (a 4K video poster frame).
 */
export async function requeueStale(): Promise<number> {
  const rows = await sql`
    UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL
    WHERE status = 'active' AND locked_at < now() - interval '15 minutes'
    RETURNING id
  `;
  return rows.length;
}

export async function stats(): Promise<{ type: string; status: string; count: number }[]> {
  return sql<{ type: string; status: string; count: number }[]>`
    SELECT type, status::text AS status, COUNT(*)::int AS count
    FROM jobs GROUP BY type, status
  `;
}

/** Clears failed jobs of a type so the admin can retry them. */
export async function retryFailed(type?: JobType): Promise<number> {
  const rows = type
    ? await sql`UPDATE jobs SET status='pending', attempts=0, run_at=now() WHERE status='failed' AND type=${type} RETURNING id`
    : await sql`UPDATE jobs SET status='pending', attempts=0, run_at=now() WHERE status='failed' RETURNING id`;
  return rows.length;
}
