import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthResponse } from '@aperture/shared';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { auth, requireAuth } from '../middleware/auth.js';
import {
  hashPassword,
  issueTokens,
  revokeAllForUser,
  revokeRefreshToken,
  rotateRefreshToken,
  toUserDto,
  verifyPassword,
  type UserRow,
} from '../services/auth.js';

const USER_COLUMNS = sql`id, email, name, is_admin, quota_bytes, created_at`;

const credentials = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  deviceName: z.string().max(120).optional(),
});

const registration = credentials.extend({
  name: z.string().min(1, 'Name is required').max(120),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * First-run bootstrap. The very first account created on a fresh server
   * becomes the admin and is always allowed, regardless of ALLOW_REGISTRATION —
   * otherwise a locked-down install could never be set up at all.
   */
  app.post('/register', async (request, reply) => {
    const body = registration.parse(request.body);

    const counts = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM users`;
    const isFirstUser = (counts[0]?.count ?? 0) === 0;

    if (!isFirstUser && !config.ALLOW_REGISTRATION) {
      throw forbidden('Registration is disabled on this server. Ask an administrator for an invite.');
    }

    const existing = await sql`SELECT 1 FROM users WHERE email = ${body.email}`;
    if (existing.length > 0) throw conflict('An account with that email already exists.');

    const passwordHash = await hashPassword(body.password);

    const [row] = await sql<UserRow[]>`
      INSERT INTO users (email, password_hash, name, is_admin)
      VALUES (${body.email}, ${passwordHash}, ${body.name}, ${isFirstUser})
      RETURNING ${USER_COLUMNS}
    `;
    if (!row) throw badRequest('Could not create the account.');

    const tokens = await issueTokens(row.id, row.is_admin, body.deviceName);
    const response: AuthResponse = { ...tokens, user: await toUserDto(row) };
    return reply.code(201).send(response);
  });

  app.post('/login', async (request) => {
    const body = credentials.parse(request.body);

    const rows = await sql<(UserRow & { password_hash: string })[]>`
      SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = ${body.email}
    `;
    const row = rows[0];

    // Always run a verify, even when the user does not exist, so response time
    // does not reveal which emails are registered.
    const ok = row
      ? await verifyPassword(row.password_hash, body.password)
      : await verifyPassword(
          '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000',
          body.password,
        );

    if (!row || !ok) throw unauthorized('Incorrect email or password.');

    const tokens = await issueTokens(row.id, row.is_admin, body.deviceName);
    const response: AuthResponse = { ...tokens, user: await toUserDto(row) };
    return response;
  });

  app.post('/refresh', async (request) => {
    const { refreshToken } = z
      .object({ refreshToken: z.string().min(1) })
      .parse(request.body);
    return rotateRefreshToken(refreshToken);
  });

  app.post('/logout', async (request, reply) => {
    const { refreshToken } = z
      .object({ refreshToken: z.string().min(1) })
      .parse(request.body);
    await revokeRefreshToken(refreshToken);
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: requireAuth }, async (request) => {
    const { userId } = auth(request);
    const rows = await sql<UserRow[]>`SELECT ${USER_COLUMNS} FROM users WHERE id = ${userId}`;
    const row = rows[0];
    if (!row) throw unauthorized('Your account no longer exists.');
    return toUserDto(row);
  });

  app.patch('/me', { preHandler: requireAuth }, async (request) => {
    const { userId } = auth(request);
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        password: z.string().min(8).optional(),
        currentPassword: z.string().optional(),
      })
      .parse(request.body);

    if (body.password) {
      if (!body.currentPassword) {
        throw badRequest('Enter your current password to set a new one.');
      }
      const rows = await sql<{ password_hash: string }[]>`
        SELECT password_hash FROM users WHERE id = ${userId}
      `;
      const current = rows[0];
      if (!current || !(await verifyPassword(current.password_hash, body.currentPassword))) {
        throw unauthorized('Your current password is incorrect.');
      }
      await sql`UPDATE users SET password_hash = ${await hashPassword(body.password)} WHERE id = ${userId}`;
      // Changing a password signs every other device out.
      await revokeAllForUser(userId);
    }

    if (body.name) {
      await sql`UPDATE users SET name = ${body.name} WHERE id = ${userId}`;
    }

    const rows = await sql<UserRow[]>`SELECT ${USER_COLUMNS} FROM users WHERE id = ${userId}`;
    return toUserDto(rows[0]!);
  });

  /** Active sessions, so a user can see and revoke a lost phone. */
  app.get('/sessions', { preHandler: requireAuth }, async (request) => {
    const { userId } = auth(request);
    return sql`
      SELECT id, device_name, created_at, last_used_at, expires_at
      FROM refresh_tokens
      WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC
    `;
  });

  app.delete('/sessions/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await sql`
      UPDATE refresh_tokens SET revoked_at = now()
      WHERE id = ${id} AND user_id = ${userId}
    `;
    return reply.code(204).send();
  });
}
