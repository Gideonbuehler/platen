import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, waitForDatabase, closeDatabase } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/db/migrate.js -> ../../migrations ; src/db/migrate.ts -> ../../migrations
const MIGRATIONS_DIR = join(here, '..', '..', 'migrations');

/**
 * Deliberately minimal migration runner: numbered .sql files, applied in order,
 * each inside its own transaction, recorded in `schema_migrations`. No down
 * migrations — rolling forward is safer for a system holding irreplaceable data.
 */
export async function migrate(): Promise<void> {
  await waitForDatabase();

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const contents = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`Applying migration ${file}...`);

    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    count++;
  }

  // eslint-disable-next-line no-console
  console.log(count === 0 ? 'Database schema is up to date.' : `Applied ${count} migration(s).`);
}

// Allow `npm run migrate` to run this file directly.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, '/')
    ? true
    : process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js');

if (invokedDirectly) {
  migrate()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
