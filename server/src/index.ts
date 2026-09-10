import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { closeDatabase, waitForDatabase } from './db/index.js';
import { migrate } from './db/migrate.js';
import { startWorker } from './jobs/worker.js';
import { HttpError } from './lib/errors.js';
import { ensureStorageDirs } from './lib/storage.js';
import { albumRoutes } from './routes/albums.js';
import { assetRoutes } from './routes/assets.js';
import { authRoutes } from './routes/auth.js';
import { publicShareRoutes, shareAdminRoutes } from './routes/share.js';
import { searchRoutes } from './routes/search.js';
import { serverRoutes } from './routes/server.js';
import { peopleRoutes } from './routes/people.js';
import { libraryRoutes } from './routes/libraries.js';
import { hasFfmpeg } from './services/media.js';
import { warmUp } from './services/ml.js';
import { warmUpFaces } from './services/faces.js';
import { closeCache, initCache } from './services/cache.js';

const here = dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: {
    level: config.NODE_ENV === 'development' ? 'debug' : 'info',
    transport:
      config.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
  },
  // Uploads are streamed, but the body limit still guards JSON endpoints.
  bodyLimit: 8 * 1024 * 1024,
  trustProxy: true,
  // Unraid users sit behind reverse proxies that can be slow on big uploads.
  requestTimeout: 0,
});

async function build(): Promise<void> {
  await app.register(helmet, {
    // The web client is served from the same origin and uses inline styles for
    // the theme variables; CSP is set explicitly below rather than by default.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    // The mobile app is a native client with no browser origin, and the web UI
    // is same-origin, so a permissive default is safe here and saves users
    // debugging CORS when they put Aperture behind a proxy.
    origin: true,
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    // Media requests are numerous and cheap; only throttle the mutating API.
    allowList: (request) => request.method === 'GET' && request.url.includes('/thumbnail'),
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.MAX_UPLOAD_BYTES,
      files: 1,
      fieldSize: 1024 * 100,
    },
  });

  // -------------------------------------------------------------------------
  // Error shaping — every failure leaves as the same JSON envelope
  // -------------------------------------------------------------------------
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      const field = first?.path.join('.');
      return reply.code(400).send({
        error: 'validation_failed',
        message: first ? `${field ? `${field}: ` : ''}${first.message}` : 'Invalid request.',
        statusCode: 400,
      });
    }

    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message, statusCode: error.statusCode });
    }

    // Fastify's own errors (payload too large, malformed multipart, ...)
    const fastifyError = error as { statusCode?: number; message?: string };
    const status =
      fastifyError.statusCode && fastifyError.statusCode >= 400 ? fastifyError.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    }

    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'request_failed',
      message:
        status >= 500
          ? 'Something went wrong on the server. Check the container logs for details.'
          : (fastifyError.message ?? 'Request failed.'),
      statusCode: status,
    });
  });

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------
  await app.register(serverRoutes, { prefix: '/api/server' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(assetRoutes, { prefix: '/api/assets' });
  await app.register(albumRoutes, { prefix: '/api/albums' });
  await app.register(shareAdminRoutes, { prefix: '/api/shares' });
  await app.register(searchRoutes, { prefix: '/api/search' });
  await app.register(peopleRoutes, { prefix: '/api/people' });
  await app.register(libraryRoutes, { prefix: '/api/libraries' });
  await app.register(publicShareRoutes, { prefix: '/api/public' });

  // -------------------------------------------------------------------------
  // Static web client (built into the image alongside the server)
  // -------------------------------------------------------------------------
  const webRoot = join(here, '..', 'public');
  if (existsSync(webRoot)) {
    // Wildcard (the default) resolves files from disk per request. The
    // `wildcard: false` alternative enumerates the directory once at startup,
    // which means any asset written afterwards — every rebuilt bundle, with its
    // new content hash — falls through to the SPA fallback and gets served as
    // HTML, breaking the page with a MIME type error.
    await app.register(fastifyStatic, {
      root: webRoot,
      // Hashed bundles are immutable; index.html must never be cached or
      // clients keep loading the previous build's asset names after an update.
      cacheControl: false,
      setHeaders: (reply, path) => {
        if (path.endsWith('index.html')) {
          reply.setHeader('Cache-Control', 'no-cache');
        } else {
          reply.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });

    // SPA fallback: anything that is not /api and not a real file renders the
    // client, so deep links like /albums/<id> and /s/<key> survive a refresh.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply
          .code(404)
          .send({ error: 'not_found', message: `No route for ${request.url}`, statusCode: 404 });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn('No built web client found at server/public — API only.');
  }
}

async function start(): Promise<void> {
  await build();
  await ensureStorageDirs();
  await waitForDatabase();
  await migrate();

  if (!(await hasFfmpeg())) {
    app.log.warn(
      'ffmpeg/ffprobe not found on PATH. Video uploads will be stored but will not get ' +
        'thumbnails or duration metadata. The official Docker image bundles ffmpeg.',
    );
  }

  await initCache((msg) => app.log.info(msg));

  const stopWorker = startWorker(app.log);
  void warmUp((msg) => app.log.info(msg));
  void warmUpFaces((msg) => app.log.info(msg));

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`Aperture is ready at ${config.PUBLIC_URL}`);

  // -------------------------------------------------------------------------
  // Graceful shutdown: finish in-flight jobs so we never leave a half-written
  // derivative or an orphaned temp file behind.
  // -------------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down...`);

    const force = setTimeout(() => {
      app.log.error('Shutdown timed out after 30s, exiting forcefully.');
      process.exit(1);
    }, 30_000);
    force.unref();

    try {
      await app.close();
      await stopWorker();
      await closeCache();
      await closeDatabase();
      app.log.info('Goodbye.');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err) => {
  app.log.error({ err }, 'Aperture failed to start');
  process.exit(1);
});
