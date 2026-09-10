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
