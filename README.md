# Aperture

Self-hosted photo and video backup for Unraid, with a mobile app that backs up
your camera roll automatically.

An alternative to Immich that is deliberately lighter to run and nicer to look
at: two containers instead of four, no Redis, and a justified timeline that
shows your photos at their real aspect ratios instead of cropping everything
into squares.

```
aperture/
├── server/     Fastify API + background job worker (TypeScript)
├── web/        React web client, built into the server image
├── mobile/     Expo app for iOS and Android
├── shared/     API types the server and web client both compile against
└── docker/     Dockerfile, compose stack, Unraid template
```

---

## What it does

- **Automatic phone backup** — the mobile app uploads new photos and videos in
  the background, with layered de-duplication so a re-scan costs almost nothing.
- **Justified timeline** — rows fill the width edge to edge and every photo
  keeps its aspect ratio. Panoramas stay panoramas.
- **Videos** — stored, thumbnailed via ffmpeg, and streamed with byte-range
  requests so seeking works.
- **Camera RAW** — .ARW, .CR2/.CR3, .NEF, .DNG and friends are stored untouched.
  libvips cannot decode RAW, so previews come from the full-size JPEG the camera
  embeds, extracted with exiftool. You get a real thumbnail and the untouched
  original.
- **Albums and sharing** — share with another account on your server, or mint a
  public link with an optional password and expiry.
- **Natural-language search** — CLIP embeddings in pgvector, so "beach at
  sunset" finds the photo without you ever having tagged it. Optional.
- **People** — faces are detected, grouped, and named. Off by default; turn on
  with `ENABLE_FACES=true`. Optional.
- **Multi-user** — each person's library is private to them; an admin manages
  accounts and quotas.
- **Trash** — deletes are recoverable for 30 days before the bytes are removed.
- **Optional Redis cache** — keeps thumbnails in RAM. Measured ~5x faster to
  serve, and 7x better at the 95th percentile, which is what smooths scrolling.

---

## Quick start on Unraid

### 1. Get the files onto the server

```bash
cd /mnt/user/appdata
git clone <your-repo-url> aperture
cd aperture
```

### 2. Configure

```bash
cp .env.example docker/.env
```

Edit `docker/.env`. Two values must be changed:

```bash
# Generate each of these with: openssl rand -hex 32
JWT_SECRET=...
POSTGRES_PASSWORD=...

# The address your PHONE will use. Not localhost.
PUBLIC_URL=http://tower.local:2283

# Where the photos actually live — an array share you back up.
LIBRARY_PATH=/mnt/user/photos
# Regenerable, so cache/SSD is ideal and it needs no backup.
THUMBS_PATH=/mnt/user/appdata/aperture/thumbs
DB_PATH=/mnt/user/appdata/aperture/db
```

### 3. Start it

```bash
docker compose -f docker/docker-compose.yml up -d
```

Open `http://tower.local:2283`. The first account you create becomes the
administrator. Self-registration is off by default — invite everyone else from
**Settings → People**.

> Prefer the Unraid UI? `docker/aperture.unraid.xml` is a Community
> Applications template for the app container. You still need a
> `pgvector/pgvector:pg17` container alongside it, so the compose file above is
> the easier path.

---

## The mobile app

The app is not on the App Store or Play Store — you build it yourself, which is
the trade for it talking only to your own server.

```bash
cd mobile
npm install
npx expo prebuild          # generates the native projects
npx expo run:android       # or: npx expo run:ios
```

### Building the app yourself

There are two routes, and the cloud one is far less work.

**Cloud (no Android SDK needed).** Builds on Expo's servers and hands back an
installable APK:

```bash
npx eas build --profile preview --platform android
```

**Locally.** `npx expo run:android` needs a full Android toolchain. Android
Studio alone is not enough — an older SDK will fail with
`SDK location not found` or a missing platform. You need:

| | Version | Why |
| --- | --- | --- |
| JDK | 17 or 21 | React Native 0.76 |
| SDK Platform | **android-35** | `compileSdkVersion` |
| Build-Tools | **35.0.0** | |
| NDK | **26.1.10909125** | New Architecture compiles C++ |

Install them from Android Studio's **SDK Manager** (tick *Show Package
Details* to pick exact versions). Then point Gradle at the SDK by creating
`mobile/android/local.properties`:

```
sdk.dir=C:/Users/you/AppData/Local/Android/Sdk
```

Use forward slashes. Java `.properties` treats a backslash as an escape
character, so a Windows path written with single backslashes silently becomes
nonsense. The file is machine-specific and gitignored, along with the whole
generated `android/` directory.

**In the app:** enter your server address (`tower.local:2283` — the scheme is
optional), sign in, then open **Library → Backup** and turn it on.

Four tabs: **Photos, Search, Albums and Library**. Library is the hub — the
people found in your photos, favourites, archive, trash, and the two things you
configure once. Backup progress lives there rather than a screen deeper,
because "is my phone actually backed up?" is the question this app exists to
answer.

Search falls back to filenames and camera details when the server has
`ENABLE_ML=false`, so the tab is never simply dead.

### How reliable is background backup, honestly?

- **Android** — genuinely automatic. Backup runs on a periodic WorkManager job,
  survives the app being swiped away, and resumes after a reboot.
- **iOS** — partly. Apple gives no API that guarantees background execution.
  The app takes whatever opportunistic windows iOS offers (which get more
  frequent the more you use the app) **and** runs a full sync every time you
  open it. In practice: open the app once a day and nothing is ever missed.

Anyone claiming a continuous iOS background uploader is working around this the
same way — with a foreground sync.

---

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3000` | Address the phone and share links use. Must be reachable from your devices. |
| `JWT_SECRET` | — | **Required.** Signs login tokens. Changing it signs everyone out. |
| `DATABASE_URL` | — | **Required.** Postgres connection string; needs the pgvector extension. |
| `ALLOW_REGISTRATION` | `false` | Let anyone who can reach the server create an account. |
| `ENABLE_ML` | `true` | Natural-language search. Off skips a ~250 MB model download and its CPU cost. |
| `ML_MODEL` | `Xenova/clip-vit-base-patch32` | Must be a 512-dim CLIP model to match the database column. |
| `ENABLE_FACES` | `false` | Face detection and people grouping. Adds ~190 MB of models and real CPU per photo. |
| `FACE_MIN_SCORE` | `0.7` | Detector confidence floor. Below ~0.7 you start collecting things that merely look like faces. |
| `FACE_MATCH_THRESHOLD` | `0.38` | Similarity above which two faces are the same person. Higher = stricter. |
| `FACE_MIN_CLUSTER_SIZE` | `2` | Faces a person needs before appearing. Stops one-off strangers becoming people. |
| `JOB_CONCURRENCY` | `3` | Thumbnails/embeddings processed at once. Roughly one per core you'll spare. |
| `TRASH_RETENTION_DAYS` | `30` | How long deleted photos stay recoverable. |
| `MAX_UPLOAD_BYTES` | 8 GiB | Ceiling on a single file. |
| `REDIS_URL` | _(empty)_ | Optional thumbnail cache. Empty means no Redis and everything is served from disk. |
| `REDIS_MAX_MEMORY` | `512mb` | Hard ceiling on the Redis container. It evicts the coldest thumbnails rather than growing. |
| `REDIS_TTL_SECONDS` | 7 days | How long a cached thumbnail lives. |
| `EXTERNAL_ROOT` | `/data/external` | Every external library must live under this path. |

---

## How it works

### Storage layout

```
/data/library/<userId>/<yyyy>/<MM>/<assetId>.jpg   originals, never modified
/data/thumbs/<userId>/<assetId>/thumb.webp         320px  grid tile
/data/thumbs/<userId>/<assetId>/preview.webp       1600px lightbox
/data/tmp/                                         in-flight uploads
```

Originals are written once and never touched again. Everything under
`/data/thumbs` is regenerable from **Settings → Maintenance**, so it does not
need to be in your backup plan — only `/data/library` and the database do.

### De-duplication

Uploads are keyed on the SHA-256 of the file's bytes, hashed on the server as
it streams to disk. `UNIQUE (owner_id, checksum)` makes a re-upload physically
impossible, so the API answers `duplicate: true` instead of storing a second
copy.

The phone layers two caches on top of that, purely for speed:

1. A local ledger of already-uploaded camera-roll ids — the hot path.
2. `GET /api/assets/device/:deviceId`, which rebuilds that ledger after a
   reinstall so a fresh install doesn't re-send a library the server has.

Hashing on the phone was deliberately rejected: reading a 4 GB video into JS to
digest it costs far more than letting the server hash bytes it already receives.

### Capture times

EXIF `DateTimeOriginal` is bare wall-clock text with no timezone. Aperture
re-anchors it so the time you see always matches the time the camera recorded —
whether the server runs in UTC and you're in Berlin, or the other way round.
When a photo does record a UTC offset, that's stored too and used for display.

Without this, an evening photo can slide into the next day's row depending on
where the server happens to live.

### People

Two InsightFace models run through onnxruntime, which the CLIP stack already
pulls in — so faces cost no extra container and no second runtime:

- **SCRFD** (17 MB) finds faces and five landmarks per face.
- **ArcFace** (174 MB) turns each face into a 512-d identity vector.

Between them sits the step that actually decides whether this works: each face
is warped onto a canonical 112×112 layout using those landmarks, so the
recogniser sees every face presented the same way. Feeding it a plain crop
instead is the usual reason home-grown face grouping produces groups that look
arbitrary.

Grouping is incremental rather than a periodic global re-cluster. Each new face
joins the nearest person within the threshold, or starts a new one. That keeps
names stable — a global re-cluster reshuffles membership, and a person you have
named must not silently absorb someone else because you added a holiday album.
The cost is order-dependence, which is what the merge tool in the UI is for.

Note the models are published for non-commercial research use. Fine for a
personal library; check the licence before shipping anything built on it.

### The Redis cache, and what it is not

Redis is optional and holds **only thumbnails and previews** — never your
originals, never the database. That distinction is the whole design:

- Redis keeps everything in RAM, so storing originals there would mean buying
  as much memory as you have photos.
- It is a cache. It evicts under pressure and starts empty after a restart.
  Anything that cannot be regenerated has no business in it.
- Large values block its single event loop while being serialised, which is why
  values above `REDIS_MAX_VALUE_BYTES` are served straight from disk instead.

Everything cached is a copy of a file already on disk, so the cache being cold,
evicted, full or entirely absent only ever costs a little speed. Persistence is
switched off in the compose file for the same reason — writing out a copy of
something already on disk is pure overhead.

Measured locally over 330 requests, warm both ways:

| | mean | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| From disk | 7.2 ms | 6.0 ms | 15.6 ms | 23.7 ms |
| From Redis | 1.5 ms | 1.4 ms | 2.1 ms | 4.2 ms |

The p95 column is the one that matters: tail latency is what you feel as stutter
when a grid fires a few hundred thumbnail requests at once. Expect a bigger gap
on an Unraid array of spinning disks and a smaller one if your thumbnails
already live on an SSD cache pool.

If Redis goes away mid-request the server keeps serving from disk, reports
itself degraded in **Settings**, and reconnects on its own — verified by
killing the container under load.

### Background jobs

The queue is a Postgres table drained with `FOR UPDATE SKIP LOCKED` — no Redis,
one less container, and more than fast enough at photo-library scale. Uploads
return as soon as the bytes are safe on disk; metadata, thumbnails and
embeddings follow behind, so a phone on a slow link is never held open.

---

## Development

```bash
npm install
docker run -d --name aperture-db \
  -e POSTGRES_USER=aperture -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=aperture -p 5432:5432 pgvector/pgvector:pg17

cp .env.example .env      # point DATABASE_URL at localhost:5432
npm run dev               # API on :3000, web on :5173
```

`npm run typecheck` covers all three TypeScript projects. Migrations in
`server/migrations/` are numbered, applied in order inside a transaction, and
recorded in `schema_migrations`; there are no down migrations, because rolling
forward is safer for a system holding irreplaceable data.

---

## Backups

Aperture is where your photos live, so it needs a backup of its own:

- `/data/library` — the originals. Irreplaceable.
- The Postgres volume — albums, favourites, share links, EXIF, users.
  `docker exec aperture-db pg_dump -U aperture aperture | gzip > aperture.sql.gz`
- `/data/thumbs` — skip it. Regenerable in one click.

---

## Licence

MIT.
