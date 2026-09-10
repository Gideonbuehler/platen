import { z } from 'zod';

/**
 * Environment is parsed once, at boot, and fails loudly. A photo server that
 * starts with a bad LIBRARY_PATH and only notices on the first upload is a
 * server that loses photos.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32'),

  DATABASE_URL: z.string().min(1),

  LIBRARY_PATH: z.string().default('/data/library'),
  THUMBS_PATH: z.string().default('/data/thumbs'),
  UPLOAD_TMP_PATH: z.string().default('/data/tmp'),

  ALLOW_REGISTRATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(3),

  ENABLE_ML: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ML_MODEL: z.string().default('Xenova/clip-vit-base-patch32'),

  /**
   * Face detection and people grouping. Off by default: it is a further
   * ~190 MB of models and materially more CPU per photo than search alone,
   * and plenty of people want a backup target without any of it.
   */
  ENABLE_FACES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Detector confidence floor.
   *
   * 0.7 rather than the model's usual 0.5: on a real library the 0.5-0.7 band
   * is where texture that merely resembles a face lives — a motorcycle wheel
   * scored 0.61 during testing, while genuine faces sat above 0.9. In a photo
   * app a false person is much more irritating than a missed one, since it
   * shows up as a stranger you have to hunt down and hide.
   */
  FACE_MIN_SCORE: z.coerce.number().min(0.1).max(0.99).default(0.7),

  /**
   * Cosine similarity above which two faces are treated as the same person.
   * Higher is stricter: fewer wrong merges, more duplicate people.
   */
  FACE_MATCH_THRESHOLD: z.coerce.number().min(0.1).max(0.95).default(0.38),

  /** A person needs this many faces before appearing in the UI. */
  FACE_MIN_CLUSTER_SIZE: z.coerce.number().int().min(1).default(2),

  /** Faces smaller than this (pixels on the preview) are ignored as background. */
  FACE_MIN_SIZE_PX: z.coerce.number().int().min(10).default(40),

  /**
   * Root that every external library must sit under.
   *
   * External libraries are admin-configured absolute paths, so without a fixed
   * root a typo — or a malicious admin — could index /etc. Mount the shares you
   * want to expose beneath this single path and nothing else is reachable.
   */
  EXTERNAL_ROOT: z.string().default('/data/external'),

  /** How often an enabled external library is re-scanned, in minutes. */
  EXTERNAL_SCAN_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(360),

  /** Days a trashed asset survives before the purge job deletes the bytes. */
  TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),

  /** Hard ceiling on a single uploaded file. Default 8 GiB covers long 4K video. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024 * 1024),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nAperture cannot start — invalid configuration:\n${issues}\n`);
  process.exit(1);
}

export const config = parsed.data;

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_DAYS = 60;

/** Longest edge, in pixels, of each derivative we generate. */
export const THUMB_SIZE = 320;
export const PREVIEW_SIZE = 1600;
