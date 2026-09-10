import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../services/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `requireAuth`. Absent on public routes. */
    auth?: { userId: string; isAdmin: boolean };
  }
}

/**
 * Accepts `Authorization: Bearer <jwt>`, and — only for media GETs — a
 * `?token=` query parameter. The query fallback exists because `<img>` and
 * native video players cannot attach headers; those routes are read-only and
 * the token is short-lived.
 */
function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);

  const q = (request.query as Record<string, unknown> | undefined)?.token;
  if (typeof q === 'string' && q.length > 0 && request.method === 'GET') return q;

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
