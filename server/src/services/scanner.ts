import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { externalRootPath } from '../lib/storage.js';
import { enqueue } from '../jobs/queue.js';

/**
 * Indexes an existing folder in place.
 *
 * Nothing is copied, moved, renamed or deleted. The files stay exactly where
 * their owner put them and Platen only records where they are — which is the
 * whole point: pointing a photo app at a decade of accumulated folders should
 * not require a second copy of them, and must not put them at risk.
 */

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tif', '.tiff',
  '.bmp', '.avif', '.arw', '.cr2', '.cr3', '.nef', '.nrw', '.dng', '.raf',
  '.orf', '.rw2', '.pef', '.srw',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp', '.mts', '.m2ts',
]);

const RAW_MIME: Record<string, string> = {
  '.arw': 'image/x-sony-arw',
  '.cr2': 'image/x-canon-cr2',
  '.cr3': 'image/x-canon-cr3',
  '.nef': 'image/x-nikon-nef',
  '.nrw': 'image/x-nikon-nrw',
  '.dng': 'image/x-adobe-dng',
  '.raf': 'image/x-fuji-raf',
  '.orf': 'image/x-olympus-orf',
  '.rw2': 'image/x-panasonic-rw2',
  '.pef': 'image/x-pentax-pef',
  '.srw': 'image/x-samsung-srw',
};

function classify(filename: string): { type: 'image' | 'video'; mime: string } | null {
  const ext = extname(filename).toLowerCase();

  if (VIDEO_EXTENSIONS.has(ext)) {
    return { type: 'video', mime: `video/${ext === '.mov' ? 'quicktime' : ext.slice(1)}` };
  }
  if (RAW_MIME[ext]) return { type: 'image', mime: RAW_MIME[ext]! };
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { type: 'image', mime: `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}` };
  }
  return null;
}

/** sha256 of a file, streamed so a 4 GB video never lands in memory. */
function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export interface ScanResult {
  seen: number;
  added: number;
  updated: number;
  missing: number;
  skipped: number;
}

interface FoundFile {
  relativePath: string;
  size: number;
  mtime: Date;
}

/**
 * Walks the tree, skipping excluded fragments and anything unreadable.
 *
 * A single unreadable directory — a permissions quirk on one share — must not
 * abort a scan of a hundred thousand files, so failures are per-directory.
 */
async function walk(
  root: string,
  exclusions: string[],
  onFile: (file: FoundFile) => Promise<void>,
  depth = 0,
): Promise<void> {
  if (depth > 20) return; // guards against a symlink loop

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(root, entry.name);
    if (exclusions.some((fragment) => entry.name === fragment || full.includes(fragment))) continue;

    // Dotfiles are almost always sidecars or OS metadata, never photographs.
    if (entry.name.startsWith('.')) continue;

    if (entry.isDirectory()) {
      await walk(full, exclusions, onFile, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue; // symlinks are not followed

    try {
      const info = await stat(full);
      await onFile({ relativePath: full, size: info.size, mtime: info.mtime });
    } catch {
      // Vanished mid-scan, or unreadable. Next scan will pick it up.
    }
  }
}

/**
 * Brings the database in line with what is on disk.
 *
 * Identity is the path within the library. Size and mtime are then a cheap
 * "has this changed?" test, so a rescan of an unchanged library reads no file
 * contents at all — hashing everything each time would make a large library
 * unscannable. Content is only hashed for files that are new or have changed,
 * and that hash still feeds the same checksum constraint as uploads, so an
 * external file that duplicates an uploaded one is recognised as the same photo.
 */
export async function scanLibrary(libraryId: string): Promise<ScanResult> {
  const rows = await sql<
    { id: string; owner_id: string; path: string; exclusions: string[]; is_enabled: boolean }[]
  >`
    SELECT id, owner_id, path, exclusions, is_enabled
    FROM external_libraries WHERE id = ${libraryId}
  `;
  const library = rows[0];
  if (!library) throw new Error(`External library ${libraryId} no longer exists`);
  if (!library.is_enabled) return { seen: 0, added: 0, updated: 0, missing: 0, skipped: 0 };

  const root = externalRootPath(library.path);

  // Refuse to scan a root that is not there. Treating an unmounted share as
  // "every photo was deleted" is exactly the failure that would make someone
  // lose their albums and face names to a bad mount.
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    throw new Error(
      `Library path ${library.path} is not a readable directory inside the container. ` +
        'If this is a mounted share, check the mount before rescanning.',
    );
  }

  const existing = await sql<
    { id: string; storage_path: string; file_size: string; source_mtime: Date | null }[]
  >`
    SELECT id, storage_path, file_size, source_mtime
    FROM assets WHERE library_id = ${libraryId}
  `;

  const byPath = new Map(existing.map((row) => [row.storage_path, row]));
  const seenPaths = new Set<string>();

  const result: ScanResult = { seen: 0, added: 0, updated: 0, missing: 0, skipped: 0 };

  await walk(root, library.exclusions, async (file) => {
    const kind = classify(file.relativePath);
    if (!kind) {
      result.skipped++;
      return;
    }

    const relativePath = relative(root, file.relativePath).replace(/\\/g, '/');
    seenPaths.add(relativePath);
    result.seen++;

    const known = byPath.get(relativePath);
    if (known) {
      const unchanged =
        Number(known.file_size) === file.size &&
        known.source_mtime !== null &&
        Math.abs(known.source_mtime.getTime() - file.mtime.getTime()) < 2000;

      if (unchanged) {
        // Clear a stale missing flag: the file is back.
        await sql`
          UPDATE assets SET missing_since = NULL
          WHERE id = ${known.id} AND missing_since IS NOT NULL
        `;
        return;
      }

      // Edited in place — re-derive everything from the new bytes.
      const checksum = await hashFile(file.relativePath);
      await sql`
        UPDATE assets SET
          checksum = ${Buffer.from(checksum, 'hex')},
          file_size = ${file.size},
          source_mtime = ${file.mtime},
          missing_since = NULL,
          thumb_status = 'pending',
          faces_scanned_at = NULL
        WHERE id = ${known.id}
      `;
      await enqueue('metadata', { assetId: known.id }, `metadata:${known.id}`);
      result.updated++;
      return;
    }

    const checksum = await hashFile(file.relativePath);
    const checksumBuffer = Buffer.from(checksum, 'hex');

    // The same (owner, checksum) constraint uploads use, so a file that is
    // already in the library under a different path is not indexed twice.
    const duplicate = await sql<{ id: string }[]>`
      SELECT id FROM assets WHERE owner_id = ${library.owner_id} AND checksum = ${checksumBuffer}
    `;
    if (duplicate.length > 0) {
      result.skipped++;
      return;
    }

    const inserted = await sql<{ id: string }[]>`
      INSERT INTO assets (
        owner_id, library_id, checksum, type, original_filename, storage_path,
        mime_type, file_size, taken_at, source_mtime
      ) VALUES (
        ${library.owner_id}, ${libraryId}, ${checksumBuffer}, ${kind.type},
        ${relativePath.split('/').pop() ?? relativePath}, ${relativePath},
        ${kind.mime}, ${file.size},
        -- Provisional: the metadata job replaces this with EXIF capture time.
        ${file.mtime}, ${file.mtime}
      )
      ON CONFLICT (owner_id, checksum) DO NOTHING
      RETURNING id
    `;

    const asset = inserted[0];
    if (!asset) {
      result.skipped++;
      return;
    }

    await enqueue('metadata', { assetId: asset.id }, `metadata:${asset.id}`);
    result.added++;
  });

  // Anything indexed but not found this pass is flagged, never deleted. The
  // user decides whether it is gone for good.
  const vanished = existing.filter((row) => !seenPaths.has(row.storage_path));
  if (vanished.length > 0) {
    await sql`
      UPDATE assets SET missing_since = now()
      WHERE id = ANY(${vanished.map((row) => row.id)}::uuid[]) AND missing_since IS NULL
    `;
    result.missing = vanished.length;
  }

  await sql`
    UPDATE external_libraries
    SET last_scan_at = now(), last_scan_error = NULL
    WHERE id = ${libraryId}
  `;

  return result;
}

/** Queues a scan for every enabled library whose interval has elapsed. */
export async function scheduleDueScans(): Promise<number> {
  const due = await sql<{ id: string }[]>`
    SELECT id FROM external_libraries
    WHERE is_enabled = true
      AND (
        last_scan_at IS NULL
        OR last_scan_at < now() - ${`${config.EXTERNAL_SCAN_INTERVAL_MINUTES} minutes`}::interval
      )
  `;

  for (const library of due) {
    await enqueue('library-scan', { libraryId: library.id }, `library-scan:${library.id}`);
  }
  return due.length;
}
