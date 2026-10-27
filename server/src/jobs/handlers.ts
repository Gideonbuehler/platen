import { join } from 'node:path';
import type { JobType } from '@platen/shared';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import {
  buildStoragePath,
  deleteAssetFiles,
  fileExists,
  libraryPath,
  externalRootPath,
  originalPathFor,
  relocateOriginal,
  removeUserDirectories,
  thumbDir,
  thumbsPath,
} from '../lib/storage.js';
import {
  generateImageDerivatives,
  generateVideoDerivatives,
  readImageMetadata,
  readVideoMetadata,
} from '../services/media.js';
import { embedImage, getMlStatus, toVectorLiteral } from '../services/ml.js';
import { detectFaces, getFaceStatus, writeFaceCrop } from '../services/faces.js';
import { assignFaceToPerson, pruneEmptyPeople, refreshCoverFaces } from '../services/clustering.js';
import { scanLibrary } from '../services/scanner.js';
import { sweepSidecars, writeSidecar } from '../services/sidecar.js';
import { invalidateAsset } from '../services/cache.js';
import { enqueue } from './queue.js';

interface AssetRow {
  id: string;
  owner_id: string;
  type: 'image' | 'video';
  storage_path: string;
  original_filename: string;
  duration_ms: number | null;
  taken_at: Date;
  library_id: string | null;
  /** Root of the external library, joined in; null for uploaded assets. */
  library_root: string | null;
}


/**
 * Absolute path of an asset's original.
 *
 * External library roots are stored relative to EXTERNAL_ROOT, so the two
 * cases differ only in which root the relative path hangs off.
 */
function resolveOriginal(asset: AssetRow): string {
  return asset.library_root
    ? originalPathFor(asset.storage_path, externalRootPath(asset.library_root))
    : libraryPath(asset.storage_path);
}

async function loadAsset(assetId: string): Promise<AssetRow | null> {
  const rows = await sql<AssetRow[]>`
    SELECT a.id, a.owner_id, a.type, a.storage_path, a.original_filename,
           a.duration_ms, a.taken_at, a.library_id, l.path AS library_root
    FROM assets a
    LEFT JOIN external_libraries l ON l.id = a.library_id
    WHERE a.id = ${assetId}
  `;
  return rows[0] ?? null;
}

/**
 * Reads EXIF / container metadata and backfills the asset row.
 *
 * Runs after the upload response has already been sent, so a phone on a slow
 * connection is not held open while we parse a 50 MP RAW header. The upload
 * path writes a provisional `taken_at` from the client, and this job corrects
 * it once the real capture time is known.
 */
async function handleMetadata(assetId: string): Promise<void> {
  const asset = await loadAsset(assetId);
  if (!asset) return; // deleted while queued

  const absolute = resolveOriginal(asset);
  if (!(await fileExists(absolute))) {
    throw new Error(`Original missing on disk: ${asset.storage_path}`);
  }

  const meta =
    asset.type === 'video' ? await readVideoMetadata(absolute) : await readImageMetadata(absolute);

  await sql.begin(async (tx) => {
    await tx`
      UPDATE assets SET
        width = ${meta.width},
        height = ${meta.height},
        duration_ms = ${meta.durationMs},
        orientation = ${meta.orientation},
        taken_at = COALESCE(${meta.takenAt}, taken_at),
        taken_at_offset = COALESCE(${meta.takenAtOffset}, taken_at_offset)
      WHERE id = ${assetId}
    `;

    await tx`
      INSERT INTO asset_exif (
        asset_id, make, model, lens, f_number, exposure_time, iso,
        focal_length, latitude, longitude, altitude
      ) VALUES (
        ${assetId}, ${meta.exif.make}, ${meta.exif.model}, ${meta.exif.lens},
        ${meta.exif.fNumber}, ${meta.exif.exposureTime}, ${meta.exif.iso},
        ${meta.exif.focalLength}, ${meta.exif.latitude}, ${meta.exif.longitude},
        ${meta.exif.altitude}
      )
      ON CONFLICT (asset_id) DO UPDATE SET
        make = EXCLUDED.make, model = EXCLUDED.model, lens = EXCLUDED.lens,
        f_number = EXCLUDED.f_number, exposure_time = EXCLUDED.exposure_time,
        iso = EXCLUDED.iso, focal_length = EXCLUDED.focal_length,
        latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
        altitude = EXCLUDED.altitude
    `;
  });

  // The upload was filed under the client's guess at the capture date. Now that
  // EXIF has given the real one, move the file if it belongs in another month.
  await refileByCaptureDate(asset, meta.takenAt);

  await enqueue('thumbnail', { assetId }, `thumbnail:${assetId}`);

  // Everything the sidecar records is settled now: dimensions, the corrected
  // capture time, and the final resting path. Later changes — albums,
  // favourites, a face gaining a name — are picked up by the daily sweep.
  await enqueue('sidecar', { assetId }, `sidecar:${assetId}`);
}

/**
 * Keeps the on-disk YYYY/MM folder in step with the corrected capture date.
 *
 * The move and the database update cannot be one atomic operation, so the order
 * is chosen to fail safe: move first, then record it. If the update fails the
 * job retries, and `relocateOriginal` recognises the already-moved file and
 * simply records the new path. The one outcome we never want — a row pointing
 * at a path with no file — is the one this ordering rules out.
 */
async function refileByCaptureDate(asset: AssetRow, exifTakenAt: Date | null): Promise<void> {
  if (!exifTakenAt) return;

  // External files belong to the user, not to us. Tidying them into YYYY/MM
  // folders would be reorganising someone's own directory tree behind their
  // back — the single most alarming thing an indexer could do.
  if (asset.library_id) return;

  const desiredPath = buildStoragePath(
    asset.owner_id,
    asset.id,
    exifTakenAt,
    asset.original_filename,
  );
  if (desiredPath === asset.storage_path) return;

  const outcome = await relocateOriginal(asset.storage_path, desiredPath);

  if (outcome === 'missing') {
    throw new Error(
      `Original missing while refiling ${asset.id}: ${asset.storage_path} -> ${desiredPath}`,
    );
  }
  if (outcome === 'unchanged') return;

  await sql`UPDATE assets SET storage_path = ${desiredPath} WHERE id = ${asset.id}`;
}

/** Generates the grid tile and lightbox preview, then queues the embedding. */
async function handleThumbnail(assetId: string): Promise<void> {
  const asset = await loadAsset(assetId);
  if (!asset) return;

  const absolute = resolveOriginal(asset);
  const outDir = thumbsPath(thumbDir(asset.owner_id, asset.id));

  try {
    const derivatives =
      asset.type === 'video'
        ? await generateVideoDerivatives(absolute, outDir, asset.duration_ms)
        : await generateImageDerivatives(absolute, outDir);

    // Trust the rendered preview over the file header. This is the only place
    // that knows what shape the image actually ended up, and keeping the two in
    // step is what stops the grid drawing a landscape tile around an upright
    // photo. COALESCE guards the case where dimensions could not be read at all.
    await sql`
      UPDATE assets SET
        thumb_status = 'ready',
        width  = COALESCE(${derivatives.width}, width),
        height = COALESCE(${derivatives.height}, height)
      WHERE id = ${assetId}
    `;

    // The files behind these keys have just been rewritten; a cached copy of
    // the previous render would otherwise outlive them.
    await invalidateAsset(assetId);
  } catch (err) {
    // Mark failed so the UI can show a placeholder instead of a spinner
    // forever, then rethrow so the queue applies its retry policy.
    await sql`UPDATE assets SET thumb_status = 'failed' WHERE id = ${assetId}`;
    throw err;
  }

  if (config.ENABLE_ML) {
    await enqueue('embedding', { assetId }, `embedding:${assetId}`);
  }
  if (config.ENABLE_FACES) {
    await enqueue('face-detect', { assetId }, `face-detect:${assetId}`);
  }
}

/**
 * Computes the CLIP embedding from the *preview*, not the original: it is
 * already decoded, orientation-corrected and small, and CLIP downsamples to
 * 224px anyway, so the original's extra pixels are pure cost.
 */
async function handleEmbedding(assetId: string): Promise<void> {
  if (!config.ENABLE_ML) return;

  // The first-run download takes minutes. Awaiting it here would pin a worker
  // slot per concurrent embedding job and stall thumbnail generation, which is
  // what the user is actually waiting to see. Back off and let the retry
  // schedule pick this up once the model is ready.
  const ml = getMlStatus();
  if (ml.state === 'loading') {
    throw new Error('Search model is still loading; embedding will retry shortly.');
  }

  const asset = await loadAsset(assetId);
  if (!asset) return;

  const previewPath = join(thumbsPath(thumbDir(asset.owner_id, asset.id)), 'preview.webp');
  if (!(await fileExists(previewPath))) {
    throw new Error('Preview not generated yet; embedding will retry.');
  }

  const vector = await embedImage(previewPath);

  await sql`
    INSERT INTO asset_embeddings (asset_id, embedding, model)
    VALUES (${assetId}, ${toVectorLiteral(vector)}, ${config.ML_MODEL})
    ON CONFLICT (asset_id) DO UPDATE SET
      embedding = EXCLUDED.embedding,
      model = EXCLUDED.model,
      created_at = now()
  `;
}

/**
 * Permanently removes assets that have been in the trash past the retention
 * window. Files are deleted before the row, so a crash mid-purge leaves an
 * orphaned row (harmless, retried next run) rather than an orphaned file
 * (invisible, and it accumulates).
 */
async function handleTrashPurge(): Promise<void> {
  const expired = await sql<
    { id: string; owner_id: string; storage_path: string; library_id: string | null }[]
  >`
    SELECT id, owner_id, storage_path, library_id FROM assets
    WHERE deleted_at IS NOT NULL
      AND deleted_at < now() - ${`${config.TRASH_RETENTION_DAYS} days`}::interval
    LIMIT 500
  `;

  for (const row of expired) {
    // An external original is the user's own file; purging only forgets it.
    await deleteAssetFiles(row.owner_id, row.id, row.storage_path, row.library_id !== null);
    await sql`DELETE FROM assets WHERE id = ${row.id}`;
  }

  // Deliberately does NOT re-arm itself. Re-arming from inside the handler
  // cannot use the recurring dedupe key — the current job still holds it — so
  // every run would leak an un-deduped row, and the queue would grow by one
  // job per restart forever. The worker re-enqueues it on a timer instead,
  // where ON CONFLICT DO NOTHING caps it at a single outstanding job.
}

/** Rows read per batch, and batches per run before handing on to a fresh job. */
const FILE_PURGE_BATCH = 500;
const FILE_PURGE_BATCHES_PER_RUN = 10;

/**
 * Deletes files whose rows are already gone — today, a deleted user's.
 *
 * Bounded per run so a large library cannot hold one job past the stale-job
 * threshold; a follow-up job picks up the rest. Re-running is harmless: every
 * removal tolerates a file that is already gone, and a row only leaves the
 * table after its files have.
 */
async function handleFilePurge(): Promise<void> {
  for (let batch = 0; batch < FILE_PURGE_BATCHES_PER_RUN; batch++) {
    const rows = await sql<
      { id: string; owner_id: string; asset_id: string; storage_path: string; is_external: boolean }[]
    >`
      SELECT id, owner_id, asset_id, storage_path, is_external
      FROM file_deletions ORDER BY id LIMIT ${FILE_PURGE_BATCH}
    `;
    if (rows.length === 0) return;

    for (const row of rows) {
      await deleteAssetFiles(row.owner_id, row.asset_id, row.storage_path, row.is_external);
    }
    await sql`DELETE FROM file_deletions WHERE id = ANY(${rows.map((row) => row.id)}::bigint[])`;

    // Tidy an owner's folders once nothing more is queued for them, and never
    // for an account that still exists.
    for (const ownerId of new Set(rows.map((row) => row.owner_id))) {
      const [state] = await sql<{ alive: boolean; pending: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM users WHERE id = ${ownerId}) AS alive,
               EXISTS (SELECT 1 FROM file_deletions WHERE owner_id = ${ownerId}) AS pending
      `;
      if (state && !state.alive && !state.pending) await removeUserDirectories(ownerId);
    }
  }

  // Out of budget with work left. No dedupe key: this job still holds the
  // shared one until it returns.
  const more = await sql`SELECT 1 FROM file_deletions LIMIT 1`;
  if (more.length > 0) await enqueue('file-purge');
}

/**
 * Finds faces in an asset and groups them with people already known.
 *
 * Runs against the preview: the detector resizes to 640px regardless, so
 * decoding a 60 MP original for it would be wasted work. Coordinates are
 * stored normalised 0..1 against the preview, which keeps them valid if the
 * derivatives are ever regenerated at a different size.
 */
async function handleFaceDetect(assetId: string): Promise<void> {
  if (!config.ENABLE_FACES) return;

  // Same reasoning as embeddings: a first-run model download takes minutes and
  // must not pin worker slots that thumbnails need.
  const status = getFaceStatus();
  if (status.state === 'loading') {
    throw new Error('Face models are still loading; detection will retry shortly.');
  }

  const asset = await loadAsset(assetId);
  if (!asset) return;

  // Videos would need frame sampling to be worth scanning; stills only for now.
  if (asset.type !== 'image') {
    await sql`UPDATE assets SET faces_scanned_at = now() WHERE id = ${assetId}`;
    return;
  }

  const faceDir = thumbDir(asset.owner_id, asset.id);
  const previewPath = join(thumbsPath(faceDir), 'preview.webp');
  if (!(await fileExists(previewPath))) {
    throw new Error('Preview not generated yet; face detection will retry.');
  }

  const detected = await detectFaces(previewPath);

  // Replace rather than append, so a re-scan cannot double-count faces. Doing
  // it inside the same transaction as the insert means a crash mid-scan leaves
  // the previous results intact instead of an empty set.
  const previous = await sql<{ id: string; person_id: string | null }[]>`
    SELECT id, person_id FROM faces WHERE asset_id = ${assetId}
  `;
  if (previous.length > 0) {
    await sql`DELETE FROM faces WHERE asset_id = ${assetId}`;
  }

  const meta = await sharpMetadata(previewPath);

  for (const face of detected) {
    const relativeThumb = `${faceDir}/faces/${assetId}-${Math.round(face.x)}-${Math.round(face.y)}.webp`;

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO faces (
        asset_id, bbox_x, bbox_y, bbox_w, bbox_h, score, landmarks, embedding, thumb_path
      ) VALUES (
        ${assetId},
        ${face.x / meta.width},
        ${face.y / meta.height},
        ${face.width / meta.width},
        ${face.height / meta.height},
        ${face.score},
        ${sql.json(face.landmarks as unknown as Record<string, never>)},
        ${toVectorLiteral(face.embedding)},
        ${relativeThumb}
      )
      RETURNING id
    `;
    if (!row) continue;

    try {
      await writeFaceCrop(previewPath, face, thumbsPath(relativeThumb));
    } catch {
      // A crop failure costs an avatar, not the grouping itself.
      await sql`UPDATE faces SET thumb_path = NULL WHERE id = ${row.id}`;
    }

    await assignFaceToPerson(row.id, asset.owner_id, toVectorLiteral(face.embedding));
  }

  await sql`UPDATE assets SET faces_scanned_at = now() WHERE id = ${assetId}`;

  await pruneEmptyPeople(asset.owner_id);
  await refreshCoverFaces(asset.owner_id);
}

/** Preview dimensions, used to normalise face boxes. */
async function sharpMetadata(path: string): Promise<{ width: number; height: number }> {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(path).metadata();
  if (!meta.width || !meta.height) throw new Error(`Could not read dimensions of ${path}`);
  return { width: meta.width, height: meta.height };
}

export async function runJob(type: JobType, payload: Record<string, unknown>): Promise<void> {
  const assetId = typeof payload.assetId === 'string' ? payload.assetId : null;

  switch (type) {
    case 'metadata':
      if (!assetId) throw new Error('metadata job requires assetId');
      return handleMetadata(assetId);
    case 'thumbnail':
    case 'video-poster':
      if (!assetId) throw new Error('thumbnail job requires assetId');
      return handleThumbnail(assetId);
    case 'embedding':
      if (!assetId) throw new Error('embedding job requires assetId');
      return handleEmbedding(assetId);
    case 'library-scan': {
      const libraryId = typeof payload.libraryId === 'string' ? payload.libraryId : null;
      if (!libraryId) throw new Error('library-scan job requires libraryId');
      await scanLibrary(libraryId);
      return;
    }
    case 'trash-purge':
      return handleTrashPurge();
    case 'file-purge':
      return handleFilePurge();
    case 'sidecar':
      if (!assetId) throw new Error('sidecar job requires assetId');
      await writeSidecar(assetId);
      return;
    case 'sidecar-sweep':
      await sweepSidecars();
      return;
    case 'face-detect':
      if (!assetId) throw new Error('face-detect job requires assetId');
      return handleFaceDetect(assetId);
    default:
      throw new Error(`Unknown job type: ${type}`);
  }
}
