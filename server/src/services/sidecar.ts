import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from '../db/index.js';
import { libraryPath, sidecarRelativePath } from '../lib/storage.js';

/**
 * Per-asset JSON written next to each original.
 *
 * The problem it solves: originals are stored as `<assetId>.<ext>`, so the
 * filename on disk carries no information at all. Every human-meaningful fact
 * about a photo — what it was called, when it was taken, which albums it is
 * in, who is in it, whether it was a favourite — lives only in Postgres. Lose
 * the database and the library becomes a correctly-dated pile of UUIDs.
 *
 * For an application whose entire purpose is being the copy that survives,
 * that is the wrong failure mode. A database backup is the fast path to
 * recovery; this is the one that works when the fast path is missing, stale,
 * or corrupt. It costs roughly 600 bytes per asset and one write whenever
 * something changes.
 *
 * Deliberately plain JSON rather than XMP: XMP has no standard place for album
 * membership or face names, so half of what matters would end up in a custom
 * namespace anyway, and JSON can be read by anything.
 */
export interface Sidecar {
  /** Bumped only if the shape changes incompatibly. */
  version: 1;
  assetId: string;
  /** Email of the owner, so a restore knows which account to file it under. */
  owner: string;
  originalFilename: string;
  /** Lowercase hex sha256 of the original bytes — verifies the file beside it. */
  checksum: string;
  type: 'image' | 'video';
  mimeType: string;
  fileSize: number;
  takenAt: string;
  takenAtOffset: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  orientation: number;
  isFavorite: boolean;
  isArchived: boolean;
  albums: string[];
  people: string[];
  exif: Record<string, unknown> | null;
  /** When this file was written, not when the asset changed. */
  writtenAt: string;
}

interface SidecarRow {
  id: string;
  owner_email: string;
  original_filename: string;
  checksum: Buffer;
  type: 'image' | 'video';
  mime_type: string;
  file_size: string;
  taken_at: Date;
  taken_at_offset: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  orientation: number;
  is_favorite: boolean;
  is_archived: boolean;
  storage_path: string;
  albums: string[] | null;
  people: string[] | null;
  make: string | null;
  model: string | null;
  lens: string | null;
  f_number: number | null;
  exposure_time: string | null;
  iso: number | null;
  focal_length: number | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
}

/**
 * Assets in an external library are excluded.
 *
 * Those files live in a folder the user already curates, mounted read-only by
 * default — writing our bookkeeping into it would both fail and be rude. They
 * are also the one case where the originals are not ours to be responsible
 * for: the user's own folder structure is already the description.
 */
const SELECT_COLUMNS = `
  a.id,
  u.email AS owner_email,
  a.original_filename,
  a.checksum,
  a.type::text AS type,
  a.mime_type,
  a.file_size::text AS file_size,
  a.taken_at,
  a.taken_at_offset,
  a.width,
  a.height,
  a.duration_ms,
  a.orientation,
  a.is_favorite,
  a.is_archived,
  a.storage_path,
  (
    SELECT array_agg(al.name ORDER BY al.name)
    FROM album_assets aa JOIN albums al ON al.id = aa.album_id
    WHERE aa.asset_id = a.id
  ) AS albums,
  (
    SELECT array_agg(DISTINCT p.name)
    FROM faces f JOIN people p ON p.id = f.person_id
    WHERE f.asset_id = a.id AND p.name IS NOT NULL
  ) AS people,
  e.make, e.model, e.lens, e.f_number, e.exposure_time, e.iso,
  e.focal_length, e.latitude, e.longitude, e.altitude
`;

function toSidecar(row: SidecarRow): Sidecar {
  const exif: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) exif[key] = value;
  };
  put('make', row.make);
  put('model', row.model);
  put('lens', row.lens);
  put('fNumber', row.f_number);
  put('exposureTime', row.exposure_time);
  put('iso', row.iso);
  put('focalLength', row.focal_length);
  put('latitude', row.latitude);
  put('longitude', row.longitude);
  put('altitude', row.altitude);

  return {
    version: 1,
    assetId: row.id,
    owner: row.owner_email,
    originalFilename: row.original_filename,
    checksum: row.checksum.toString('hex'),
    type: row.type,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    takenAt: row.taken_at.toISOString(),
    takenAtOffset: row.taken_at_offset,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    orientation: row.orientation,
    isFavorite: row.is_favorite,
    isArchived: row.is_archived,
    // Sorted so that two runs over unchanged data produce identical bytes and
    // the comparison below can skip the write.
    albums: [...(row.albums ?? [])].sort(),
    people: [...(row.people ?? [])].sort(),
    exif: Object.keys(exif).length > 0 ? exif : null,
    writtenAt: new Date().toISOString(),
  };
}

/** Absolute path of an asset's sidecar. `<uuid>.jpg` sits beside `<uuid>.json`. */
export function sidecarPathFor(storagePath: string): string {
  return libraryPath(sidecarRelativePath(storagePath));
}

/**
 * Everything but `writtenAt`, which changes on every run and would otherwise
 * make every sidecar look modified.
 */
function comparable(sidecar: Sidecar): string {
  const { writtenAt: _ignored, ...rest } = sidecar;
  return JSON.stringify(rest);
}

export type SidecarOutcome = 'written' | 'unchanged' | 'skipped';

async function persist(sidecar: Sidecar, storagePath: string): Promise<SidecarOutcome> {
  const path = sidecarPathFor(storagePath);

  try {
    const existing = JSON.parse(await readFile(path, 'utf8')) as Sidecar;
    if (comparable(existing) === comparable(sidecar)) return 'unchanged';
  } catch {
    // Missing, unreadable or not valid JSON — all mean "write it".
  }

  // Write-and-rename, so a crash mid-write cannot leave a truncated sidecar
  // sitting next to an intact original. A half-written description is worse
  // than none: it looks authoritative.
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return 'written';
}

/** Writes one asset's sidecar. No-op for external-library and trashed assets. */
export async function writeSidecar(assetId: string): Promise<SidecarOutcome> {
  const rows = await sql<SidecarRow[]>`
    SELECT ${sql.unsafe(SELECT_COLUMNS)}
    FROM assets a
    JOIN users u ON u.id = a.owner_id
    LEFT JOIN asset_exif e ON e.asset_id = a.id
    WHERE a.id = ${assetId}
      AND a.library_id IS NULL
      AND a.deleted_at IS NULL
  `;
  const row = rows[0];
  if (!row) return 'skipped';
  return persist(toSidecar(row), row.storage_path);
}

export interface SweepResult {
  written: number;
  unchanged: number;
  failed: number;
}

/**
 * Rewrites every sidecar that no longer matches the database.
 *
 * A per-asset job covers uploads, but album membership, favourites and face
 * names change through paths that have nothing to do with the asset's own
 * `updated_at` — naming a person retroactively describes thousands of photos.
 * Rather than hook every one of those call sites and hope none is ever missed,
 * this walks the library and compares. Unchanged sidecars cost one small read
 * and no write, which at personal-library scale is cheap enough to run daily
 * and removes a whole class of staleness bug.
 */
export async function sweepSidecars(batchSize = 500): Promise<SweepResult> {
  const result: SweepResult = { written: 0, unchanged: 0, failed: 0 };
  let after = '00000000-0000-0000-0000-000000000000';

  for (;;) {
    const rows = await sql<SidecarRow[]>`
      SELECT ${sql.unsafe(SELECT_COLUMNS)}
      FROM assets a
      JOIN users u ON u.id = a.owner_id
      LEFT JOIN asset_exif e ON e.asset_id = a.id
      WHERE a.library_id IS NULL
        AND a.deleted_at IS NULL
        AND a.id > ${after}
      ORDER BY a.id
      LIMIT ${batchSize}
    `;
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        const outcome = await persist(toSidecar(row), row.storage_path);
        if (outcome === 'written') result.written++;
        else result.unchanged++;
      } catch {
        // One unwritable file must not abort the sweep; the next run retries.
        result.failed++;
      }
    }

    const last = rows[rows.length - 1];
    if (!last) break;
    after = last.id;
  }

  await recordSweep(result);
  return result;
}

const SWEEP_SETTING_KEY = 'sidecar.lastSweep';

export interface SidecarStatus {
  /** Assets that should have a sidecar: owned, not trashed, not external. */
  describedAssets: number;
  lastSweepAt: string | null;
  lastSweep: SweepResult | null;
}

/**
 * What Settings shows.
 *
 * Counting actual files would mean one stat per asset on every page load, so
 * this reports the last sweep instead — which is the honest number anyway,
 * since the sweep is what creates them. A sweep that reports `failed: 0` and
 * covers the full asset count is the claim "this library describes itself"
 * made checkable rather than asserted.
 */
export async function sidecarStatus(): Promise<SidecarStatus> {
  const [countRow] = await sql<{ total: string }[]>`
    SELECT COUNT(*)::text AS total
    FROM assets
    WHERE library_id IS NULL AND deleted_at IS NULL
  `;

  const [settingRow] = await sql<{ value: { at: string; result: SweepResult } }[]>`
    SELECT value FROM settings WHERE key = ${SWEEP_SETTING_KEY}
  `;

  return {
    describedAssets: Number(countRow?.total ?? 0),
    lastSweepAt: settingRow?.value.at ?? null,
    lastSweep: settingRow?.value.result ?? null,
  };
}

async function recordSweep(result: SweepResult): Promise<void> {
  const value = { at: new Date().toISOString(), result };
  await sql`
    INSERT INTO settings (key, value)
    VALUES (${SWEEP_SETTING_KEY}, ${sql.json(value as never)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}
