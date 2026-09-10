/**
 * Aperture API contract.
 *
 * This module is the single source of truth for every shape that crosses the
 * network. The server, the web client and the mobile app all compile against
 * it, so a breaking change here fails the build in all three places at once —
 * which is exactly what we want.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type AssetType = 'image' | 'video';

/** Lifecycle of the derived files (thumbnail / preview) for an asset. */
export type DerivativeStatus = 'pending' | 'ready' | 'failed';

/** ISO-8601 timestamp string. Always UTC on the wire. */
export type IsoDate = string;

export const API_VERSION = 1;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  /** null means "no quota"; bytes otherwise. */
  quotaBytes: number | null;
  usageBytes: number;
  createdAt: IsoDate;
}

export interface LoginRequest {
  email: string;
  password: string;
  /** Free-text label so users can identify sessions in settings. */
  deviceName?: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface AuthTokens {
  accessToken: string;
  /** Opaque; exchange at POST /api/auth/refresh. */
  refreshToken: string;
  /** Seconds until accessToken expires. */
  expiresIn: number;
}

export interface AuthResponse extends AuthTokens {
  user: User;
}

/** Returned by GET /api/server/info — unauthenticated, used by the mobile app
 *  to validate a server URL before asking for credentials. */
export interface ServerInfo {
  name: string;
  version: string;
  apiVersion: number;
  /** True until the first (admin) account exists. Drives first-run setup. */
  needsOnboarding: boolean;
  allowRegistration: boolean;
  features: {
    ml: boolean;
    video: boolean;
    sharing: boolean;
  };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface AssetExif {
  make: string | null;
  model: string | null;
  lens: string | null;
  fNumber: number | null;
  exposureTime: string | null;
  iso: number | null;
  focalLength: number | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface Asset {
  id: string;
  ownerId: string;
  type: AssetType;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  /** Video length in milliseconds; null for stills. */
  durationMs: number | null;
  /** Best known capture time: EXIF DateTimeOriginal, else file mtime. */
  takenAt: IsoDate;
  /** Original UTC offset as "+02:00", when the file recorded one. */
  takenAtOffset: string | null;
  isFavorite: boolean;
  isArchived: boolean;
  /** Set when the asset is in the trash; purged by a background job. */
  deletedAt: IsoDate | null;
  thumbStatus: DerivativeStatus;
  /** sha256 of the original bytes, hex. Clients use this to skip re-uploads. */
  checksum: string;
  exif: AssetExif | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** A day-bucketed slice of the timeline. The web grid asks for buckets lazily
 *  so a 200k-photo library never ships 200k rows to the browser. */
export interface TimelineBucket {
  /** "2026-09-09" — local date of the bucket. */
  date: string;
  count: number;
}

export interface TimelineQuery {
  albumId?: string;
  personId?: string;
  favorite?: boolean;
  archived?: boolean;
  trashed?: boolean;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Clients call this before uploading bytes. The server answers which checksums
 * it already has, so the phone can skip files that are already backed up —
 * this is what makes re-scans cheap.
 */
export interface UploadCheckRequest {
  checksums: string[];
}

export interface UploadCheckResponse {
  /** Map of checksum -> existing asset id for the ones already stored. */
  existing: Record<string, string>;
}

export interface UploadResult {
  asset: Asset;
  /** True when the checksum already existed and no new bytes were written. */
  duplicate: boolean;
}

// ---------------------------------------------------------------------------
// Albums & sharing
// ---------------------------------------------------------------------------

export interface Album {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  coverAssetId: string | null;
  assetCount: number;
  /** Users this album has been shared with in-app (not public links). */
  sharedWith: Pick<User, 'id' | 'name' | 'email'>[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface CreateAlbumRequest {
  name: string;
  description?: string;
  assetIds?: string[];
}

export interface ShareLink {
  id: string;
  /** URL-safe key; the public URL is {PUBLIC_URL}/s/{key}. */
  key: string;
  albumId: string | null;
  assetId: string | null;
  hasPassword: boolean;
  allowDownload: boolean;
  expiresAt: IsoDate | null;
  viewCount: number;
  createdAt: IsoDate;
}

export interface CreateShareLinkRequest {
  albumId?: string;
  assetId?: string;
  password?: string;
  allowDownload?: boolean;
  expiresAt?: IsoDate | null;
}

// ---------------------------------------------------------------------------
// Search (ML)
// ---------------------------------------------------------------------------

export interface SearchRequest {
  /** Natural language for semantic search, e.g. "beach at sunset". */
  query: string;
  /** 0..1 — lower keeps more, noisier results. */
  threshold?: number;
  limit?: number;
}

export interface SearchHit {
  asset: Asset;
  /** Cosine similarity, 0..1. */
  score: number;
}

export interface Person {
  id: string;
  name: string | null;
  /** Face whose crop is used as the avatar; null until one is generated. */
  coverFaceId: string | null;
  faceCount: number;
  /** Distinct photos this person appears in. */
  assetCount: number;
  isHidden: boolean;
  createdAt: IsoDate;
}

/** A detected face, positioned relative to the asset's preview (0..1). */
export interface Face {
  id: string;
  assetId: string;
  personId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  isConfirmed: boolean;
}

export interface FaceStatus {
  enabled: boolean;
  state: 'disabled' | 'loading' | 'ready' | 'error';
  message: string;
  /** Photos scanned for faces, out of those eligible. */
  scanned: number;
  total: number;
  pending: number;
  people: number;
  faces: number;
}

// ---------------------------------------------------------------------------
// Jobs / server health
// ---------------------------------------------------------------------------

export type JobType =
  | 'metadata'
  | 'thumbnail'
  | 'video-poster'
  | 'embedding'
  | 'face-detect'
  | 'trash-purge';

export interface JobStats {
  type: JobType;
  pending: number;
  active: number;
  failed: number;
}

export interface ServerStats {
  users: number;
  assets: number;
  photos: number;
  videos: number;
  usageBytes: number;
  jobs: JobStats[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

// ---------------------------------------------------------------------------
// Paged responses
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page; null when the list is exhausted. */
  nextCursor: string | null;
  total?: number;
}
