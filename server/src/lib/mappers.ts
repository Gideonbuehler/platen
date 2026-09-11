import type { Asset, AssetExif } from '@platen/shared';

/** Shape returned by the asset SELECTs across the route layer. */
export interface AssetRow {
  id: string;
  owner_id: string;
  type: 'image' | 'video';
  original_filename: string;
  mime_type: string;
  file_size: string | number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  taken_at: Date;
  taken_at_offset: string | null;
  is_favorite: boolean;
  is_archived: boolean;
  deleted_at: Date | null;
  thumb_status: 'pending' | 'ready' | 'failed';
  checksum: Buffer | Uint8Array;
  created_at: Date;
  updated_at: Date;
  /** Internal only — never surfaced in the DTO. */
  storage_path: string;
  /** Null for uploaded assets; set when the file lives in an external library. */
  library_id: string | null;
  /** Joined from external_libraries when the query includes it. */
  library_root?: string | null;

  // Present only when the query LEFT JOINs asset_exif.
  make?: string | null;
  model?: string | null;
  lens?: string | null;
  f_number?: number | null;
  exposure_time?: string | null;
  iso?: number | null;
  focal_length?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

/**
 * The asset columns every query needs, optionally table-qualified.
 *
 * Built as a function rather than two hand-maintained string constants so that
 * a SELECT (which needs the `a.` prefix) and a RETURNING (which must not have
 * one) can never drift apart.
 */
export function assetColumns(prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  return [
    'id', 'owner_id', 'type', 'original_filename', 'mime_type', 'file_size',
    'width', 'height', 'duration_ms', 'taken_at', 'taken_at_offset',
    'is_favorite', 'is_archived', 'deleted_at', 'thumb_status', 'checksum',
    'storage_path', 'library_id', 'created_at', 'updated_at',
  ]
    .map((c) => `${p}${c}`)
    .join(', ');
}

/** Adds the EXIF columns; only valid when the query LEFT JOINs asset_exif. */
export function assetColumnsWithExif(prefix = 'a', exifPrefix = 'e'): string {
  const e = `${exifPrefix}.`;
  return `${assetColumns(prefix)}, ${e}make, ${e}model, ${e}lens, ${e}f_number, ` +
    `${e}exposure_time, ${e}iso, ${e}focal_length, ${e}latitude, ${e}longitude, ` +
    `${e}city, ${e}state, ${e}country`;
}

function hasExif(row: AssetRow): boolean {
  return 'make' in row;
}

function buildExif(row: AssetRow): AssetExif | null {
  if (!hasExif(row)) return null;
  return {
    make: row.make ?? null,
    model: row.model ?? null,
    lens: row.lens ?? null,
    fNumber: row.f_number ?? null,
    exposureTime: row.exposure_time ?? null,
    iso: row.iso ?? null,
    focalLength: row.focal_length ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    country: row.country ?? null,
  };
}

export function toAssetDto(row: AssetRow): Asset {
  return {
    id: row.id,
    ownerId: row.owner_id,
    type: row.type,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    takenAt: row.taken_at.toISOString(),
    takenAtOffset: row.taken_at_offset,
    isFavorite: row.is_favorite,
    isArchived: row.is_archived,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    thumbStatus: row.thumb_status,
    checksum: Buffer.from(row.checksum).toString('hex'),
    exif: buildExif(row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
