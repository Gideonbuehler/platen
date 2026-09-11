import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { getAccessToken, getServerUrl } from './api';

/**
 * Automatic camera-roll backup.
 *
 * Dedupe is layered, cheapest first:
 *
 *  1. A local ledger of MediaLibrary asset ids that have already been uploaded.
 *     This is the hot path and makes a re-scan of a 40k-photo roll almost free.
 *  2. The server's `device_asset_id` index, fetched once after a reinstall to
 *     rebuild the ledger without re-sending a single byte.
 *  3. The server's sha256 uniqueness constraint, which is authoritative. Even
 *     if both caches are wrong, the same photo can never be stored twice.
 *
 * Hashing files on the phone was deliberately rejected: reading a 4 GB video
 * into JS to digest it is far more expensive than letting the server hash the
 * bytes it is already receiving.
 */

const KEYS = {
  enabled: 'platen.backup.enabled',
  wifiOnly: 'platen.backup.wifiOnly',
  includeVideos: 'platen.backup.includeVideos',
  ledger: 'platen.backup.ledger',
  deviceId: 'platen.backup.deviceId',
  lastRun: 'platen.backup.lastRun',
  stats: 'platen.backup.stats',
} as const;

export interface BackupSettings {
  enabled: boolean;
  wifiOnly: boolean;
  includeVideos: boolean;
}

export interface BackupStats {
  uploaded: number;
  skipped: number;
  failed: number;
  lastRun: string | null;
  /** Assets on the device that are not yet on the server. */
  pending: number;
  total: number;
}

export interface BackupProgress {
  current: number;
  total: number;
  filename: string;
}

// --- settings ---------------------------------------------------------------

export async function getSettings(): Promise<BackupSettings> {
  const [enabled, wifiOnly, includeVideos] = await Promise.all([
    AsyncStorage.getItem(KEYS.enabled),
    AsyncStorage.getItem(KEYS.wifiOnly),
    AsyncStorage.getItem(KEYS.includeVideos),
  ]);
  return {
    enabled: enabled === 'true',
    // Default on: nobody wants to discover their holiday videos ate a data plan.
    wifiOnly: wifiOnly === null ? true : wifiOnly === 'true',
    includeVideos: includeVideos === null ? true : includeVideos === 'true',
  };
}

export async function setSettings(patch: Partial<BackupSettings>): Promise<void> {
  const entries: [string, string][] = [];
  if (patch.enabled !== undefined) entries.push([KEYS.enabled, String(patch.enabled)]);
  if (patch.wifiOnly !== undefined) entries.push([KEYS.wifiOnly, String(patch.wifiOnly)]);
  if (patch.includeVideos !== undefined) {
    entries.push([KEYS.includeVideos, String(patch.includeVideos)]);
  }
  if (entries.length > 0) await AsyncStorage.multiSet(entries);
}

// --- device identity --------------------------------------------------------

/** A stable id for this install, so the server can group this phone's uploads. */
export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(KEYS.deviceId);
  if (!id) {
    id = `${Platform.OS}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await AsyncStorage.setItem(KEYS.deviceId, id);
  }
  return id;
}

// --- ledger -----------------------------------------------------------------

async function readLedger(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.ledger);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

async function writeLedger(ledger: Set<string>): Promise<void> {
  await AsyncStorage.setItem(KEYS.ledger, JSON.stringify([...ledger]));
}

/**
 * Rebuilds the ledger from the server after a reinstall, so a fresh install
 * does not re-upload a library the server already has.
 */
export async function syncLedgerFromServer(): Promise<number> {
  const [base, token, deviceId] = await Promise.all([
    getServerUrl(),
    getAccessToken(),
    getDeviceId(),
  ]);
  if (!base || !token) return 0;

  try {
    const response = await fetch(
      `${base}/api/assets/device/${encodeURIComponent(deviceId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) return 0;

    const { deviceAssetIds } = (await response.json()) as { deviceAssetIds: string[] };
    const ledger = await readLedger();
    for (const id of deviceAssetIds) ledger.add(id);
    await writeLedger(ledger);
    return deviceAssetIds.length;
  } catch {
    return 0;
  }
}

// --- permissions ------------------------------------------------------------

export async function ensurePermission(): Promise<boolean> {
  const current = await MediaLibrary.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const requested = await MediaLibrary.requestPermissionsAsync();
  return requested.granted;
}

// --- scanning ---------------------------------------------------------------

/** Every asset on the device, oldest first so a backup fills in chronologically. */
async function listDeviceAssets(includeVideos: boolean): Promise<MediaLibrary.Asset[]> {
  const mediaType: MediaLibrary.MediaTypeValue[] = includeVideos
    ? [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video]
    : [MediaLibrary.MediaType.photo];

  const all: MediaLibrary.Asset[] = [];
  let after: string | undefined;
  let hasNextPage = true;

  while (hasNextPage) {
    const page = await MediaLibrary.getAssetsAsync({
      mediaType,
      first: 200,
      after,
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    });
    all.push(...page.assets);
    after = page.endCursor;
    hasNextPage = page.hasNextPage;
  }

  return all;
}

export async function getStats(): Promise<BackupStats> {
  const [settings, ledger, lastRun, statsRaw] = await Promise.all([
    getSettings(),
    readLedger(),
    AsyncStorage.getItem(KEYS.lastRun),
    AsyncStorage.getItem(KEYS.stats),
  ]);

  const stored = statsRaw
    ? (JSON.parse(statsRaw) as { uploaded: number; skipped: number; failed: number })
    : { uploaded: 0, skipped: 0, failed: 0 };

  let total = 0;
  let pending = 0;

  if (await MediaLibrary.getPermissionsAsync().then((p) => p.granted)) {
    const assets = await listDeviceAssets(settings.includeVideos);
    total = assets.length;
    pending = assets.filter((asset) => !ledger.has(asset.id)).length;
  }

  return { ...stored, lastRun, pending, total };
}

// --- upload -----------------------------------------------------------------

interface UploadOutcome {
  ok: boolean;
  duplicate: boolean;
  error?: string;
}

/**
 * Registered types for everything a camera roll can hold.
 *
 * This used to be `video/mp4` or `image/jpeg` and nothing else, which quietly
 * corrupted every iPhone upload: a HEIC arrived labelled JPEG, was recorded as
 * JPEG, and then the web viewer handed the browser HEIC bytes it had been told
 * were a JPEG. Thumbnails looked fine the whole time, so nothing surfaced until
 * someone opened a photo full-size.
 *
 * The server now prefers the file extension over this header, so the two would
 * have to be wrong together to matter — but sending the truth costs nothing and
 * covers the case where a URI arrives with no extension at all.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  dng: 'image/x-adobe-dng',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
};

function guessMimeType(filename: string, isVideo: boolean): string {
  // Strip any query or fragment a content:// URI may carry before reading the
  // extension, or "IMG_1.HEIC?width=100" yields an extension of "heic?width=100".
  const clean = filename.split(/[?#]/)[0] ?? '';
  const ext = clean.toLowerCase().split('.').pop() ?? '';
  return MIME_BY_EXTENSION[ext] ?? (isVideo ? 'video/mp4' : 'image/jpeg');
}

async function uploadAsset(
  asset: MediaLibrary.Asset,
  base: string,
  token: string,
  deviceId: string,
): Promise<UploadOutcome> {
  // On iOS the `uri` is a ph:// reference that cannot be read directly; only
  // getAssetInfoAsync resolves it to a real file. On Android it is already a
  // file:// path, but going through the same call keeps one code path.
  const info = await MediaLibrary.getAssetInfoAsync(asset, { shouldDownloadFromNetwork: true });
  const localUri = info.localUri ?? asset.uri;

  if (!localUri) {
    // Typically an iCloud asset that has not been downloaded and could not be
    // fetched — worth retrying on a later run rather than marking as done.
    return { ok: false, duplicate: false, error: 'File not available on this device' };
  }

  // `asset.filename` is the name the camera gave the file ("IMG_1234.HEIC");
  // the local URI can be a temp copy, so prefer the former and fall back.
  const isVideo = asset.mediaType === MediaLibrary.MediaType.video;
  const mimeType = guessMimeType(asset.filename || localUri, isVideo);

  try {
    const result = await FileSystem.uploadAsync(`${base}/api/assets/upload`, localUri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      mimeType,
      parameters: {
        takenAt: new Date(asset.creationTime).toISOString(),
        deviceId,
        deviceAssetId: asset.id,
      },
      headers: { Authorization: `Bearer ${token}` },
    });

    if (result.status >= 200 && result.status < 300) {
      const body = JSON.parse(result.body) as { duplicate?: boolean };
      return { ok: true, duplicate: body.duplicate === true };
    }

    let message = `Server returned ${result.status}`;
    try {
      message = (JSON.parse(result.body) as { message?: string }).message ?? message;
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, duplicate: false, error: message };
  } catch (err) {
    return {
      ok: false,
      duplicate: false,
      error: err instanceof Error ? err.message : 'Upload failed',
    };
  }
}

export interface RunOptions {
  onProgress?: (progress: BackupProgress) => void;
  /** Caps a background run so the OS does not kill us mid-upload. */
  maxItems?: number;
  signal?: { cancelled: boolean };
}

export interface RunResult {
  uploaded: number;
  skipped: number;
  failed: number;
  remaining: number;
}

/**
 * Uploads everything on the device that is not already on the server.
 *
 * Safe to call repeatedly and safe to interrupt: the ledger is written after
 * each success, so a run that is killed halfway resumes exactly where it left
 * off rather than starting over.
 */
export async function runBackup(options: RunOptions = {}): Promise<RunResult> {
  const { onProgress, maxItems, signal } = options;

  const [settings, base, token, deviceId] = await Promise.all([
    getSettings(),
    getServerUrl(),
    getAccessToken(),
    getDeviceId(),
  ]);

  if (!base || !token) return { uploaded: 0, skipped: 0, failed: 0, remaining: 0 };
  if (!(await ensurePermission())) return { uploaded: 0, skipped: 0, failed: 0, remaining: 0 };

  const ledger = await readLedger();
  const assets = await listDeviceAssets(settings.includeVideos);
  const queue = assets.filter((asset) => !ledger.has(asset.id));

  const batch = maxItems ? queue.slice(0, maxItems) : queue;

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < batch.length; i++) {
    if (signal?.cancelled) break;

    const asset = batch[i]!;
    onProgress?.({ current: i + 1, total: batch.length, filename: asset.filename });

    const outcome = await uploadAsset(asset, base, token, deviceId);

    if (outcome.ok) {
      // "Already on the server" counts as backed up — that is the whole point
      // of the checksum constraint, and re-offering it every run is pointless.
      if (outcome.duplicate) skipped++;
      else uploaded++;

      ledger.add(asset.id);
      // Persist as we go. Batching this would mean a killed background task
      // loses its record of work that genuinely completed.
      await writeLedger(ledger);
    } else {
      failed++;
    }
  }

  await AsyncStorage.multiSet([
    [KEYS.lastRun, new Date().toISOString()],
    [KEYS.stats, JSON.stringify({ uploaded, skipped, failed })],
  ]);

  return { uploaded, skipped, failed, remaining: queue.length - batch.length };
}

/** Clears the local ledger so the next run re-offers everything. The server
 *  still refuses duplicates, so this costs bandwidth but never data. */
export async function resetLedger(): Promise<void> {
  await AsyncStorage.removeItem(KEYS.ledger);
}
