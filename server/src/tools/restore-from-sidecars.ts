/**
 * Rebuilds the catalogue from the sidecars in the library.
 *
 * This is the other half of writing sidecars, and the only thing that makes
 * them worth writing: a description nothing can read back is decoration. If
 * Postgres is gone, stale, or corrupt, this walks `LIBRARY_PATH`, reads the
 * JSON beside each original, and puts the rows back.
 *
 * What it restores: assets with their real filenames and capture times, EXIF,
 * album membership, favourites, archived state.
 *
 * What it cannot: face recognition. The sidecar records who is in a photo, but
 * not the 512-dimension embeddings that identify them, and inventing those is
 * not possible. Re-running detection rebuilds the groups; naming them is
 * manual. The names in the sidecars are printed at the end so that work is at
 * least guided rather than blind.
 *
 * Users are never created — an account needs a password this file does not
 * have. Create the accounts first, with the same email addresses, and run
 * again.
 *
 *   npm run restore -w server              # report only
 *   npm run restore -w server -- --apply   # write the rows
 *   npm run restore -w server -- --apply --verify   # also re-hash every file
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { config } from '../config.js';
import { sql, closeDatabase, waitForDatabase } from '../db/index.js';
import { enqueue } from '../jobs/queue.js';
import type { Sidecar } from '../services/sidecar.js';

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');

interface Found {
  sidecar: Sidecar;
  /** Path of the original, relative to LIBRARY_PATH, with forward slashes. */
  storagePath: string;
  absoluteOriginal: string;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith('.json')) yield full;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function collect(): Promise<{ found: Found[]; problems: string[] }> {
  const found: Found[] = [];
  const problems: string[] = [];

  for await (const sidecarPath of walk(config.LIBRARY_PATH)) {
    let sidecar: Sidecar;
    try {
      sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as Sidecar;
    } catch (err) {
      problems.push(`unreadable sidecar ${sidecarPath}: ${(err as Error).message}`);
      continue;
    }

    if (sidecar.version !== 1 || !sidecar.assetId || !sidecar.originalFilename) {
      problems.push(`not an Platen sidecar: ${sidecarPath}`);
      continue;
    }

    // The original sits beside it, sharing the basename. Recovering the
    // extension from the recorded filename avoids guessing.
    const ext = sidecar.originalFilename.slice(sidecar.originalFilename.lastIndexOf('.'));
    const absoluteOriginal = sidecarPath.replace(/\.json$/, ext.toLowerCase());

    let size: number;
    try {
      size = (await stat(absoluteOriginal)).size;
    } catch {
      problems.push(`${sidecar.originalFilename}: described but the file is missing`);
      continue;
    }

    if (size !== sidecar.fileSize) {
      problems.push(
        `${sidecar.originalFilename}: size is ${size}, sidecar says ${sidecar.fileSize}`,
      );
      continue;
    }

    if (VERIFY) {
      const actual = await sha256(absoluteOriginal);
      if (actual !== sidecar.checksum) {
        problems.push(`${sidecar.originalFilename}: checksum mismatch — the file has changed`);
        continue;
      }
    }

    found.push({
      sidecar,
      storagePath: relative(config.LIBRARY_PATH, absoluteOriginal).split(sep).join('/'),
      absoluteOriginal,
    });
  }

  return { found, problems };
}

async function apply(found: Found[]): Promise<void> {
  const users = await sql<{ id: string; email: string }[]>`SELECT id, email FROM users`;
  const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

  const missingOwners = new Set<string>();
  let restored = 0;
  let alreadyPresent = 0;
  const albumsByOwner = new Map<string, Map<string, string[]>>();

  for (const item of found) {
    const ownerId = userByEmail.get(item.sidecar.owner.toLowerCase());
    if (!ownerId) {
      missingOwners.add(item.sidecar.owner);
      continue;
    }

    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM assets WHERE id = ${item.sidecar.assetId}
    `;
    if (existing) {
      alreadyPresent++;
    } else {
      const s = item.sidecar;
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO assets (
            id, owner_id, checksum, type, original_filename, storage_path,
            mime_type, file_size, width, height, duration_ms, orientation,
            taken_at, taken_at_offset, is_favorite, is_archived
          ) VALUES (
            ${s.assetId}, ${ownerId}, ${Buffer.from(s.checksum, 'hex')}, ${s.type},
            ${s.originalFilename}, ${item.storagePath}, ${s.mimeType}, ${s.fileSize},
            ${s.width}, ${s.height}, ${s.durationMs}, ${s.orientation},
            ${new Date(s.takenAt)}, ${s.takenAtOffset}, ${s.isFavorite}, ${s.isArchived}
          )
          -- A second copy of the same bytes under the same owner is the
          -- de-duplication rule doing its job, not an error to abort on.
          ON CONFLICT DO NOTHING
        `;

        if (s.exif) {
          const e = s.exif as Record<string, number | string | null>;
          await tx`
            INSERT INTO asset_exif (
              asset_id, make, model, lens, f_number, exposure_time, iso,
              focal_length, latitude, longitude, altitude
            ) VALUES (
              ${s.assetId}, ${e.make ?? null}, ${e.model ?? null}, ${e.lens ?? null},
              ${e.fNumber ?? null}, ${e.exposureTime ?? null}, ${e.iso ?? null},
              ${e.focalLength ?? null}, ${e.latitude ?? null}, ${e.longitude ?? null},
              ${e.altitude ?? null}
            )
            ON CONFLICT (asset_id) DO NOTHING
          `;
        }
      });
      restored++;
    }

    for (const album of item.sidecar.albums) {
      const owned = albumsByOwner.get(ownerId) ?? new Map<string, string[]>();
      const members = owned.get(album) ?? [];
      members.push(item.sidecar.assetId);
      owned.set(album, members);
      albumsByOwner.set(ownerId, owned);
    }
  }

  // Albums after assets, so every membership row has something to point at.
  let albumsRestored = 0;
  for (const [ownerId, albums] of albumsByOwner) {
    for (const [name, assetIds] of albums) {
      const [album] = await sql<{ id: string }[]>`
        INSERT INTO albums (owner_id, name)
        VALUES (${ownerId}, ${name})
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      const albumId =
        album?.id ??
        (
          await sql<{ id: string }[]>`
            SELECT id FROM albums WHERE owner_id = ${ownerId} AND name = ${name} LIMIT 1
          `
        )[0]?.id;
      if (!albumId) continue;
      if (album) albumsRestored++;

      for (const assetId of assetIds) {
        await sql`
          INSERT INTO album_assets (album_id, asset_id)
          VALUES (${albumId}, ${assetId})
          ON CONFLICT DO NOTHING
        `;
      }
    }
  }

  // Derivatives and embeddings are regenerable, and none of them are in the
  // sidecar, so every restored asset needs the pipeline run over it again.
  for (const item of found) {
    await enqueue('metadata', { assetId: item.sidecar.assetId }, `metadata:${item.sidecar.assetId}`);
  }

  console.log(`\nRestored       ${restored} asset(s)`);
  console.log(`Already there  ${alreadyPresent}`);
  console.log(`Albums created ${albumsRestored}`);
  console.log(`Queued         ${found.length} asset(s) for thumbnails and indexing`);

  if (missingOwners.size > 0) {
    console.log('\nSkipped — no account with these addresses. Create them and run again:');
    for (const email of missingOwners) console.log(`  ${email}`);
  }
}

async function main(): Promise<void> {
  console.log(`Reading sidecars under ${config.LIBRARY_PATH}\n`);

  const { found, problems } = await collect();

  const owners = new Map<string, number>();
  const people = new Set<string>();
  const albums = new Set<string>();
  for (const { sidecar } of found) {
    owners.set(sidecar.owner, (owners.get(sidecar.owner) ?? 0) + 1);
    for (const person of sidecar.people) people.add(person);
    for (const album of sidecar.albums) albums.add(album);
  }

  console.log(`Found ${found.length} described asset(s)`);
  for (const [email, count] of owners) console.log(`  ${email}: ${count}`);
  console.log(`Albums: ${albums.size}`);
  console.log(`Named people: ${people.size}`);

  if (problems.length > 0) {
    console.log(`\n${problems.length} problem(s):`);
    for (const problem of problems.slice(0, 40)) console.log(`  ${problem}`);
    if (problems.length > 40) console.log(`  ... and ${problems.length - 40} more`);
  }

  if (!APPLY) {
    console.log('\nReport only. Re-run with --apply to write these rows.');
    return;
  }

  await waitForDatabase();
  await apply(found);

  if (people.size > 0) {
    console.log('\nFace recognition cannot be restored from sidecars — the embeddings');
    console.log('are not in them. Re-run detection, then name the groups. These were');
    console.log('the names before:');
    console.log(`  ${[...people].sort().join(', ')}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
