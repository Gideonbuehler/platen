-- Face detection and people grouping.
--
-- The `faces` and `people` tables were created in 001 as placeholders. This
-- fills in what the working implementation actually needs.

-- Detector confidence, kept so a later pass can re-filter without re-running
-- detection, and so the UI can show the least certain matches first.
ALTER TABLE faces ADD COLUMN IF NOT EXISTS score real NOT NULL DEFAULT 1;

-- The five landmarks the detector returns, normalised 0..1 alongside the box.
-- Stored because re-aligning a crop is otherwise impossible without re-running
-- the detector over the whole library.
ALTER TABLE faces ADD COLUMN IF NOT EXISTS landmarks jsonb;

-- Relative path of the cropped face image under THUMBS_PATH.
ALTER TABLE faces ADD COLUMN IF NOT EXISTS thumb_path text;

-- Set when a person is confirmed by hand, so clustering never reassigns it.
ALTER TABLE faces ADD COLUMN IF NOT EXISTS is_confirmed boolean NOT NULL DEFAULT false;

ALTER TABLE people ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- The face this person's avatar is taken from.
ALTER TABLE people ADD COLUMN IF NOT EXISTS cover_face_id uuid REFERENCES faces(id) ON DELETE SET NULL;

-- Clustering asks "which known face is nearest to this one?" for every new
-- face, so this index is the difference between instant and a full scan.
CREATE INDEX IF NOT EXISTS faces_embedding_hnsw_idx
  ON faces USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- Owner scoping for the people list, and for "who is in this photo".
CREATE INDEX IF NOT EXISTS faces_person_asset_idx ON faces (person_id, asset_id);

CREATE TRIGGER people_touch BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Tracks whether an asset has been through face detection, independently of
-- whether any face was found — otherwise a photo of a landscape would be
-- re-scanned on every pass forever.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS faces_scanned_at timestamptz;
CREATE INDEX IF NOT EXISTS assets_faces_pending_idx
  ON assets (owner_id) WHERE faces_scanned_at IS NULL AND deleted_at IS NULL;
