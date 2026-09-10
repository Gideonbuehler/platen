# syntax=docker/dockerfile:1

# =============================================================================
# Build stage — compiles shared types, the API and the web client
# =============================================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy manifests first so `npm ci` is cached until a dependency actually
# changes. Source edits then rebuild in seconds instead of re-installing.
COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY web/package.json ./web/

# sharp and argon2 ship prebuilt binaries; python3/make/g++ are the fallback
# for any platform without them (notably arm64 in some CI runners).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm ci --include=optional

COPY shared ./shared
COPY server ./server
COPY web ./web

# Order matters: web and server both import the compiled shared types.
RUN npm run build -w shared \
    && npm run build -w server \
    && npm run build -w web

# Reinstall without dev dependencies so only runtime packages are copied on.
RUN npm ci --omit=dev --include=optional && npm cache clean --force

# =============================================================================
# Runtime stage
# =============================================================================
FROM node:22-bookworm-slim AS runtime

# ffmpeg for video thumbnails and duration probing.
# libvips is sharp's image backend.
# tini reaps zombies and forwards SIGTERM so graceful shutdown actually works
# when Unraid stops the container.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libvips42 \
      tini \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    LIBRARY_PATH=/data/library \
    THUMBS_PATH=/data/thumbs \
    UPLOAD_TMP_PATH=/data/tmp

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/shared/package.json ./shared/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/migrations ./server/migrations
COPY --from=builder /app/server/public ./server/public

# The data volume is created by the compose file / Unraid mapping. Making it a
# VOLUME here documents the intent and prevents writes into the image layer.
VOLUME ["/data"]

EXPOSE 3000

# Unraid shows the container as unhealthy if the API or database is down, which
# is far more useful than "running" while uploads are silently failing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/server/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
