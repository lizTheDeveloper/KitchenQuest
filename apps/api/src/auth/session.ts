import type { CookieSerializeOptions } from '@fastify/cookie';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessions, users } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { Db } from '../types.js';
import { hashToken, isTokenShaped, newToken, SESSION_TTL_MS } from './tokens.js';

export const SESSION_COOKIE = 'kq_session';

/** Exactly `HttpOnly; Secure; SameSite=Lax; Path=/`; the server-side expiry is the session row's. */
export const SESSION_COOKIE_OPTIONS: CookieSerializeOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
};

export interface SessionUser {
  id: string;
  email: string;
}

type Tx = Pick<Db, 'insert'>;

/** Stores a new session for `userId` (hash only) and returns the raw cookie value. */
export async function createSession(db: Tx, userId: string, now: Date): Promise<string> {
  const { token, hash } = newToken();
  await db.insert(sessions).values({
    userId,
    tokenHash: hash,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  return token;
}

async function sessionUser(db: Db, token: unknown, now: Date): Promise<SessionUser | null> {
  if (!isTokenShaped(token)) return null;
  const [row] = await db
    .select({ id: users.id, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)));
  return row ?? null;
}

export async function deleteSession(db: Db, token: unknown): Promise<void> {
  if (!isTokenShaped(token)) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** preHandler: sets `request.user` from a live session cookie, or fails with 401 `unauthorized`. */
export async function requireUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const { db, now } = request.server.deps;
  const user = await sessionUser(db, request.cookies[SESSION_COOKIE], now());
  if (!user) throw new ApiError(401, 'unauthorized', 'Sign in required');
  request.user = user;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: typeof requireUser;
  }
  interface FastifyRequest {
    /** Set by `requireUser`; only read it in routes that use that preHandler. */
    user: SessionUser;
  }
}
