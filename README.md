<p align="center">
  <img src="branding/platen-mark.svg" width="112" alt="Platen">
</p>

# Platen

[![CI](https://github.com/Gideonbuehler/platen/actions/workflows/ci.yml/badge.svg)](https://github.com/Gideonbuehler/platen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Self-hosted photo and video backup for Unraid, with a mobile app that backs up
your camera roll automatically.

An alternative to Immich that is deliberately lighter to run and nicer to look
at: two required containers instead of four, Redis as an optional cache rather
than a dependency, and a justified timeline that shows your photos at their
real aspect ratios instead of cropping everything into squares.

```
platen/
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
  public link with an optional password and expiry. A public link shows only
  your own photos, never ones a collaborator added to the album.
- **Natural-language search** — CLIP embeddings in pgvector, so "beach at
  sunset" finds the photo without you ever having tagged it. Optional.
- **People** — faces are detected, grouped, and named. Off by default; turn on
  with `ENABLE_FACES=true`. Optional.
- **Multi-user** — each person's library is private to them; an admin manages
  accounts and quotas.
- **Trash** — deletes are recoverable for 30 days before the bytes are removed.
- **Optional Redis cache** — keeps thumbnails in RAM. Measured ~5x faster to
  serve, and 7x better at the 95th percentile, which is what smooths scrolling.
  The compose file runs it by default; drop the service and blank `REDIS_URL`
  for a two-container install.

---

## Quick start on Unraid

### 1. Get the files onto the server

```bash
cd /mnt/user/appdata
git clone <your-repo-url> platen
cd platen
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
THUMBS_PATH=/mnt/user/appdata/platen/thumbs
DB_PATH=/mnt/user/appdata/platen/db
```

### 3. Start it

```bash
docker compose -f docker/docker-compose.yml up -d
```

Open `http://tower.local:2283`. The first account you create becomes the
administrator. Self-registration is off by default — invite everyone else from
**Settings → People**.

The server runs as `PUID:PGID` (99:100, Unraid's `nobody:users`, unless you
set otherwise), so the files it writes belong to the same owner as everything
else on your shares. Earlier builds ran as root: on the first start after
upgrading, the container hands the library, thumbnail and temp folders to that
user. That is a one-off recursive `chown`, so a large library on spinning disks
can take a few minutes to come up that once.

> Prefer the Unraid UI? `docker/platen.unraid.xml` is a Community
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
| `REDIS_URL` | `redis://platen-redis:6379` in the compose file, empty otherwise | Optional thumbnail cache. Empty means no Redis and everything is served from disk. |
| `REDIS_MAX_MEMORY` | `512mb` | Hard ceiling on the Redis container. It evicts the coldest thumbnails rather than growing. |
| `REDIS_TTL_SECONDS` | 7 days | How long a cached thumbnail lives. |
| `EXTERNAL_ROOT` | `/data/external` | Every external library must live under this path. |
| `PUID` / `PGID` | `99` / `100` | User and group the server runs as, and so the owner of every file it writes. 99:100 is Unraid's `nobody:users`; elsewhere use the owner of your photo folders. |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Which peers may report the client's IP in `X-Forwarded-For`. The default trusts a reverse proxy on the same host or LAN. `true` trusts everyone, which lets any client dodge the login rate limit. |

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

EXIF `DateTimeOriginal` is bare wall-clock text with no timezone. Platen
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
docker run -d --name platen-db \
  -e POSTGRES_USER=platen -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=platen -p 5432:5432 pgvector/pgvector:pg17

cp .env.example .env      # point DATABASE_URL at localhost:5432
npm run dev               # API on :3000, web on :5173
```

`npm run typecheck` covers all three TypeScript projects, `npm run lint` all
four (the mobile app included), and `npm test` runs the unit tests; the mobile
app has its own under `cd mobile && npm test`. The integration tests drive the real API against a real
Postgres, so they need a database they are allowed to wipe:

```bash
docker run -d --name platen-test-db -e POSTGRES_USER=platen \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=platen_test -p 5433:5432 \
  pgvector/pgvector:pg17

TEST_DATABASE_URL=postgres://platen:dev@localhost:5433/platen_test \
  npm run test:integration
```

Every test file drops and recreates that database's schema, so never point
`TEST_DATABASE_URL` at a database you care about.

Migrations in
`server/migrations/` are numbered, applied in order inside a transaction, and
recorded in `schema_migrations`; there are no down migrations, because rolling
forward is safer for a system holding irreplaceable data.

---

## Backups

Platen is where your photos live, so it needs a backup of its own:

- `/data/library` — the originals. Irreplaceable.
- The Postgres volume — albums, favourites, share links, EXIF, users.
  `docker exec platen-db pg_dump -U platen platen | gzip > platen.sql.gz`
- `/data/thumbs` — skip it. Regenerable in one click.

### If you lose the database

Originals are stored as `<id>.jpg`, so the filenames on disk carry nothing.
Without help, losing Postgres would leave a correctly-dated pile of UUIDs: no
names, no albums, no favourites.

So every original has a small JSON sidecar written beside it recording its real
filename, checksum, capture time, EXIF, album membership and any named people.
Copying a date folder carries the descriptions with it. It is reconciled daily,
and Settings shows when it last ran.

To rebuild from the files alone:

```bash
docker exec platen sh -c 'cd /app/server && node dist/tools/restore-from-sidecars.js'
```

That reports what it found and changes nothing. Add `--apply` to write the rows,
and `--verify` to re-hash every file against its recorded checksum first — slow,
but it tells you whether the bytes are still intact as well as still present.

Two caveats. Accounts are not recreated, because a sidecar holds no password:
create the users first with the same email addresses. And face recognition
cannot come back this way — the embeddings are not in the sidecars — so re-run
detection and name the groups again. The tool prints the old names to work from.

---

## Branding

The mark is a split P: a bar for the plate and a separate frame for the film
pressed against it, with a 3:2 opening, the proportions of a 35mm frame. Every
icon (app, adaptive, themed, splash, favicon, the Unraid template's) is
generated from one set of coordinates in `branding/render.mjs`:

```bash
npm run brand
```

Change the geometry there and regenerate rather than editing the PNGs. The web
logo in `web/src/components/Icons.tsx` carries a copy of the same path.

## Licence

MIT. See [LICENSE](LICENSE).

## Releases

Images are published to the GitHub Container Registry when a `v*` tag is
pushed:

```bash
docker pull ghcr.io/gideonbuehler/platen:latest
```

Each release also publishes `X.Y.Z` and `X.Y`, so pinning to a minor version
picks up patches without ever jumping a minor version unasked. Builds are
`linux/amd64` only, which is what Unraid runs.
