import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { redactUrl } from './lib/redact.js';
import { albumRoutes } from './routes/albums.js';
import { assetRoutes } from './routes/assets.js';
import { authRoutes } from './routes/auth.js';
import { publicShareRoutes, shareAdminRoutes } from './routes/share.js';
import { searchRoutes } from './routes/search.js';
import { serverRoutes } from './routes/server.js';
import { peopleRoutes } from './routes/people.js';
import { libraryRoutes } from './routes/libraries.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `TRUST_PROXY` as Fastify wants it.
 *
 * The default trusts only private and loopback addresses, which is where a
 * reverse proxy on a NAS lives. Trusting everyone instead would let any client
 * pick its own IP with an X-Forwarded-For header, and every per-IP rate limit
 * would mean nothing.
 */
function trustProxySetting(value: string): FastifyServerOptions['trustProxy'] {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return (_address: string, hop: number) => hop < hops;
  }
  return value;
}

/**
 * Logger settings. Tests pass `false` for silence, or a stream to read what
 * would have been written; the serializers apply either way.
 */
function loggerOptions(override?: false | { stream: Writable }): FastifyServerOptions['logger'] {
  if (override === false) return false;
  return {
    level: config.NODE_ENV === 'development' ? 'debug' : 'info',
    transport:
      config.NODE_ENV === 'development' && !override
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
    stream: override?.stream,
    serializers: {
      // Media URLs carry an access token in the query string, because <img>
      // cannot send headers. Logged verbatim, every thumbnail request would
      // write a working credential into the container logs.
      req(request) {
        return {
          method: request.method,
          url: redactUrl(request.url),
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      },
    },
  };
}

export async function buildApp(
  options: { logger?: false | { stream: Writable } } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(options.logger),
    // Uploads are streamed, but the body limit still guards JSON endpoints.
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: trustProxySetting(config.TRUST_PROXY),
    // Unraid users sit behind reverse proxies that can be slow on big uploads.
    requestTimeout: 0,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        // React writes theme variables and layout through style attributes.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // Deliberately no upgrade-insecure-requests: most installs are reached
        // over plain HTTP on the LAN, and upgrading would break every request.
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    // The mobile app is a native client with no browser origin, and the web UI
    // is same-origin, so a permissive default is safe here and saves users
    // debugging CORS when they put Platen behind a proxy. Credentials travel
    // in headers and request bodies, never cookies, so reflecting the origin
    // grants another site nothing it could not already do.
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
      error: status >= 500 ? 'internal_error' : status === 429 ? 'rate_limited' : 'request_failed',
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
  } else {
    app.log.warn('No built web client found at server/public — API only.');
  }

  // SPA fallback: anything that is not /api and not a real file renders the
  // client, so deep links like /albums/<id> and /s/<key> survive a refresh.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || !existsSync(webRoot)) {
      return reply
        .code(404)
        .send({ error: 'not_found', message: `No route for ${redactUrl(request.url)}`, statusCode: 404 });
    }
    return reply.sendFile('index.html');
  });

  return app;
}
