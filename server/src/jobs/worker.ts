import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { runJob } from './handlers.js';
import { claim, complete, enqueue, fail, requeueStale } from './queue.js';
import { scheduleDueScans } from '../services/scanner.js';

const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

const IDLE_POLL_MS = 2000;
const BUSY_POLL_MS = 50;
const STALE_SWEEP_MS = 5 * 60 * 1000;
// Hourly is plenty: the purge only acts on assets already past the retention
// window, so the exact moment it runs never matters.
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
// How often we look for libraries due a rescan; the per-library interval is
// what actually governs frequency.
const SCAN_CHECK_MS = 10 * 60 * 1000;

/**
 * A single in-process worker loop.
 *
 * It runs `JOB_CONCURRENCY` jobs at a time. Polling (rather than LISTEN/NOTIFY)
 * is a conscious simplification: the queue is bursty but never latency-critical,
 * and a 2-second idle poll on an otherwise idle Postgres is free.
 */
export function startWorker(log: FastifyBaseLogger): () => Promise<void> {
  let running = true;
  let inFlight = 0;
  let loopDone: Promise<void>;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function processOne(job: Awaited<ReturnType<typeof claim>>[number]): Promise<void> {
    const started = Date.now();
    try {
      await runJob(job.type, job.payload);
      await complete(job.id);
      log.debug({ job: job.type, id: job.id, ms: Date.now() - started }, 'job completed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = job.attempts >= job.max_attempts;
      log[exhausted ? 'error' : 'warn'](
        { job: job.type, id: job.id, attempt: job.attempts, err: message },
        exhausted ? 'job failed permanently' : 'job failed, will retry',
      );
      await fail(job, err).catch((e) => log.error({ err: e }, 'could not record job failure'));
    } finally {
      inFlight--;
    }
  }

  async function loop(): Promise<void> {
    while (running) {
      const capacity = config.JOB_CONCURRENCY - inFlight;
      if (capacity <= 0) {
        await sleep(BUSY_POLL_MS);
        continue;
      }

      let jobs: Awaited<ReturnType<typeof claim>>;
      try {
        jobs = await claim(capacity, WORKER_ID);
      } catch (err) {
        log.error({ err }, 'could not claim jobs; retrying shortly');
        await sleep(IDLE_POLL_MS);
        continue;
      }

      if (jobs.length === 0) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      for (const job of jobs) {
        inFlight++;
        // Deliberately not awaited: that is what gives us concurrency.
        void processOne(job);
      }
      await sleep(BUSY_POLL_MS);
    }

    // Let in-flight work finish so we do not orphan half-written thumbnails.
    while (inFlight > 0) await sleep(100);
  }

  const staleSweep = setInterval(() => {
    requeueStale()
      .then((n) => {
        if (n > 0) log.warn(`Requeued ${n} job(s) orphaned by a previous worker.`);
      })
      .catch((err) => log.error({ err }, 'stale job sweep failed'));
  }, STALE_SWEEP_MS);

  /**
   * Recurring maintenance.
   *
   * The dedupe key is what keeps this bounded: at most one trash-purge is ever
   * outstanding, no matter how often this fires or how many times the server
   * restarts. The handler does not re-arm itself precisely so that this stays
   * the single scheduling point.
   */
  const armPurge = () =>
    void enqueue('trash-purge', {}, 'trash-purge:recurring').catch((err) =>
      log.error({ err }, 'could not schedule trash purge'),
    );

  armPurge();
  const purgeSchedule = setInterval(armPurge, PURGE_INTERVAL_MS);

  // External libraries are re-scanned on their own cadence. Dedupe keys mean a
  // library already queued or mid-scan is never queued twice.
  const armScans = () =>
    void scheduleDueScans().catch((err) =>
      log.error({ err }, 'could not schedule external library scans'),
    );

  armScans();
  const scanSchedule = setInterval(armScans, SCAN_CHECK_MS);

  log.info(`Job worker ${WORKER_ID} started (concurrency ${config.JOB_CONCURRENCY}).`);
  loopDone = loop();

  return async () => {
    running = false;
    clearInterval(staleSweep);
    clearInterval(purgeSchedule);
    clearInterval(scanSchedule);
    await loopDone;
    log.info('Job worker stopped.');
  };
}
