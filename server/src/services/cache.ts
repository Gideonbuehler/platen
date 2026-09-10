import type { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * Optional Redis cache for derivative images.
 *
 * Two rules shape everything here:
 *
 *  1. Only regenerable data goes in. Thumbnails can be rebuilt from the
 *     original at any time, so an eviction, a flush or a lost container costs
 *     a little CPU and nothing else. Originals and database rows never touch
 *     Redis — it is memory, not storage.
 *
 *  2. It must never be able to break the app. Every operation is wrapped so a
 *     Redis that is down, full, or misconfigured degrades to reading from disk
 *     rather than failing a request. A cache that can take the server down with
 *     it is worse than no cache.
 */

let client: Redis | null = null;
let connecting: Promise<void> | null = null;
let healthy = false;
let lastError = '';

// Counted in-process rather than read from Redis, because what matters is how
// often *this* server avoided a disk read.
const stats = { hits: 0, misses: 0, errors: 0, skipped: 0 };

export function isCacheConfigured(): boolean {
  return config.REDIS_URL.length > 0;
}

export function getCacheStatus(): {
  configured: boolean;
  healthy: boolean;
  lastError: string;
  hits: number;
  misses: number;
  errors: number;
  hitRate: number;
} {
  const total = stats.hits + stats.misses;
  return {
    configured: isCacheConfigured(),
    healthy,
    lastError,
    hits: stats.hits,
    misses: stats.misses,
    errors: stats.errors,
    hitRate: total === 0 ? 0 : stats.hits / total,
  };
}

async function connect(): Promise<void> {
  if (!isCacheConfigured() || client) return;
  if (connecting) return connecting;

  connecting = (async () => {
    // ioredis ships as CJS with the class on `default`, but the interop shape
    // differs between bundlers and Node's own loader, so both are handled.
    const imported = (await import('ioredis')) as unknown as {
      default?: new (url: string, options: Record<string, unknown>) => Redis;
      Redis?: new (url: string, options: Record<string, unknown>) => Redis;
    };
    const RedisCtor = imported.default ?? imported.Redis;
    if (!RedisCtor) throw new Error('Could not load the ioredis client');

    const instance = new RedisCtor(config.REDIS_URL, {
      // Fail fast and fall through to disk rather than queueing requests
      // behind a Redis that is not answering.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3000,
      lazyConnect: true,
      retryStrategy: (attempt: number) => Math.min(attempt * 500, 10_000),
    });

    instance.on('error', (err: Error) => {
      // ioredis emits on every failed reconnect; recording without logging
      // each one keeps a downed Redis from flooding the container logs.
      healthy = false;
      lastError = err.message;
    });
    instance.on('ready', () => {
      healthy = true;
      lastError = '';
    });

    await instance.connect();
    client = instance;
  })()
    .catch((err) => {
      healthy = false;
      lastError = err instanceof Error ? err.message : String(err);
      client = null;
    })
    .finally(() => {
      connecting = null;
    });

  return connecting;
}

export async function initCache(log: (msg: string) => void): Promise<void> {
  if (!isCacheConfigured()) {
    log('Redis cache not configured; thumbnails are served from disk.');
    return;
  }

  await connect();
  log(
    healthy
      ? `Redis cache connected — thumbnails will be served from memory.`
      : `Redis cache unreachable (${lastError}). Falling back to disk; it will keep retrying.`,
  );
}

/** Cached bytes, or null for a miss. Never throws. */
export async function getCached(key: string): Promise<Buffer | null> {
  if (!isCacheConfigured()) return null;
  if (!client) await connect();
  if (!client || !healthy) {
    stats.misses++;
    return null;
  }

  try {
    // getBuffer, not get: `get` decodes to a UTF-8 string and silently mangles
    // binary image data.
    const value = await client.getBuffer(key);
    if (value) {
      stats.hits++;
      return value;
    }
    stats.misses++;
    return null;
  } catch (err) {
    stats.errors++;
    lastError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/** Stores bytes under a TTL. Silently does nothing if Redis is unavailable. */
export async function setCached(key: string, value: Buffer): Promise<void> {
  if (!isCacheConfigured() || !client || !healthy) return;

  if (value.byteLength > config.REDIS_MAX_VALUE_BYTES) {
    stats.skipped++;
    return;
  }

  try {
    await client.setex(key, config.REDIS_TTL_SECONDS, value);
  } catch (err) {
    stats.errors++;
    lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Drops keys for one asset, used when its derivatives are regenerated. */
export async function invalidateAsset(assetId: string): Promise<void> {
  if (!isCacheConfigured() || !client || !healthy) return;
  try {
    await client.del(thumbKey(assetId), previewKey(assetId));
  } catch {
    // A stale entry expires on its own; failing here must not fail the job.
  }
}

export const thumbKey = (assetId: string) => `aperture:thumb:${assetId}`;
export const previewKey = (assetId: string) => `aperture:preview:${assetId}`;

export async function closeCache(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
  client = null;
  healthy = false;
}
