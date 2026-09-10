import { join } from 'node:path';
import type { JobType } from '@aperture/shared';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import {
  buildStoragePath,
  deleteAssetFiles,
  fileExists,
  libraryPath,
  relocateOriginal,
  thumbDir,
  thumbsPath,
} from '../lib/storage.js';
import {
  generateImageDerivatives,
  generateVideoDerivatives,
  readImageMetadata,
  readVideoMetadata,
} from '../services/media.js';
import { embedImage, toVectorLiteral } from '../services/ml.js';
import { enqueue } from './queue.js';

interface AssetRow {
  id: string;
  owner_id: string;
  type: 'image' | 'video';
  storage_path: string;
  original_filename: string;
  duration_ms: number | null;
  taken_at: Date;
}

async function loadAsset(assetId: string): Promise<AssetRow | null> {
  const rows = await sql<AssetRow[]>`
    SELECT id, owner_id, type, storage_path, original_filename, duration_ms, taken_at
    FROM assets WHERE id = ${assetId}
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

  const absolute = libraryPath(asset.storage_path);
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

  const absolute = libraryPath(asset.storage_path);
  const outDir = thumbsPath(thumbDir(asset.owner_id, asset.id));

  try {
    if (asset.type === 'video') {
      await generateVideoDerivatives(absolute, outDir, asset.duration_ms);
    } else {
      await generateImageDerivatives(absolute, outDir);
    }
    await sql`UPDATE assets SET thumb_status = 'ready' WHERE id = ${assetId}`;
  } catch (err) {
    // Mark failed so the UI can show a placeholder instead of a spinner
    // forever, then rethrow so the queue applies its retry policy.
    await sql`UPDATE assets SET thumb_status = 'failed' WHERE id = ${assetId}`;
    throw err;
  }

  if (config.ENABLE_ML) {
    await enqueue('embedding', { assetId }, `embedding:${assetId}`);
  }
}

/**
 * Computes the CLIP embedding from the *preview*, not the original: it is
 * already decoded, orientation-corrected and small, and CLIP downsamples to
 * 224px anyway, so the original's extra pixels are pure cost.
 */
async function handleEmbedding(assetId: string): Promise<void> {
  if (!config.ENABLE_ML) return;

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
  const expired = await sql<{ id: string; owner_id: string; storage_path: string }[]>`
    SELECT id, owner_id, storage_path FROM assets
    WHERE deleted_at IS NOT NULL
      AND deleted_at < now() - ${`${config.TRASH_RETENTION_DAYS} days`}::interval
    LIMIT 500
  `;

  for (const row of expired) {
    await deleteAssetFiles(row.owner_id, row.id, row.storage_path);
    await sql`DELETE FROM assets WHERE id = ${row.id}`;
  }

  // Deliberately does NOT re-arm itself. Re-arming from inside the handler
  // cannot use the recurring dedupe key — the current job still holds it — so
  // every run would leak an un-deduped row, and the queue would grow by one
  // job per restart forever. The worker re-enqueues it on a timer instead,
  // where ON CONFLICT DO NOTHING caps it at a single outstanding job.
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
    case 'trash-purge':
      return handleTrashPurge();
    case 'face-detect':
      // Reserved: face detection lands in a later milestone. Consuming the job
      // as a no-op keeps queued rows from failing loudly in the meantime.
      return;
    default:
      throw new Error(`Unknown job type: ${type}`);
  }
}
