/**
 * API shapes the mobile app uses.
 *
 * These mirror `shared/src/index.ts`, which is the source of truth — the server
 * and the web client compile against it directly. The app keeps its own copy
 * rather than consuming the workspace package because Metro's monorepo
 * resolution adds real fragility for very little gain at this size.
 *
 * If you change a field in the shared contract, change it here too.
 */

export type AssetType = 'image' | 'video';
export type DerivativeStatus = 'pending' | 'ready' | 'failed';

export interface User {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  quotaBytes: number | null;
  usageBytes: number;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthResponse extends AuthTokens {
  user: User;
}

export interface ServerInfo {
  name: string;
  version: string;
  apiVersion: number;
  needsOnboarding: boolean;
  allowRegistration: boolean;
  features: { ml: boolean; video: boolean; sharing: boolean };
}

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
  durationMs: number | null;
  takenAt: string;
  takenAtOffset: string | null;
  isFavorite: boolean;
  isArchived: boolean;
  deletedAt: string | null;
  thumbStatus: DerivativeStatus;
  checksum: string;
  exif: AssetExif | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface Album {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  coverAssetId: string | null;
  assetCount: number;
  sharedWith: { id: string; name: string; email: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface Person {
  id: string;
  name: string | null;
  coverFaceId: string | null;
  faceCount: number;
  assetCount: number;
  isHidden: boolean;
  createdAt: string;
}

export interface SearchHit {
  asset: Asset;
  /** Cosine similarity, 0..1. */
  score: number;
}

export interface SearchStatus {
  enabled: boolean;
  model: string;
  state: 'disabled' | 'loading' | 'ready' | 'error';
  message: string;
  total: number;
  indexed: number;
  pending: number;
}

export interface FaceStatus {
  enabled: boolean;
  state: 'disabled' | 'loading' | 'ready' | 'error';
  message: string;
  scanned: number;
  total: number;
  pending: number;
  people: number;
  faces: number;
}
