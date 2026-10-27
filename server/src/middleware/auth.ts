import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../services/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `requireAuth`. Absent on public routes. */
    auth?: { userId: string; isAdmin: boolean };
  }

  interface FastifyContextConfig {
    /**
     * Accept the access token as `?token=`. Only for media a browser or
     * native player loads directly — see `MEDIA_ROUTE`.
     */
    allowQueryToken?: boolean;
  }
}

/**
 * Route options for media that `<img>`, `<video>` and native players load by
 * URL. They cannot attach headers, so these routes alone take the token from
 * the query string. Everywhere else a token in a URL is refused: URLs end up
 * in logs, history and Referer headers, and a GET like /api/auth/sessions has
 * no reason to accept one.
 */
export const MEDIA_ROUTE = { config: { allowQueryToken: true } } as const;

/** Accepts `Authorization: Bearer <jwt>`, and on media routes `?token=`. */
function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);

  if (request.method === 'GET' && request.routeOptions.config?.allowQueryToken) {
    const q = (request.query as Record<string, unknown> | undefined)?.token;
    if (typeof q === 'string' && q.length > 0) return q;
  }

  return null;
}

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractToken(request);
  if (!token) throw unauthorized();

  const claims = await verifyAccessToken(token);
  request.auth = { userId: claims.sub, isAdmin: claims.admin };
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);
  if (!request.auth?.isAdmin) throw forbidden('This action requires an administrator account.');
}

/** Narrowing helper so route handlers do not repeat the non-null assertion. */
export function auth(request: FastifyRequest): { userId: string; isAdmin: boolean } {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
