// Kept free of React Native imports so it runs under plain Node in tests.

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

export function guessMimeType(filename: string, isVideo: boolean): string {
  // Strip any query or fragment a content:// URI may carry before reading the
  // extension, or "IMG_1.HEIC?width=100" yields an extension of "heic?width=100".
  const clean = filename.split(/[?#]/)[0] ?? '';
  const ext = clean.toLowerCase().split('.').pop() ?? '';
  return MIME_BY_EXTENSION[ext] ?? (isVideo ? 'video/mp4' : 'image/jpeg');
}
