-- Index existing folders in place, without copying anything.
--
-- Every asset so far arrived by upload and lives under LIBRARY_PATH. On a NAS
-- that is often the wrong shape: the photos are already there, and duplicating
-- hundreds of gigabytes to browse them is not an acceptable price.

CREATE TABLE external_libraries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,

  -- Absolute path inside the container, always under EXTERNAL_ROOT so a
  -- crafted value cannot reach the rest of the filesystem.
  path         text NOT NULL,

  -- Glob-ish fragments; any path containing one is skipped. Covers the
  -- @eaDir / .thumbnails / Lightroom preview folders NAS shares collect.
  exclusions   text[] NOT NULL DEFAULT ARRAY['@eaDir', '.thumbnails', '.@__thumb', 'Lightroom Previews'],

  is_enabled   boolean NOT NULL DEFAULT true,
  last_scan_at timestamptz,
  last_scan_error text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT external_libraries_owner_path_key UNIQUE (owner_id, path)
);

CREATE TRIGGER external_libraries_touch BEFORE UPDATE ON external_libraries
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- NULL means an uploaded asset living under LIBRARY_PATH; otherwise the file
-- belongs to that library and `storage_path` is relative to the library root.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS library_id uuid
  REFERENCES external_libraries(id) ON DELETE CASCADE;

-- Size and mtime together are a cheap identity check, so a rescan can skip a
-- file without reading it. Hashing every file on every scan would make a
-- 500 GB library unscannable.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_mtime timestamptz;

-- Set when a scan no longer finds the file. Kept rather than deleted so the
-- distinction between "you unplugged the drive" and "you deleted the photo"
-- survives, and so albums and names are not silently lost by a bad mount.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS missing_since timestamptz;

CREATE INDEX assets_library_idx ON assets (library_id) WHERE library_id IS NOT NULL;

-- The scanner's hot lookup: "do I already have this exact path?"
CREATE UNIQUE INDEX assets_library_path_key
  ON assets (library_id, storage_path) WHERE library_id IS NOT NULL;

CREATE INDEX assets_missing_idx ON assets (owner_id) WHERE missing_since IS NOT NULL;
