-- Files whose rows are already gone.
--
-- Deleting a user cascades away every one of their asset rows in the same
-- statement, and the trash purge only finds files through those rows, so a
-- deleted user's originals stayed on disk forever with nothing pointing at
-- them. The paths are now recorded here in the same transaction as the delete,
-- and the file-purge job removes them from disk.
--
-- No foreign keys on purpose: the owner and the asset no longer exist.
CREATE TABLE file_deletions (
  id           bigserial PRIMARY KEY,
  owner_id     uuid NOT NULL,
  asset_id     uuid NOT NULL,
  -- Relative to LIBRARY_PATH, or to the external library root when external.
  storage_path text NOT NULL,
  -- External originals are the user's own files: only their derivatives go.
  is_external  boolean NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
