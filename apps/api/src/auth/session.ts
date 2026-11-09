import type { CookieSerializeOptions } from '@fastify/cookie';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessions, users } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { Db } from '../types.js';
import { hashToken, isTokenShaped, newToken, SESSION_TTL_MS } from './tokens.js';

export const SESSION_COOKIE = 'kq_session';

/** `Max-Age=2592000; HttpOnly; Secure; SameSite=Lax; Path=/`: lives as long as the session row. */
export const SESSION_COOKIE_OPTIONS: CookieSerializeOptions = {
  maxAge: SESSION_TTL_MS / 1000,
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

/** Deletes the session for `token`; returns its user id, or null if there was none. */
export async function deleteSession(db: Pick<Db, 'delete'>, token: unknown): Promise<string | null> {
  if (!isTokenShaped(token)) return null;
  const [row] = await db
    .delete(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)))
    .returning({ userId: sessions.userId });
  return row?.userId ?? null;
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
