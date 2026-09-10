import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import exifr from 'exifr';
import sharp from 'sharp';
import { PREVIEW_SIZE, THUMB_SIZE } from '../config.js';

// Concurrency is governed by the job worker; sharp's own pool would otherwise
// spawn one thread per core per image and thrash a NAS CPU.
sharp.concurrency(1);
sharp.cache({ files: 0 });

export interface MediaMetadata {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  orientation: number;
  takenAt: Date | null;
  takenAtOffset: string | null;
  exif: {
    make: string | null;
    model: string | null;
    lens: string | null;
    fNumber: number | null;
    exposureTime: string | null;
    iso: number | null;
    focalLength: number | null;
    latitude: number | null;
    longitude: number | null;
    altitude: number | null;
  };
}

const emptyExif = (): MediaMetadata['exif'] => ({
  make: null,
  model: null,
  lens: null,
  fNumber: null,
  exposureTime: null,
  iso: null,
  focalLength: null,
  latitude: null,
  longitude: null,
  altitude: null,
});

/** "1/250" reads better than "0.004" in the info panel. */
function formatExposure(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}s`;
  return `1/${Math.round(1 / seconds)}`;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Converts an EXIF capture time to a real UTC instant.
 *
 * EXIF `DateTimeOriginal` is bare wall-clock text with no zone — "2026:07:14
 * 18:32:11" means "the camera's clock read 18:32". exifr revives that using the
 * *server's* timezone, so an identical photo imported on a UTC NAS and on a
 * laptop in New York would land four hours apart, and an evening shot could
 * slide into the next day's timeline section.
 *
 * So we take the wall-clock components back out and re-anchor them:
 *  - with a known offset (OffsetTimeOriginal, newer phones): subtract it to get
 *    the true instant, and keep the offset so clients can show local time;
 *  - without one: store the wall clock as UTC and record no offset. Clients
 *    render offset-less assets in UTC, which shows exactly what the camera said.
 *
 * Either way the time on screen matches the time on the camera.
 */
function exifDateToUtc(value: unknown, offset: string | null): Date | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;

  const wallClockMs = Date.UTC(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
    value.getSeconds(),
    value.getMilliseconds(),
  );

  if (!offset) return new Date(wallClockMs);

  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim());
  if (!match) return new Date(wallClockMs);

  const sign = match[1] === '-' ? -1 : 1;
  const offsetMinutes = sign * (Number(match[2]) * 60 + Number(match[3]));
  return new Date(wallClockMs - offsetMinutes * 60_000);
}

export async function readImageMetadata(path: string): Promise<MediaMetadata> {
  const result: MediaMetadata = {
    width: null,
    height: null,
    durationMs: null,
    orientation: 1,
    takenAt: null,
    takenAtOffset: null,
    exif: emptyExif(),
  };

  // Dimensions come from sharp: it understands more formats than the EXIF
  // header claims to, and it is authoritative for what we will actually render.
  try {
    const meta = await sharp(path).metadata();
    result.orientation = meta.orientation ?? 1;
    // Orientations 5-8 mean the stored pixels are rotated 90 degrees.
    const swap = result.orientation >= 5;
    result.width = (swap ? meta.height : meta.width) ?? null;
    result.height = (swap ? meta.width : meta.height) ?? null;
  } catch {
    // Not an image sharp can decode (HEIC without libheif, RAW, etc).
    // EXIF may still work, and the thumbnail job will report the real failure.
  }

  try {
    const tags = await exifr.parse(path, {
      tiff: true,
      exif: true,
      gps: true,
      translateValues: true,
      reviveValues: true,
    });

    if (tags) {
      result.exif = {
        make: str(tags.Make),
        model: str(tags.Model),
        lens: str(tags.LensModel ?? tags.LensMake),
        fNumber: num(tags.FNumber),
        exposureTime: formatExposure(tags.ExposureTime),
        iso: num(tags.ISO ?? tags.ISOSpeedRatings),
        focalLength: num(tags.FocalLength),
        latitude: num(tags.latitude),
        longitude: num(tags.longitude),
        altitude: num(tags.GPSAltitude),
      };

      result.takenAtOffset = str(tags.OffsetTimeOriginal ?? tags.OffsetTime);
      const taken = tags.DateTimeOriginal ?? tags.CreateDate ?? tags.ModifyDate;
      result.takenAt = exifDateToUtc(taken, result.takenAtOffset);

      // sharp could not open the file (RAW), so fall back to the dimensions the
      // camera recorded. Without these the grid has no aspect ratio to lay the
      // tile out with and every RAW would be boxed at a default 3:2.
      if (result.width === null || result.height === null) {
        const exifWidth = num(tags.ImageWidth ?? tags.ExifImageWidth ?? tags.PixelXDimension);
        const exifHeight = num(tags.ImageHeight ?? tags.ExifImageHeight ?? tags.PixelYDimension);
        if (exifWidth && exifHeight) {
          const swap = result.orientation >= 5;
          result.width = swap ? exifHeight : exifWidth;
          result.height = swap ? exifWidth : exifHeight;
        }
      }
    }
  } catch {
    // Files with no EXIF at all (screenshots, PNGs) land here. Not an error.
  }

  return result;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  side_data_list?: { rotation?: number }[];
  tags?: Record<string, string>;
}

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} could not be started: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Runs a command and streams its stdout straight to a file.
 *
 * `run()` accumulates stdout into a string, which silently corrupts binary
 * payloads — exactly what we are extracting here. Returns the number of bytes
 * written so the caller can reject an empty result.
 */
function runToFile(cmd: string, args: string[], outPath: string, timeoutMs = 60_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out = createWriteStream(outPath);
    let stderr = '';
    let written = 0;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      written += chunk.length;
    });
    child.stdout.pipe(out);
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      clearTimeout(timer);
      out.destroy();
      reject(new Error(`${cmd} could not be started: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      out.end(() => {
        if (code === 0) resolve(written);
        else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-300)}`));
      });
    });
  });
}

/**
 * Camera RAW formats. libvips cannot decode any of these, so anything in this
 * list goes down the embedded-preview path rather than straight to sharp.
 */
const RAW_EXTENSIONS = new Set([
  '.arw', '.cr2', '.cr3', '.nef', '.nrw', '.dng', '.raf', '.orf', '.rw2',
  '.pef', '.srw', '.3fr', '.erf', '.kdc', '.mrw', '.x3f', '.raw', '.rwl',
]);

export const isRawExtension = (filename: string): boolean =>
  RAW_EXTENSIONS.has(extname(filename).toLowerCase());

/**
 * Pulls the JPEG that virtually every RAW file carries inside it.
 *
 * Cameras embed a full-size (or near-full-size) JPEG so their own screens can
 * display the shot, and that is far and away the cheapest correct way to build
 * a thumbnail: it is already demosaiced and has the manufacturer's colour
 * rendering applied, which a generic decoder would not reproduce anyway.
 *
 * Tags are tried largest-first. Sony and Canon use JpgFromRaw, most others use
 * PreviewImage, and ThumbnailImage is the small last resort.
 */
export async function extractEmbeddedPreview(sourcePath: string): Promise<string | null> {
  const tags = ['-JpgFromRaw', '-PreviewImage', '-OtherImage', '-ThumbnailImage'];

  for (const tag of tags) {
    const outPath = join(tmpdir(), `${randomUUID()}.jpg`);
    try {
      const bytes = await runToFile('exiftool', ['-b', tag, sourcePath], outPath);

      // exiftool exits 0 with no output when the tag is absent, so size is the
      // real test. Anything under 1 KB is not a usable preview.
      if (bytes > 1024) return outPath;
      await rm(outPath, { force: true });
    } catch {
      await rm(outPath, { force: true });
      // exiftool missing entirely, or this tag failed — try the next one.
    }
  }

  return null;
}

export async function readVideoMetadata(path: string): Promise<MediaMetadata> {
  const result: MediaMetadata = {
    width: null,
    height: null,
    durationMs: null,
    orientation: 1,
    takenAt: null,
    takenAtOffset: null,
    exif: emptyExif(),
  };

  const raw = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    path,
  ]);

  const probe = JSON.parse(raw) as {
    streams?: FfprobeStream[];
    format?: { duration?: string; tags?: Record<string, string> };
  };

  const video = probe.streams?.find((s) => s.codec_type === 'video');
  if (video) {
    const rotation = Math.abs(video.side_data_list?.[0]?.rotation ?? 0) % 180;
    const swap = rotation === 90;
    result.width = (swap ? video.height : video.width) ?? null;
    result.height = (swap ? video.width : video.height) ?? null;
  }

  const duration = Number(probe.format?.duration ?? video?.duration);
  if (Number.isFinite(duration)) result.durationMs = Math.round(duration * 1000);

  // Phones write capture time to different tags depending on vendor.
  const tags = { ...probe.format?.tags, ...video?.tags };
  const created =
    tags['creation_time'] ??
    tags['com.apple.quicktime.creationdate'] ??
    tags['date'];
  if (created) {
    const parsed = new Date(created);
    if (!Number.isNaN(parsed.getTime())) result.takenAt = parsed;
  }

  const location = tags['com.apple.quicktime.location.ISO6709'] ?? tags['location'];
  if (location) {
    // Format is like "+37.7858-122.4064+010.000/"
    const match = location.match(/([+-]\d+\.?\d*)([+-]\d+\.?\d*)/);
    if (match?.[1] && match[2]) {
      result.exif.latitude = Number(match[1]);
      result.exif.longitude = Number(match[2]);
    }
  }

  result.exif.make = str(tags['com.apple.quicktime.make'] ?? tags['make']);
  result.exif.model = str(tags['com.apple.quicktime.model'] ?? tags['model']);

  return result;
}

export interface Derivatives {
  thumbPath: string;
  previewPath: string;
}

/**
 * Writes the two WebP derivatives every client reads.
 *
 * WebP at q80/q82 is roughly 30% smaller than equivalent JPEG and is supported
 * everywhere we care about (iOS 14+, Android 4.3+, all current browsers).
 * `.rotate()` with no argument applies the EXIF orientation and strips the tag,
 * so downstream consumers never have to think about it again.
 */
export async function generateImageDerivatives(
  sourcePath: string,
  outputDir: string,
): Promise<Derivatives> {
  await mkdir(outputDir, { recursive: true });

  const thumbPath = join(outputDir, 'thumb.webp');
  const previewPath = join(outputDir, 'preview.webp');

  // libvips cannot decode camera RAW, so those are rendered from the JPEG the
  // camera embedded. Anything else goes straight to sharp; if sharp turns out
  // not to understand it either, we still try the embedded preview before
  // giving up, since plenty of odd formats carry one.
  let decodeFrom = sourcePath;
  let extracted: string | null = null;

  if (isRawExtension(sourcePath)) {
    extracted = await extractEmbeddedPreview(sourcePath);
    if (!extracted) {
      throw new Error(
        `${extname(sourcePath)} is a RAW format with no embedded preview this server could read. ` +
          'The original is stored safely, but no thumbnail can be generated.',
      );
    }
    decodeFrom = extracted;
  }

  try {
    const render = async (from: string): Promise<void> => {
      const input = () => sharp(from, { failOn: 'none', limitInputPixels: 1_000_000_000 }).rotate();

      await input()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toFile(thumbPath);

      await input()
        .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toFile(previewPath);
    };

    try {
      await render(decodeFrom);
    } catch (err) {
      if (extracted) throw err; // already the fallback path; nothing left to try

      const rescue = await extractEmbeddedPreview(sourcePath);
      if (!rescue) throw err;

      extracted = rescue;
      await render(rescue);
    }

    return { thumbPath, previewPath };
  } finally {
    if (extracted) await rm(extracted, { force: true });
  }
}

/**
 * Grabs a representative frame and runs it through the same derivative path as
 * a still, so video tiles and photo tiles look identical in the grid.
 *
 * Seeks to 1s (or the midpoint of a shorter clip) because frame 0 of a phone
 * video is very often a black or motion-blurred frame.
 */
export async function generateVideoDerivatives(
  sourcePath: string,
  outputDir: string,
  durationMs: number | null,
): Promise<Derivatives> {
  await mkdir(outputDir, { recursive: true });
  const framePath = join(tmpdir(), `${randomUUID()}.png`);

  const seekSeconds = durationMs && durationMs < 2000 ? durationMs / 2000 : 1;

  try {
    await run('ffmpeg', [
      '-v', 'error',
      '-ss', seekSeconds.toFixed(2),
      '-i', sourcePath,
      '-frames:v', '1',
      '-an',
      '-y',
      framePath,
    ]);

    // A seek past the end of a very short clip produces no output at all.
    const info = await stat(framePath).catch(() => null);
    if (!info || info.size === 0) {
      await run('ffmpeg', ['-v', 'error', '-i', sourcePath, '-frames:v', '1', '-an', '-y', framePath]);
    }

    return await generateImageDerivatives(framePath, outputDir);
  } finally {
    await rm(framePath, { force: true });
  }
}

export async function hasFfmpeg(): Promise<boolean> {
  try {
    await run('ffprobe', ['-version'], 10_000);
    return true;
  } catch {
    return false;
  }
}
