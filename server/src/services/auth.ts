import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthTokens, User } from '@platen/shared';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_DAYS, config } from '../config.js';
import { sql } from '../db/index.js';
import { unauthorized } from '../lib/errors.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);
const ISSUER = 'platen';

export interface AccessClaims {
  sub: string;
  admin: boolean;
}

export const hashPassword = (plain: string) =>
  argonHash(plain, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hashValue, plain);
  } catch {
    return false;
  }
}

async function signAccessToken(userId: string, isAdmin: boolean): Promise<string> {
  return new SignJWT({ admin: isAdmin })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (!payload.sub) throw new Error('missing sub');
    return { sub: payload.sub, admin: payload.admin === true };
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
}

/**
 * Share tokens prove that someone already entered a share link's password.
 *
 * Images load through <img> and <video>, which cannot send the password
 * header, so the share page swaps the password for one of these once and puts
 * it in media URLs. A separate issuer keeps the two kinds of token apart: an
 * access token is refused here, and a share token is refused as a login.
 */
const SHARE_ISSUER = 'platen-share';
const SHARE_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export async function signShareToken(shareId: string, shareExpiresAt: Date | null): Promise<string> {
  const ttlEnd = Date.now() + SHARE_TOKEN_TTL_SECONDS * 1000;
  const expiresAt = shareExpiresAt ? Math.min(ttlEnd, shareExpiresAt.getTime()) : ttlEnd;
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(shareId)
    .setIssuer(SHARE_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(secret);
}

/** True only for an unexpired token minted for this very share. */
export async function verifyShareToken(token: string, shareId: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: SHARE_ISSUER, subject: shareId });
    return payload.sub === shareId;
  } catch {
    return false;
  }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Issues a fresh access/refresh pair. The refresh token is a random opaque
 * string; only its SHA-256 lives in the database, so the table is useless to
 * anyone who reads it.
 */
export async function issueTokens(
  userId: string,
  isAdmin: boolean,
  deviceName?: string,
): Promise<AuthTokens> {
  const refreshToken = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  await sql`
    INSERT INTO refresh_tokens (user_id, token_hash, device_name, expires_at)
    VALUES (${userId}, ${hashToken(refreshToken)}, ${deviceName ?? null}, ${expiresAt})
  `;

  return {
    accessToken: await signAccessToken(userId, isAdmin),
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

/**
 * Exchanges a refresh token for a new pair and revokes the old one (rotation).
 *
 * Claiming the token and revoking it are one statement. As a read followed by
 * a separate write, two requests presenting the same token at the same moment
 * could both pass the read and both walk away with a fresh pair — a stolen
 * token raced against its owner would survive rotation.
 */
export async function rotateRefreshToken(refreshToken: string): Promise<AuthTokens> {
  const tokenHash = hashToken(refreshToken);

  const rows = await sql<{ user_id: string; is_admin: boolean; device_name: string | null }[]>`
    UPDATE refresh_tokens rt
    SET revoked_at = now(), last_used_at = now()
    FROM users u
    WHERE u.id = rt.user_id
      AND rt.token_hash = ${tokenHash}
      AND rt.revoked_at IS NULL
      AND rt.expires_at > now()
    RETURNING rt.user_id, rt.device_name, u.is_admin
  `;

  const row = rows[0];
  if (!row) throw unauthorized('Your session has expired. Please sign in again.');

  return issueTokens(row.user_id, row.is_admin, row.device_name ?? undefined);
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await sql`
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE token_hash = ${hashToken(refreshToken)} AND revoked_at IS NULL
  `;
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await sql`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
}

/** Constant-time compare for share-link passwords and similar short secrets. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
  quota_bytes: string | null;
  created_at: Date;
}

export async function toUserDto(row: UserRow): Promise<User> {
  const [usage] = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(file_size), 0)::text AS total
    FROM assets WHERE owner_id = ${row.id} AND deleted_at IS NULL
  `;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isAdmin: row.is_admin,
    quotaBytes: row.quota_bytes === null ? null : Number(row.quota_bytes),
    usageBytes: Number(usage?.total ?? 0),
    createdAt: row.created_at.toISOString(),
  };
}
