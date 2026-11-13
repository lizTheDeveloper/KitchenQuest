import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { voiceRegistry } from '../voice/registry.js';
import { loginTokens, users } from '../db/schema.js';
import { activeEntitlements } from '../entitlements/entitlements.js';
import { ApiError } from '../errors.js';
import { lockSignInEmail } from './email-lock.js';
import { ipKey, SlidingWindowLimiter, sweepPeriodically } from './rate-limit.js';
import {
  createSession,
  deleteSession,
  requireUser,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  type SessionUser,
} from './session.js';
import { hashToken, isTokenShaped, LOGIN_TOKEN_TTL_MS, newToken } from './tokens.js';

const HOUR = 60 * 60 * 1000;

const RequestBody = z.object({
  email: z.string().trim().max(254).pipe(z.email()),
  // Accepted for the client's convenience; the age gate is enforced at /auth/verify.
  ageConfirmed: z.boolean().optional(),
});

const VerifyBody = z.object({
  token: z.string(),
  ageConfirmed: z.boolean().optional(),
});

const unauthorized = () => new ApiError(401, 'unauthorized', 'Invalid or expired sign-in link');

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, mailer, now, config } = app.deps;
  // Per app instance, so each test's buildApp starts clean.
  const perEmail = new SlidingWindowLimiter(5, HOUR);
  const perIp = new SlidingWindowLimiter(20, HOUR);
  // N-2: IPs and emails leave memory within a minute of leaving the window.
  const stopSweeping = sweepPeriodically([perEmail, perIp], () => now().getTime());
  app.addHook('onClose', (_app, done) => {
    stopSweeping();
    done();
  });
  const origin = config.appOrigin.replace(/\/+$/, '');

  app.post('/auth/request', async (req, reply) => {
    const { email } = RequestBody.parse(req.body);
    const at = now();
    const t = at.getTime();
    const emailKey = email.toLowerCase();
    const ip = ipKey(req.ip);
    const wait = Math.max(perIp.waitMs(ip, t), perEmail.waitMs(emailKey, t));
    if (wait > 0) {
      reply.header('retry-after', String(Math.ceil(wait / 1000)));
      throw new ApiError(429, 'rate_limited', 'Too many sign-in requests; try again later');
    }
    perIp.hit(ip, t);
    perEmail.hit(emailKey, t);

    // Same work whether or not an account exists: the user is created at /auth/verify.
    const { token, hash } = newToken();
    // Under the email's lock, so it cannot interleave with an account delete (C-8).
    await db.transaction(async (tx) => {
      await lockSignInEmail(tx, email);
      await tx.insert(loginTokens).values({
        email,
        tokenHash: hash,
        expiresAt: new Date(t + LOGIN_TOKEN_TTL_MS),
        createdAt: at,
      });
    });
    const link = `${origin}/auth/verify?token=${token}`;
    await mailer.send({
      to: email,
      subject: 'Your Kitchen Quest sign-in link',
      text:
        `Sign in to Kitchen Quest:\n\n${link}\n\n` +
        `This link works once and expires in 15 minutes. ` +
        `If you did not ask for it, you can ignore this email.\n`,
    });
    return reply.status(202).send({ ok: true });
  });

  app.post('/auth/verify', async (req, reply) => {
    const { token, ageConfirmed } = VerifyBody.parse(req.body);
    if (!isTokenShaped(token)) throw unauthorized();
    const at = now();

    const tokenHash = hashToken(token);
    // One transaction: the token is consumed only if the session is created.
    // The email's lock comes first, as in account delete (email lock, then
    // users, then login_tokens), so a verify racing a delete cannot deadlock
    // (M-1). The conditional UPDATE then row-locks the token, so of two
    // concurrent verifies the second waits, then sees used_at set and matches nothing.
    const { user, sessionToken } = await db.transaction(async (tx) => {
      const [pending] = await tx.select({ email: loginTokens.email }).from(loginTokens).where(eq(loginTokens.tokenHash, tokenHash));
      if (!pending) throw unauthorized();
      await lockSignInEmail(tx, pending.email);
      const [consumed] = await tx
        .update(loginTokens)
        .set({ usedAt: at })
        .where(
          and(eq(loginTokens.tokenHash, tokenHash), isNull(loginTokens.usedAt), gt(loginTokens.expiresAt, at)),
        )
        .returning({ email: loginTokens.email });
      if (!consumed) throw unauthorized();

      const cols = { id: users.id, email: users.email };
      let [user]: SessionUser[] = await tx.select(cols).from(users).where(eq(users.email, consumed.email));
      if (!user) {
        if (ageConfirmed !== true) {
          // Thrown inside the transaction, so the token stays unused.
          throw new ApiError(400, 'bad_request', 'Confirm you are 16 or older to create an account', {
            code: 'age_confirmation_required',
          });
        }
        [user] = await tx
          .insert(users)
          .values({ email: consumed.email, ageConfirmedAt: at, createdAt: at })
          .onConflictDoNothing({ target: users.email })
          .returning(cols);
        // A concurrent verify for another token of the same email created it first.
        if (!user) [user] = await tx.select(cols).from(users).where(eq(users.email, consumed.email));
        if (!user) throw new Error('user vanished after insert conflict');
      }
      const sessionToken = await createSession(tx, user.id, at);
      // C-5: content-free; the email is never written to the audit log.
      await audit(tx, { actorKind: 'user', actorId: user.id, subjectUserId: user.id, action: 'auth.sign_in', requestId: req.id }, at);
      return { user, sessionToken };
    });

    reply.setCookie(SESSION_COOKIE, sessionToken, SESSION_COOKIE_OPTIONS);
    reply.header('cache-control', 'no-store');
    return { user: { id: user.id, email: user.email } };
  });

  app.post('/auth/logout', async (req, reply) => {
    const signedOut = await db.transaction(async (tx) => {
      const userId = await deleteSession(tx, req.cookies[SESSION_COOKIE]);
      if (userId) {
        await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'auth.sign_out', requestId: req.id }, now());
      }
      return userId;
    });
    // M7 Step 5 fix round 1 (I1): a sign-out closes every open voice socket of the player.
    if (signedOut) voiceRegistry.closeUser(signedOut, 'signed_out');
    reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: requireUser }, async (req) => ({
    id: req.user.id,
    email: req.user.email,
    entitlements: await activeEntitlements(db, req.user.id, now()),
  }));
}
