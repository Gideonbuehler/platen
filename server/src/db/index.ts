import postgres from 'postgres';
import { config } from '../config.js';

/**
 * Single shared connection pool.
 *
 * `transform.undefined: null` matters: postgres.js otherwise throws on an
 * `undefined` parameter, and half our optional EXIF fields are undefined when
 * a camera did not record them.
 */
export const sql = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 15,
  transform: { undefined: null },
  onnotice: () => {},
});

export type Sql = typeof sql;

/** Retry loop for boot: Postgres in Docker is often not listening yet. */
export async function waitForDatabase(attempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      if (i === attempts) throw err;
      // eslint-disable-next-line no-console
      console.log(`Waiting for database (${i}/${attempts})...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
}
