import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type {
  Album,
  Asset,
  AuthResponse,
  AuthTokens,
  FaceStatus,
  Memory,
  Page,
  Person,
  SearchHit,
  SearchStatus,
  ServerInfo,
  User,
} from '../types';

/**
 * API client for the mobile app.
 *
 * Two storage tiers on purpose:
 *  - tokens go to SecureStore (Keychain / EncryptedSharedPreferences), because
 *    a refresh token is a 60-day credential for someone's entire photo library;
 *  - the server URL goes to AsyncStorage, because the background upload task
 *    needs it and SecureStore is not reliably readable from a background task
 *    on a locked iOS device.
 */

const SERVER_URL_KEY = 'platen.serverUrl';
const ACCESS_TOKEN_KEY = 'platen.accessToken';
const REFRESH_TOKEN_KEY = 'platen.refreshToken';
const EXPIRES_AT_KEY = 'platen.expiresAt';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// --- server URL -------------------------------------------------------------

let cachedServerUrl: string | null = null;

/** Normalises what people type: adds a scheme, strips a trailing slash. */
export function normaliseServerUrl(input: string): string {
  let url = input.trim();
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

export async function getServerUrl(): Promise<string | null> {
  if (cachedServerUrl) return cachedServerUrl;
  cachedServerUrl = await AsyncStorage.getItem(SERVER_URL_KEY);
  return cachedServerUrl;
}

export async function setServerUrl(url: string): Promise<void> {
  cachedServerUrl = normaliseServerUrl(url);
  await AsyncStorage.setItem(SERVER_URL_KEY, cachedServerUrl);
}

// --- tokens -----------------------------------------------------------------

async function readTokens(): Promise<{ access: string; refresh: string; expiresAt: number } | null> {
  const [access, refresh, expiresAt] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
    SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
    SecureStore.getItemAsync(EXPIRES_AT_KEY),
  ]);
  if (!access || !refresh) return null;
  return { access, refresh, expiresAt: Number(expiresAt ?? 0) };
}

async function writeTokens(tokens: AuthTokens | null): Promise<void> {
  if (!tokens) {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.deleteItemAsync(EXPIRES_AT_KEY),
    ]);
    return;
  }
  // Refresh a minute early so an in-flight upload never dies on a 401.
  const expiresAt = Date.now() + (tokens.expiresIn - 60) * 1000;
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_TOKEN_KEY, tokens.accessToken),
    SecureStore.setItemAsync(REFRESH_TOKEN_KEY, tokens.refreshToken),
    SecureStore.setItemAsync(EXPIRES_AT_KEY, String(expiresAt)),
  ]);
}

export async function isSignedIn(): Promise<boolean> {
  return (await readTokens()) !== null;
}

let refreshInFlight: Promise<string | null> | null = null;

/** Single-flight refresh: a screenful of thumbnails must not rotate the token
 *  a dozen times in parallel, since rotation invalidates the previous one. */
async function refreshTokens(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const tokens = await readTokens();
      const base = await getServerUrl();
      if (!tokens || !base) return null;

      const response = await fetch(`${base}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refresh }),
      });

      if (!response.ok) {
        // Only clear on an explicit rejection. A 5xx or a captive-portal
        // response should not sign someone out of their own server.
        if (response.status === 401 || response.status === 403) await writeTokens(null);
        return null;
      }

      const next = (await response.json()) as AuthTokens;
      await writeTokens(next);
      return next.accessToken;
    } catch {
      return null; // offline; keep the session for when the network returns
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** A valid access token, refreshed if needed. Used by the upload task too. */
export async function getAccessToken(): Promise<string | null> {
  const tokens = await readTokens();
  if (!tokens) return null;
  if (tokens.expiresAt > Date.now()) return tokens.access;
  return refreshTokens();
}

// --- request ----------------------------------------------------------------

interface RequestOptions {
  method?: string;
  body?: unknown;
  anonymous?: boolean;
  raw?: boolean;
  /** Overrides the stored server URL, for validating one before signing in. */
  baseUrl?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const base = options.baseUrl ?? (await getServerUrl());
  if (!base) throw new ApiError(0, 'No server configured. Add your server address first.');

  const send = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (token && !options.anonymous) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    // A hung request on a flaky home network should fail fast, not hang the UI.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      return await fetch(`${base}/api${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  let response: Response;
  try {
    response = await send(options.anonymous ? null : await getAccessToken());
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(0, 'The server took too long to respond. Is it reachable from this network?');
    }
    throw new ApiError(0, 'Could not reach the server. Check the address and your connection.');
  }

  if (response.status === 401 && !options.anonymous) {
    const token = await refreshTokens();
    if (token) response = await send(token);
  }

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      message = ((await response.json()) as { message?: string }).message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(response.status, message);
  }

  if (options.raw || response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --- media URLs -------------------------------------------------------------

/**
 * expo-image cannot attach an Authorization header, so media URLs carry the
 * token as a query parameter. The server accepts it only on GET media routes.
 */
export async function mediaUrl(path: string): Promise<string> {
  const [base, token] = await Promise.all([getServerUrl(), getAccessToken()]);
  if (!base) return '';
  return `${base}/api${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

export const thumbnailUrl = (id: string) => mediaUrl(`/assets/${id}/thumbnail`);
export const faceThumbnailUrl = (faceId: string) => mediaUrl(`/people/faces/${faceId}/thumbnail`);
export const previewUrl = (id: string) => mediaUrl(`/assets/${id}/preview`);
export const originalUrl = (id: string) => mediaUrl(`/assets/${id}/original`);

// --- endpoints --------------------------------------------------------------

export const api = {
  /** Validates a URL before we ask for credentials — a far better error than
   *  "login failed" when someone typos the address. */
  serverInfo: (baseUrl?: string) =>
    request<ServerInfo>('/server/info', { anonymous: true, baseUrl }),

  async login(email: string, password: string, deviceName: string): Promise<User> {
    const result = await request<AuthResponse>('/auth/login', {
      method: 'POST',
      anonymous: true,
      body: { email, password, deviceName },
    });
    await writeTokens(result);
    return result.user;
  },

  async register(email: string, password: string, name: string, deviceName: string): Promise<User> {
    const result = await request<AuthResponse>('/auth/register', {
      method: 'POST',
      anonymous: true,
      body: { email, password, name, deviceName },
    });
    await writeTokens(result);
    return result.user;
  },

  async logout(): Promise<void> {
    const tokens = await readTokens();
    if (tokens) {
      await request<void>('/auth/logout', {
        method: 'POST',
        body: { refreshToken: tokens.refresh },
        raw: true,
      }).catch(() => {});
    }
    await writeTokens(null);
  },

  me: () => request<User>('/auth/me'),

  timeline: (cursor?: string, limit = 60) =>
    request<Page<Asset>>(`/assets?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),

  favorites: (cursor?: string) =>
    request<Page<Asset>>(`/assets?favorite=true&limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),

  asset: (id: string) => request<Asset>(`/assets/${id}`),

  updateAsset: (id: string, body: { isFavorite?: boolean }) =>
    request<Asset>(`/assets/${id}`, { method: 'PATCH', body }),

  deleteAssets: (ids: string[]) =>
    request<void>('/assets/delete', { method: 'POST', body: { ids }, raw: true }),

  /**
   * Today's date in earlier years. The date is the phone's, not the server's —
   * a NAS in UTC and a phone in Chicago disagree about what day it is for six
   * hours out of every twenty-four, and being a day out is the whole bug on a
   * feature whose premise is "today".
   */
  memories: () => {
    const now = new Date();
    return request<Memory[]>(`/assets/memories?month=${now.getMonth() + 1}&day=${now.getDate()}`);
  },

  albums: () => request<Album[]>('/albums'),
  albumAssets: (id: string) => request<Page<Asset>>(`/albums/${id}/assets`),

  archived: (cursor?: string) =>
    request<Page<Asset>>(
      `/assets?archived=true&limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  trashed: (cursor?: string) =>
    request<Page<Asset>>(
      `/assets?trashed=true&limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  restoreAssets: (ids: string[]) =>
    request<void>('/assets/restore', { method: 'POST', body: { ids }, raw: true }),

  // --- search ---
  searchStatus: () => request<SearchStatus>('/search/status'),
  search: (query: string) => request<SearchHit[]>('/search', { method: 'POST', body: { query } }),
  searchMetadata: (query: string) =>
    request<Asset[]>(`/search/metadata?q=${encodeURIComponent(query)}`),

  // --- people ---
  faceStatus: () => request<FaceStatus>('/people/status'),
  people: () => request<Person[]>('/people'),
  person: (id: string) => request<Person>(`/people/${id}`),
  personAssets: (id: string) => request<Page<Asset>>(`/people/${id}/assets`),
  updatePerson: (id: string, body: { name?: string | null }) =>
    request<Person>(`/people/${id}`, { method: 'PATCH', body }),

  // --- albums ---
  album: (id: string) => request<Album>(`/albums/${id}`),
  createAlbum: (name: string, assetIds?: string[]) =>
    request<Album>('/albums', { method: 'POST', body: { name, assetIds } }),

  /** Which of these checksums does the server already have? */
  checkUploads: (checksums: string[]) =>
    request<{ existing: Record<string, string> }>('/assets/check', {
      method: 'POST',
      body: { checksums },
    }),
};
