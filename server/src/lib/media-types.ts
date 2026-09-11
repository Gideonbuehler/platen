import { badRequest } from './errors.js';

/**
 * Extension to media type. Every value is a real registered type — naively
 * building `image/<ext>` once produced nonsense like "image/arw", which
 * browsers refuse to render and which makes a downloaded original open in the
 * wrong application.
 */
export const EXTENSION_MIMES: Record<string, { type: 'image' | 'video'; mime: string }> = {
  // Images
  jpg: { type: 'image', mime: 'image/jpeg' },
  jpeg: { type: 'image', mime: 'image/jpeg' },
  png: { type: 'image', mime: 'image/png' },
  gif: { type: 'image', mime: 'image/gif' },
  webp: { type: 'image', mime: 'image/webp' },
  heic: { type: 'image', mime: 'image/heic' },
  heif: { type: 'image', mime: 'image/heif' },
  avif: { type: 'image', mime: 'image/avif' },
  tif: { type: 'image', mime: 'image/tiff' },
  tiff: { type: 'image', mime: 'image/tiff' },
  bmp: { type: 'image', mime: 'image/bmp' },

  // RAW
  arw: { type: 'image', mime: 'image/x-sony-arw' },
  cr2: { type: 'image', mime: 'image/x-canon-cr2' },
  cr3: { type: 'image', mime: 'image/x-canon-cr3' },
  nef: { type: 'image', mime: 'image/x-nikon-nef' },
  nrw: { type: 'image', mime: 'image/x-nikon-nrw' },
  dng: { type: 'image', mime: 'image/x-adobe-dng' },
  raf: { type: 'image', mime: 'image/x-fuji-raf' },
  orf: { type: 'image', mime: 'image/x-olympus-orf' },
  rw2: { type: 'image', mime: 'image/x-panasonic-rw2' },
  pef: { type: 'image', mime: 'image/x-pentax-pef' },
  srw: { type: 'image', mime: 'image/x-samsung-srw' },

  // Video
  mp4: { type: 'video', mime: 'video/mp4' },
  m4v: { type: 'video', mime: 'video/x-m4v' },
  mov: { type: 'video', mime: 'video/quicktime' },
  avi: { type: 'video', mime: 'video/x-msvideo' },
  mkv: { type: 'video', mime: 'video/x-matroska' },
  webm: { type: 'video', mime: 'video/webm' },
  '3gp': { type: 'video', mime: 'video/3gpp' },
  mts: { type: 'video', mime: 'video/mp2t' },
  m2ts: { type: 'video', mime: 'video/mp2t' },
};

const IMAGE_MIME = /^image\//;
const VIDEO_MIME = /^video\//;

/** Lowercase extension of a filename, without the dot. Empty when there is none. */
export function extensionOf(filename: string): string {
  // Strip any query or fragment first, or a content:// URI like
  // "IMG_1.HEIC?width=100" yields an extension of "heic?width=100".
  const clean = filename.split(/[?#]/)[0] ?? '';
  const lastDot = clean.lastIndexOf('.');
  const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  if (lastDot <= lastSlash + 1) return '';
  return clean.slice(lastDot + 1).toLowerCase();
}

/**
 * Decide what an uploaded file actually is.
 *
 * The extension wins over the client's Content-Type, which is the opposite of
 * the obvious ordering and is deliberate: clients lie. Our own backup uploader
 * labelled every photo `image/jpeg` regardless of what it was, so an iPhone's
 * HEIC arrived claiming to be a JPEG and was stored that way. Nothing caught
 * it, because the thumbnail pipeline decodes HEIC happily — it surfaced only
 * when the web viewer trusted the recorded type, handed the browser HEIC bytes
 * labelled JPEG, and rendered nothing.
 *
 * An extension travels with the file and is written by whatever produced it; a
 * request header is written by whatever is uploading it. The first is the
 * better evidence, so it goes first, and the header stays as the fallback for
 * files that arrive with no usable extension at all.
 */
export function classify(
  mimeType: string,
  filename: string,
): { type: 'image' | 'video'; mime: string } {
  const known = EXTENSION_MIMES[extensionOf(filename)];
  if (known) return known;

  if (IMAGE_MIME.test(mimeType)) return { type: 'image', mime: mimeType };
  if (VIDEO_MIME.test(mimeType)) return { type: 'video', mime: mimeType };

  throw badRequest(`Unsupported file type: ${filename}`);
}
