import type {
  Album,
  ApiError,
  Asset,
  ExternalLibrary,
  Face,
  FaceStatus,
  Memory,
  Person,
  AuthResponse,
  AuthTokens,
  CreateAlbumRequest,
  Page,
  SearchHit,
  ServerInfo,
  ServerStats,
  ShareLink,
  TimelineBucket,
  UploadCheckResponse,
  UploadResult,
  User,
} from '@aperture/shared';

const STORAGE_KEY = 'aperture.auth';

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the access token stops being valid. */
  expiresAt: number;
}

function readAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  } catch {
    return null;
  }
}

function writeAuth(tokens: AuthTokens | null): void {
  try {
    if (!tokens) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const stored: StoredAuth = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      // Refresh a minute early so a request never races the expiry.
      expiresAt: Date.now() + (tokens.expiresIn - 60) * 1000,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Private browsing with storage disabled: the session simply will not
    // survive a reload, which is acceptable.
  }
}

type AuthListener = (authenticated: boolean) => void;
const listeners = new Set<AuthListener>();

export function onAuthChange(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(authenticated: boolean): void {
  for (const listener of listeners) listener(authenticated);
}

export function isAuthenticated(): boolean {
  return readAuth() !== null;
}

export function getAccessToken(): string | null {
  return readAuth()?.accessToken ?? null;
}

/**
 * Single-flight refresh.
 *
 * Without this, a screen that fires eight thumbnail requests at once on a
 * stale token would kick off eight refreshes, and token rotation means seven
 * of them would fail and log the user out.
 */
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const auth = readAuth();
    if (!auth) return null;

    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken }),
      });

      if (!response.ok) {
        writeAuth(null);
        announce(false);
        return null;
      }

      const tokens = (await response.json()) as AuthTokens;
      writeAuth(tokens);
      return tokens.accessToken;
    } catch {
      // Network failure: keep the stored refresh token so a reconnect can
      // recover the session instead of forcing a sign-in.
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skips the Authorization header (public share endpoints). */
  anonymous?: boolean;
  raw?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, anonymous, raw, headers, ...rest } = options;

  const send = async (token: string | null): Promise<Response> => {
    const finalHeaders = new Headers(headers);
    if (token && !anonymous) finalHeaders.set('Authorization', `Bearer ${token}`);

    let payload: BodyInit | undefined;
    if (body instanceof FormData) {
      // Let the browser set the multipart boundary.
      payload = body;
    } else if (body !== undefined) {
      finalHeaders.set('Content-Type', 'application/json');
      payload = JSON.stringify(body);
    }

    return fetch(`/api${path}`, { ...rest, headers: finalHeaders, body: payload });
  };

  let auth = readAuth();

  // Proactive refresh: cheaper than letting the request 401 and retrying.
  if (!anonymous && auth && auth.expiresAt <= Date.now()) {
    await refreshAccessToken();
    auth = readAuth();
  }

  let response = await send(auth?.accessToken ?? null);

  if (response.status === 401 && !anonymous) {
    const token = await refreshAccessToken();
    if (token) {
      response = await send(token);
    } else {
      writeAuth(null);
      announce(false);
    }
  }

  if (!response.ok) {
    let detail: ApiError | null = null;
    try {
      detail = (await response.json()) as ApiError;
    } catch {
      // Non-JSON error body (a proxy timeout page, say).
    }
    throw new ApiRequestError(
      response.status,
      detail?.error ?? 'request_failed',
      detail?.message ?? `Request failed with status ${response.status}.`,
    );
  }

  if (raw || response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Media URLs
//
// <img> cannot send an Authorization header, so media URLs carry the access
// token as a query parameter. The server only honours it on GET media routes.
// ---------------------------------------------------------------------------

/**
 * Derivative URLs carry a version stamp.
 *
 * The path `/assets/<id>/thumbnail` is stable, but its *content* is not:
 * regenerating thumbnails rewrites the file behind the same URL. Combined with
 * the year-long immutable cache the server sends, a browser that saw the old
 * image would keep showing it essentially forever — which is exactly what
 * happened when a rotation fix silently changed every derivative.
 *
 * Stamping the asset's `updatedAt` into the query string keeps the aggressive
 * caching (worth a lot on a photo grid) while guaranteeing that regenerated
 * derivatives are fetched fresh.
 */
function mediaUrl(path: string, version?: string): string {
  const token = getAccessToken();
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (version) params.set('v', version);
  const query = params.toString();
  return query ? `/api${path}?${query}` : `/api${path}`;
}

/** `version` should be the asset's updatedAt; omitting it risks a stale cache. */
export const assetThumbnailUrl = (id: string, version?: string) =>
  mediaUrl(`/assets/${id}/thumbnail`, version);
export const assetPreviewUrl = (id: string, version?: string) =>
  mediaUrl(`/assets/${id}/preview`, version);
export const assetOriginalUrl = (id: string, version?: string) =>
  mediaUrl(`/assets/${id}/original`, version);
export const assetDownloadUrl = (id: string, version?: string) =>
  `${mediaUrl(`/assets/${id}/original`, version)}&download=true`;

/** Face crops never change once written, so they can be cached hard. */
export const faceThumbnailUrl = (faceId: string) => mediaUrl(`/people/faces/${faceId}/thumbnail`);

export const shareThumbnailUrl = (key: string, id: string) =>
  `/api/public/${key}/asset/${id}/thumbnail`;
export const sharePreviewUrl = (key: string, id: string) =>
  `/api/public/${key}/asset/${id}/preview`;
export const shareOriginalUrl = (key: string, id: string) =>
  `/api/public/${key}/asset/${id}/original`;

// ---------------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------------

export const api = {
  // --- server ---
  serverInfo: () => request<ServerInfo>('/server/info', { anonymous: true }),
  stats: () => request<ServerStats>('/server/stats'),
  users: () => request<User[]>('/server/users'),
  createUser: (body: {
    email: string;
    password: string;
    name: string;
    isAdmin?: boolean;
    quotaBytes?: number | null;
  }) => request<User>('/server/users', { method: 'POST', body }),
  updateUser: (id: string, body: Record<string, unknown>) =>
    request<User>(`/server/users/${id}`, { method: 'PATCH', body }),
  deleteUser: (id: string) => request<void>(`/server/users/${id}`, { method: 'DELETE', raw: true }),
  reindex: (what: 'thumbnails' | 'metadata' | 'embeddings') =>
    request<{ queued: number }>('/server/jobs/reindex', { method: 'POST', body: { what } }),

  memories: (month: number, day: number) =>
    request<Memory[]>(`/assets/memories?month=${month}&day=${day}`),

  writeSidecars: () =>
    request<{ queued: boolean }>('/server/jobs/sidecars', { method: 'POST' }),
  retryJobs: (type?: string) =>
    request<{ requeued: number }>('/server/jobs/retry', { method: 'POST', body: { type } }),

  // --- auth ---
  async login(email: string, password: string): Promise<User> {
    const result = await request<AuthResponse>('/auth/login', {
      method: 'POST',
      anonymous: true,
      body: { email, password, deviceName: navigator.userAgent.slice(0, 100) },
    });
    writeAuth(result);
    announce(true);
    return result.user;
  },

  async register(email: string, password: string, name: string): Promise<User> {
    const result = await request<AuthResponse>('/auth/register', {
      method: 'POST',
      anonymous: true,
      body: { email, password, name, deviceName: navigator.userAgent.slice(0, 100) },
    });
    writeAuth(result);
    announce(true);
    return result.user;
  },

  async logout(): Promise<void> {
    const auth = readAuth();
    if (auth) {
      await request<void>('/auth/logout', {
        method: 'POST',
        body: { refreshToken: auth.refreshToken },
        raw: true,
      }).catch(() => {});
    }
    writeAuth(null);
    announce(false);
  },

  me: () => request<User>('/auth/me'),
  updateMe: (body: { name?: string; password?: string; currentPassword?: string }) =>
    request<User>('/auth/me', { method: 'PATCH', body }),
  sessions: () =>
    request<{ id: string; device_name: string | null; created_at: string; expires_at: string }[]>(
      '/auth/sessions',
    ),
  revokeSession: (id: string) =>
    request<void>(`/auth/sessions/${id}`, { method: 'DELETE', raw: true }),

  // --- assets ---
  timeline: (params: Record<string, string | number | boolean | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== false) query.set(key, String(value));
    }
    return request<Page<Asset>>(`/assets?${query.toString()}`);
  },
  buckets: (params: Record<string, string | boolean | undefined> = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== false) query.set(key, String(value));
    }
    return request<TimelineBucket[]>(`/assets/timeline/buckets?${query.toString()}`);
  },
  asset: (id: string) => request<Asset>(`/assets/${id}`),
  updateAsset: (id: string, body: { isFavorite?: boolean; isArchived?: boolean }) =>
    request<Asset>(`/assets/${id}`, { method: 'PATCH', body }),
  deleteAssets: (ids: string[], permanent = false) =>
    request<void>('/assets/delete', { method: 'POST', body: { ids, permanent }, raw: true }),
  restoreAssets: (ids: string[]) =>
    request<void>('/assets/restore', { method: 'POST', body: { ids }, raw: true }),
  checkUploads: (checksums: string[]) =>
    request<UploadCheckResponse>('/assets/check', { method: 'POST', body: { checksums } }),

  uploadFile: async (file: File, onProgress?: (fraction: number) => void): Promise<UploadResult> => {
    // Prove the bytes are actually readable before opening a connection.
    //
    // A file can be listed but unreadable: a OneDrive/iCloud placeholder that
    // was never downloaded, something on an unmounted network share, or a file
    // moved between being picked and being sent. XHR reports all of those as a
    // generic network error, which sends people hunting for a server problem
    // that does not exist. One byte is enough to tell.
    try {
      await file.slice(0, 1).arrayBuffer();
    } catch {
      throw new ApiRequestError(
        0,
        'file_unreadable',
        `"${file.name}" could not be read from this computer. If it lives in a cloud-synced folder, make it available offline first.`,
      );
    }

    if (file.size === 0) {
      throw new ApiRequestError(0, 'file_empty', `"${file.name}" is empty and was skipped.`);
    }

    // XHR rather than fetch: fetch still cannot report upload progress, and a
    // progress bar matters a lot when someone drops 500 photos into the page.
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('takenAt', new Date(file.lastModified).toISOString());
      form.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/assets/upload');

      const token = getAccessToken();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } else {
          let message = `Upload failed (${xhr.status}).`;
          try {
            message = (JSON.parse(xhr.responseText) as ApiError).message;
          } catch {
            /* keep the generic message */
          }
          reject(new ApiRequestError(xhr.status, 'upload_failed', message));
        }
      });

      xhr.addEventListener('error', () =>
        reject(
          new ApiRequestError(
            0,
            'network_error',
            `Lost the connection while uploading "${file.name}". The server may have restarted, or the file became unreadable mid-transfer.`,
          ),
        ),
      );
      xhr.addEventListener('abort', () =>
        reject(new ApiRequestError(0, 'aborted', 'Upload cancelled.')),
      );

      xhr.send(form);
    });
  },

  // --- albums ---
  albums: () => request<Album[]>('/albums'),
  album: (id: string) => request<Album>(`/albums/${id}`),
  albumAssets: (id: string) => request<Page<Asset>>(`/albums/${id}/assets`),
  createAlbum: (body: CreateAlbumRequest) => request<Album>('/albums', { method: 'POST', body }),
  updateAlbum: (id: string, body: Record<string, unknown>) =>
    request<Album>(`/albums/${id}`, { method: 'PATCH', body }),
  deleteAlbum: (id: string) => request<void>(`/albums/${id}`, { method: 'DELETE', raw: true }),
  addToAlbum: (id: string, assetIds: string[]) =>
    request<{ added: number }>(`/albums/${id}/assets`, { method: 'POST', body: { assetIds } }),
  removeFromAlbum: (id: string, assetIds: string[]) =>
    request<void>(`/albums/${id}/assets`, { method: 'DELETE', body: { assetIds }, raw: true }),
  shareAlbumWith: (id: string, email: string, canEdit = false) =>
    request<Album>(`/albums/${id}/share`, { method: 'POST', body: { email, canEdit } }),

  // --- share links ---
  shareLinks: () => request<ShareLink[]>('/shares'),
  createShareLink: (body: {
    albumId?: string;
    assetId?: string;
    password?: string;
    allowDownload?: boolean;
    expiresAt?: string | null;
  }) => request<ShareLink>('/shares', { method: 'POST', body }),
  deleteShareLink: (id: string) => request<void>(`/shares/${id}`, { method: 'DELETE', raw: true }),

  // --- public share viewing ---
  shareInfo: (key: string) =>
    request<{ requiresPassword: boolean; allowDownload: boolean; isAlbum: boolean; title: string }>(
      `/public/${key}/info`,
      { anonymous: true },
    ),
  shareContents: (key: string, password?: string) =>
    request<{ title: string; allowDownload: boolean; isAlbum: boolean; assets: Asset[] }>(
      `/public/${key}`,
      { anonymous: true, headers: password ? { 'X-Share-Password': password } : undefined },
    ),

  // --- external libraries ---
  libraries: () => request<ExternalLibrary[]>('/libraries'),
  browseLibraries: (path = '') =>
    request<{ root: string; path: string; exists: boolean; directories: string[] }>(
      `/libraries/browse?path=${encodeURIComponent(path)}`,
    ),
  createLibrary: (body: { name: string; path: string }) =>
    request<{ id: string; queued: boolean }>('/libraries', { method: 'POST', body }),
  updateLibrary: (id: string, body: { name?: string; isEnabled?: boolean }) =>
    request<{ updated: boolean }>(`/libraries/${id}`, { method: 'PATCH', body }),
  scanLibrary: (id: string) =>
    request<{ queued: boolean }>(`/libraries/${id}/scan`, { method: 'POST' }),
  deleteLibrary: (id: string) =>
    request<{ removed: number; message: string }>(`/libraries/${id}`, { method: 'DELETE' }),

  // --- people ---
  faceStatus: () => request<FaceStatus>('/people/status'),
  people: () => request<Person[]>('/people'),
  person: (id: string) => request<Person>(`/people/${id}`),
  personAssets: (id: string) => request<Page<Asset>>(`/people/${id}/assets`),
  updatePerson: (id: string, body: { name?: string | null; isHidden?: boolean; coverFaceId?: string }) =>
    request<Person>(`/people/${id}`, { method: 'PATCH', body }),
  mergePeople: (id: string, personIds: string[]) =>
    request<{ merged: number; facesMoved: number }>(`/people/${id}/merge`, {
      method: 'POST',
      body: { personIds },
    }),
  detachFace: (faceId: string) =>
    request<{ personId: string }>(`/people/faces/${faceId}/detach`, { method: 'POST' }),
  facesForAsset: (assetId: string) => request<Face[]>(`/people/faces/by-asset/${assetId}`),
  rescanFaces: (full = false) =>
    request<{ queued: number }>('/people/rescan', { method: 'POST', body: { full } }),

  // --- search ---
  /**
   * Sensitivity is deliberately not defaulted here. The server owns what the
   * threshold means — it has changed units once already, from a raw similarity
   * floor to a margin over a baseline prompt — and a stale copy of that number
   * living in the client silently filtered out every result.
   */
  search: (query: string, threshold?: number) =>
    request<SearchHit[]>('/search', {
      method: 'POST',
      body: threshold === undefined ? { query } : { query, threshold },
    }),
  searchMetadata: (query: string) =>
    request<Asset[]>(`/search/metadata?q=${encodeURIComponent(query)}`),
  searchStatus: () =>
    request<{
      enabled: boolean;
      model: string;
      state: 'disabled' | 'loading' | 'ready' | 'error';
      message: string;
      total: number;
      indexed: number;
      pending: number;
    }>('/search/status'),
};
