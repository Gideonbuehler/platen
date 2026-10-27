/**
 * Integration test harness.
 *
 * Runs the real app against a real Postgres, because the bugs worth catching
 * here live in the SQL and the route wiring, not in anything a mock would
 * exercise. Point TEST_DATABASE_URL at a disposable database: every test file
 * drops and rebuilds its schema.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AuthResponse } from '@platen/shared';

export interface Harness {
  app: FastifyInstance;
  sql: typeof import('../src/db/index.js').sql;
  dataRoot: string;
  libraryPath: string;
  thumbsPath: string;
  close: () => Promise<void>;
}

export async function setup(): Promise<Harness> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Point it at a disposable Postgres database with pgvector; ' +
        'the integration tests drop and recreate its schema.',
    );
  }

  const dataRoot = await mkdtemp(join(tmpdir(), 'platen-test-'));
  const libraryPath = join(dataRoot, 'library');
  const thumbsPath = join(dataRoot, 'thumbs');

  // Config is parsed when first imported, so the environment has to be in
  // place before anything from src/ is loaded.
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: url,
    JWT_SECRET: 'integration-test-secret-integration-test-secret',
    LIBRARY_PATH: libraryPath,
    THUMBS_PATH: thumbsPath,
    UPLOAD_TMP_PATH: join(dataRoot, 'tmp'),
    EXTERNAL_ROOT: join(dataRoot, 'external'),
    ENABLE_ML: 'false',
    ENABLE_FACES: 'false',
    REDIS_URL: '',
  });

  const { sql } = await import('../src/db/index.js');
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  const { migrate } = await import('../src/db/migrate.js');
  const { ensureStorageDirs } = await import('../src/lib/storage.js');
  const { buildApp } = await import('../src/app.js');

  const log = console.log;
  console.log = () => {};
  try {
    await migrate();
  } finally {
    console.log = log;
  }
  await ensureStorageDirs();

  const app = await buildApp({ logger: false });
  await app.ready();

  return {
    app,
    sql,
    dataRoot,
    libraryPath,
    thumbsPath,
    close: async () => {
      await app.close();
      await sql.end({ timeout: 5 });
      await rm(dataRoot, { recursive: true, force: true });
    },
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The first account becomes the admin; later ones need an admin to create them. */
export async function registerFirstUser(app: FastifyInstance, email = 'admin@example.com'): Promise<AuthResponse> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'correct-horse', name: 'Admin' },
  });
  if (response.statusCode !== 201) throw new Error(`register failed: ${response.body}`);
  return response.json();
}

export async function createUser(
  app: FastifyInstance,
  adminToken: string,
  email: string,
): Promise<AuthResponse> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/server/users',
    headers: bearer(adminToken),
    payload: { email, password: 'correct-horse', name: email.split('@')[0] },
  });
  if (created.statusCode >= 300) throw new Error(`create user failed: ${created.body}`);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'correct-horse' },
  });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
  return login.json();
}

/** A multipart body by hand: inject has no form-data builder of its own. */
export function multipartBody(
  file: { filename: string; contentType: string; data: Buffer },
  fields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----platen${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export async function upload(
  app: FastifyInstance,
  token: string,
  data: Buffer,
  filename = 'photo.jpg',
): Promise<{ asset: { id: string }; duplicate: boolean }> {
  // Fields first: the server reads them off the file part, and busboy only
  // attaches fields that arrive before the file.
  const body = multipartBody({ filename, contentType: 'image/jpeg', data }, { takenAt: '2024-06-01T12:00:00Z' });
  const response = await app.inject({
    method: 'POST',
    url: '/api/assets/upload',
    headers: { ...bearer(token), ...body.headers },
    payload: body.payload,
  });
  if (response.statusCode >= 300) throw new Error(`upload failed (${response.statusCode}): ${response.body}`);
  return response.json();
}

/** Distinct bytes per call, so each upload is a new asset rather than a duplicate. */
let counter = 0;
export const uniqueBytes = (): Buffer => Buffer.from(`fake image ${Date.now()} ${counter++} ${Math.random()}`);
