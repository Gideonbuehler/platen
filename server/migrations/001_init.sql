-- Aperture initial schema.
-- pgcrypto gives us gen_random_uuid(); vector powers semantic search.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Users & sessions
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name          text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  -- NULL means unlimited. Enforced on upload against the sum of owned assets.
  quota_bytes   bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens are stored hashed so a database leak cannot be replayed.
CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  device_name  text,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Assets
-- ---------------------------------------------------------------------------

CREATE TYPE asset_type AS ENUM ('image', 'video');
CREATE TYPE derivative_status AS ENUM ('pending', 'ready', 'failed');

CREATE TABLE assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- sha256 of the original bytes. The uniqueness constraint below is what
  -- makes repeated phone scans idempotent: same bytes, same row.
  checksum          bytea NOT NULL,

  type              asset_type NOT NULL,
  original_filename text NOT NULL,
  -- Path relative to LIBRARY_PATH, e.g. "<user>/2026/09/<uuid>.jpg".
  storage_path      text NOT NULL,
  mime_type         text NOT NULL,
  file_size         bigint NOT NULL,

  width             integer,
  height            integer,
  duration_ms       integer,
  orientation       smallint NOT NULL DEFAULT 1,

  -- Capture time. Falls back to file mtime when EXIF has nothing.
  taken_at          timestamptz NOT NULL,
  taken_at_offset   text,

  is_favorite       boolean NOT NULL DEFAULT false,
  is_archived       boolean NOT NULL DEFAULT false,
  deleted_at        timestamptz,

  thumb_status      derivative_status NOT NULL DEFAULT 'pending',

  -- Lets a phone recognise its own uploads without hashing every file again.
  device_id         text,
  device_asset_id   text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assets_owner_checksum_key UNIQUE (owner_id, checksum)
);

-- The timeline is always "this user, newest first, not trashed". A partial
-- index keeps trashed and archived rows out of the hot path entirely.
CREATE INDEX assets_timeline_idx
  ON assets (owner_id, taken_at DESC, id DESC)
  WHERE deleted_at IS NULL AND is_archived = false;

CREATE INDEX assets_owner_deleted_idx ON assets (owner_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX assets_favorite_idx ON assets (owner_id, taken_at DESC) WHERE is_favorite = true AND deleted_at IS NULL;
CREATE INDEX assets_device_idx ON assets (owner_id, device_id, device_asset_id) WHERE device_asset_id IS NOT NULL;
CREATE INDEX assets_thumb_pending_idx ON assets (thumb_status) WHERE thumb_status = 'pending';

-- EXIF lives in its own table: it is wide, mostly NULL, and only read on the
-- detail view. Keeping it out of `assets` keeps the timeline scan narrow.
CREATE TABLE asset_exif (
  asset_id      uuid PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  make          text,
  model         text,
  lens          text,
  f_number      real,
  exposure_time text,
  iso           integer,
  focal_length  real,
  latitude      double precision,
  longitude     double precision,
  altitude      double precision,
  city          text,
  state         text,
  country       text,
  raw           jsonb
);
CREATE INDEX asset_exif_gps_idx ON asset_exif (latitude, longitude) WHERE latitude IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Albums
-- ---------------------------------------------------------------------------

CREATE TABLE albums (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  description    text,
  cover_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX albums_owner_idx ON albums(owner_id, updated_at DESC);

CREATE TABLE album_assets (
  album_id uuid NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (album_id, asset_id)
);
CREATE INDEX album_assets_asset_idx ON album_assets(asset_id);

-- In-app sharing, distinct from the public links below.
CREATE TABLE album_users (
  album_id uuid NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_edit boolean NOT NULL DEFAULT false,
  PRIMARY KEY (album_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Public share links
-- ---------------------------------------------------------------------------

CREATE TABLE share_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key            text NOT NULL UNIQUE,
  album_id       uuid REFERENCES albums(id) ON DELETE CASCADE,
  asset_id       uuid REFERENCES assets(id) ON DELETE CASCADE,
  password_hash  text,
  allow_download boolean NOT NULL DEFAULT true,
  expires_at     timestamptz,
  view_count     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Exactly one target: an album or a single asset, never both or neither.
  CONSTRAINT share_links_one_target CHECK (
    (album_id IS NOT NULL) != (asset_id IS NOT NULL)
  )
);

-- ---------------------------------------------------------------------------
-- Machine learning: semantic search and faces
-- ---------------------------------------------------------------------------

-- CLIP ViT-B/32 produces 512-dim embeddings, L2-normalised on write so that
-- inner product equals cosine similarity.
CREATE TABLE asset_embeddings (
  asset_id   uuid PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  embedding  vector(512) NOT NULL,
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- HNSW beats IVFFlat here: no training step, and recall stays high as the
-- library grows without a periodic REINDEX.
CREATE INDEX asset_embeddings_hnsw_idx
  ON asset_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE people (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text,
  cover_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  is_hidden      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX people_owner_idx ON people(owner_id);

CREATE TABLE faces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id   uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  person_id  uuid REFERENCES people(id) ON DELETE SET NULL,
  -- Normalised 0..1 box so it survives any later re-encode.
  bbox_x     real NOT NULL,
  bbox_y     real NOT NULL,
  bbox_w     real NOT NULL,
  bbox_h     real NOT NULL,
  embedding  vector(512),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX faces_asset_idx ON faces(asset_id);
CREATE INDEX faces_person_idx ON faces(person_id);

-- ---------------------------------------------------------------------------
-- Job queue
-- ---------------------------------------------------------------------------
-- Postgres-backed rather than Redis-backed: one less container on Unraid, and
-- FOR UPDATE SKIP LOCKED is more than fast enough at photo-library scale.

CREATE TYPE job_status AS ENUM ('pending', 'active', 'failed', 'done');

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       job_status NOT NULL DEFAULT 'pending',
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_at       timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- One outstanding job of a given type per asset; re-queueing is a no-op.
  dedupe_key   text UNIQUE
);
CREATE INDEX jobs_claim_idx ON jobs (status, run_at) WHERE status = 'pending';
CREATE INDEX jobs_stale_idx ON jobs (locked_at) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Key/value server settings, editable from the admin UI
-- ---------------------------------------------------------------------------

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch  BEFORE UPDATE ON users  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER assets_touch BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER albums_touch BEFORE UPDATE ON albums FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
