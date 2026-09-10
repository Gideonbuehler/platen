-- Correct the MIME types recorded for camera RAW files.
--
-- The first upload path built these as `image/<extension>`, producing values
-- like "image/arw" that are not registered types. That is what a browser sees
-- in Content-Type when downloading an original, so it decides the file is
-- something it cannot handle and the wrong application opens it.
--
-- Idempotent: only rows still holding a bogus value are touched.

UPDATE assets SET mime_type = 'image/x-sony-arw'      WHERE mime_type = 'image/arw';
UPDATE assets SET mime_type = 'image/x-canon-cr2'     WHERE mime_type = 'image/cr2';
UPDATE assets SET mime_type = 'image/x-canon-cr3'     WHERE mime_type = 'image/cr3';
UPDATE assets SET mime_type = 'image/x-nikon-nef'     WHERE mime_type = 'image/nef';
UPDATE assets SET mime_type = 'image/x-nikon-nrw'     WHERE mime_type = 'image/nrw';
UPDATE assets SET mime_type = 'image/x-adobe-dng'     WHERE mime_type = 'image/dng';
UPDATE assets SET mime_type = 'image/x-fuji-raf'      WHERE mime_type = 'image/raf';
UPDATE assets SET mime_type = 'image/x-olympus-orf'   WHERE mime_type = 'image/orf';
UPDATE assets SET mime_type = 'image/x-panasonic-rw2' WHERE mime_type = 'image/rw2';
UPDATE assets SET mime_type = 'image/x-pentax-pef'    WHERE mime_type = 'image/pef';
UPDATE assets SET mime_type = 'image/x-samsung-srw'   WHERE mime_type = 'image/srw';

-- Any RAW that failed to thumbnail before embedded-preview extraction existed
-- deserves another attempt now that exiftool is in the image. Re-running the
-- metadata job also backfills the dimensions those rows are missing.
INSERT INTO jobs (type, payload, dedupe_key)
SELECT 'metadata', jsonb_build_object('assetId', id), 'metadata:' || id
FROM assets
WHERE thumb_status = 'failed'
ON CONFLICT (dedupe_key) DO NOTHING;

UPDATE assets SET thumb_status = 'pending' WHERE thumb_status = 'failed';
