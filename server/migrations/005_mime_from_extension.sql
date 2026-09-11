-- Re-derive recorded MIME types from the filename, and trust that over what
-- the uploading client claimed.
--
-- The upload path used to take the client's Content-Type at face value and
-- only consult the extension when that header was missing or generic. Our own
-- backup app sent `image/jpeg` for every photo regardless of what it was, so
-- an iPhone's HEIC was stored as a JPEG. The bytes on disk are fine and the
-- thumbnails are fine — libvips decodes HEIC without complaint — but the web
-- viewer believes `mime_type`, so it offers the original to a browser that
-- cannot decode it and shows nothing. Downloads carry the wrong type too.
--
-- Recomputing from `original_filename` repairs those rows. Only rows whose
-- extension maps to something different are touched, so this is idempotent and
-- leaves correctly-typed assets — including every RAW fixed in 002 — alone.

WITH corrected AS (
  SELECT
    a.id,
    CASE lower(substring(a.original_filename FROM '\.([A-Za-z0-9]+)$'))
      WHEN 'jpg'  THEN 'image/jpeg'
      WHEN 'jpeg' THEN 'image/jpeg'
      WHEN 'png'  THEN 'image/png'
      WHEN 'gif'  THEN 'image/gif'
      WHEN 'webp' THEN 'image/webp'
      WHEN 'heic' THEN 'image/heic'
      WHEN 'heif' THEN 'image/heif'
      WHEN 'avif' THEN 'image/avif'
      WHEN 'tif'  THEN 'image/tiff'
      WHEN 'tiff' THEN 'image/tiff'
      WHEN 'bmp'  THEN 'image/bmp'
      WHEN 'arw'  THEN 'image/x-sony-arw'
      WHEN 'cr2'  THEN 'image/x-canon-cr2'
      WHEN 'cr3'  THEN 'image/x-canon-cr3'
      WHEN 'nef'  THEN 'image/x-nikon-nef'
      WHEN 'nrw'  THEN 'image/x-nikon-nrw'
      WHEN 'dng'  THEN 'image/x-adobe-dng'
      WHEN 'raf'  THEN 'image/x-fuji-raf'
      WHEN 'orf'  THEN 'image/x-olympus-orf'
      WHEN 'rw2'  THEN 'image/x-panasonic-rw2'
      WHEN 'pef'  THEN 'image/x-pentax-pef'
      WHEN 'srw'  THEN 'image/x-samsung-srw'
      WHEN 'mp4'  THEN 'video/mp4'
      WHEN 'm4v'  THEN 'video/x-m4v'
      WHEN 'mov'  THEN 'video/quicktime'
      WHEN 'avi'  THEN 'video/x-msvideo'
      WHEN 'mkv'  THEN 'video/x-matroska'
      WHEN 'webm' THEN 'video/webm'
      WHEN '3gp'  THEN 'video/3gpp'
      WHEN 'mts'  THEN 'video/mp2t'
      WHEN 'm2ts' THEN 'video/mp2t'
      -- Unknown extension: keep whatever is already recorded.
      ELSE a.mime_type
    END AS mime_type
  FROM assets a
)
UPDATE assets a
SET mime_type = c.mime_type,
    -- Derivative URLs carry ?v=updated_at, and clients gate display on the
    -- recorded type. Bumping this makes them re-read rather than sit on a
    -- year-long cached copy of the old answer.
    updated_at = now()
FROM corrected c
WHERE c.id = a.id
  AND c.mime_type IS DISTINCT FROM a.mime_type;

-- `type` is derived from the same evidence, so fix any row where the two
-- disagree — a video recorded as an image never gets a poster frame.
UPDATE assets
SET type = 'video', updated_at = now()
WHERE mime_type LIKE 'video/%' AND type <> 'video';

UPDATE assets
SET type = 'image', updated_at = now()
WHERE mime_type LIKE 'image/%' AND type <> 'image';
