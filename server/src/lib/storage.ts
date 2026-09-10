import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config } from '../config.js';

/**
 * On-disk layout (all paths relative to the configured roots):
 *
 *   library/<userId>/<yyyy>/<MM>/<assetId><ext>   originals, never modified
 *   thumbs/<userId>/<assetId>/thumb.webp          320px  grid tile
 *   thumbs/<userId>/<assetId>/preview.webp        1600px lightbox
 *   tmp/<uuid>                                    in-flight uploads
 *
 * Originals are content-addressed by database checksum rather than by filename,
 * so two people uploading the same photo each keep their own copy under their
 * own user directory. That costs disk but keeps per-user deletion trivial.
 */

export async function ensureStorageDirs(): Promise<void> {
  await Promise.all([
    mkdir(config.LIBRARY_PATH, { recursive: true }),
    mkdir(config.THUMBS_PATH, { recursive: true }),
    mkdir(config.UPLOAD_TMP_PATH, { recursive: true }),
  ]);
}

/**
 * Guards against path traversal. Every path we build from database values goes
 * through here before it reaches the filesystem, because `storage_path` is the
 * one column an attacker could conceivably influence via a crafted filename.
 */
function safeJoin(root: string, relative: string): string {
  const full = resolve(root, normalize(relative));
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    throw new Error(`Refusing to access path outside storage root: ${relative}`);
  }
  return full;
}

export const libraryPath = (relative: string) => safeJoin(config.LIBRARY_PATH, relative);
export const thumbsPath = (relative: string) => safeJoin(config.THUMBS_PATH, relative);

/** Relative storage path for a new original, bucketed by capture date. */
export function buildStoragePath(
  userId: string,
  assetId: string,
  takenAt: Date,
  originalFilename: string,
): string {
  const year = String(takenAt.getUTCFullYear());
  const month = String(takenAt.getUTCMonth() + 1).padStart(2, '0');
  const ext = extname(originalFilename).toLowerCase() || '.bin';
  return join(userId, year, month, `${assetId}${ext}`).replace(/\\/g, '/');
}

export const thumbDir = (userId: string, assetId: string) =>
  join(userId, assetId).replace(/\\/g, '/');

export interface StagedUpload {
  tmpPath: string;
  /** Lowercase hex sha256 of the bytes written. */
  checksum: string;
  size: number;
}

/**
 * Streams an upload to a temp file while hashing it in the same pass, so we
 * never hold a multi-gigabyte video in memory and never read it twice.
 * Aborts and cleans up if the stream exceeds MAX_UPLOAD_BYTES.
 */
export async function stageUpload(source: Readable): Promise<StagedUpload> {
  await mkdir(config.UPLOAD_TMP_PATH, { recursive: true });
  const tmpPath = join(config.UPLOAD_TMP_PATH, randomUUID());

  const hash = createHash('sha256');
  let size = 0;
  let aborted: Error | null = null;

  source.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > config.MAX_UPLOAD_BYTES && !aborted) {
      aborted = new Error(`Upload exceeds the ${config.MAX_UPLOAD_BYTES}-byte limit`);
      source.destroy(aborted);
    } else {
      hash.update(chunk);
    }
  });

  try {
    await pipeline(source, createWriteStream(tmpPath));
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw aborted ?? err;
  }

  return { tmpPath, checksum: hash.digest('hex'), size };
}

/** Moves a staged upload into its final home, creating parent dirs. */
export async function commitUpload(tmpPath: string, relativeStoragePath: string): Promise<void> {
  const dest = libraryPath(relativeStoragePath);
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(tmpPath, dest);
  } catch (err) {
    // rename() fails across devices — Unraid users often map tmp and library to
    // different shares. Fall back to a copy, then remove the source.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await pipeline(createReadStream(tmpPath), createWriteStream(dest));
      await rm(tmpPath, { force: true });
    } else {
      throw err;
    }
  }
}

export async function discardUpload(tmpPath: string): Promise<void> {
  await rm(tmpPath, { force: true });
}

/**
 * Moves an original into a different date bucket.
 *
 * Uploads are filed under the capture time the client supplied, which is only a
 * guess (usually the file's mtime). Once EXIF gives the real DateTimeOriginal,
 * the file may belong in a different YYYY/MM folder — and since "your photos
 * are just files on your NAS" is the point of self-hosting, the folder someone
 * browses should match the date they see in the app.
 *
 * Returns 'moved' when the bytes were relocated, 'already-there' when the
 * destination already holds the file (a retry after the database update failed)
 * and 'unchanged' when no move was needed. Never throws for a missing source;
 * the caller decides whether that is fatal.
 */
export async function relocateOriginal(
  fromRelative: string,
  toRelative: string,
): Promise<'moved' | 'already-there' | 'unchanged' | 'missing'> {
  if (fromRelative === toRelative) return 'unchanged';

  const from = libraryPath(fromRelative);
  const to = libraryPath(toRelative);

  const sourceExists = await fileExists(from);
  if (!sourceExists) {
    // A previous attempt moved the file but died before recording it. The
    // destination being present means the move genuinely succeeded.
    return (await fileExists(to)) ? 'already-there' : 'missing';
  }

  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await pipeline(createReadStream(from), createWriteStream(to));
      await rm(from, { force: true });
    } else {
      throw err;
    }
  }

  await pruneEmptyParents(dirname(from));
  return 'moved';
}

/**
 * Removes date folders left empty by a move, walking up as far as the user
 * directory. Someone browsing the library over SMB should not find a scatter of
 * empty YYYY/MM folders that never held anything.
 *
 * `rmdir` on a non-empty directory simply fails, which is the exact test we
 * want, so failures here are expected and always ignored.
 */
async function pruneEmptyParents(startDir: string): Promise<void> {
  const stopAt = resolve(config.LIBRARY_PATH);
  let current = resolve(startDir);

  // At most two levels: the MM folder and then the YYYY folder above it.
  for (let depth = 0; depth < 2; depth++) {
    if (current === stopAt || !current.startsWith(stopAt + sep)) return;
    try {
      await rmdir(current);
    } catch {
      return; // not empty, or already gone
    }
    current = dirname(current);
  }
}

/** Removes an original and all its derivatives. Used by the trash purge job. */
export async function deleteAssetFiles(
  userId: string,
  assetId: string,
  relativeStoragePath: string,
): Promise<void> {
  await rm(libraryPath(relativeStoragePath), { force: true });
  await rm(thumbsPath(thumbDir(userId, assetId)), { recursive: true, force: true });
}

export async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
