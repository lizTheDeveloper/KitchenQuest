import { readFileSync } from 'node:fs';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pseudonymizeAudit } from '../audit/audit.js';
import { lockSignInEmail } from '../auth/email-lock.js';
import { lockLiveUser } from '../auth/live-user.js';
import { SlidingWindowLimiter, sweepPeriodically } from '../auth/rate-limit.js';
import { requireUser, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from '../auth/session.js';
import type { Config } from '../config.js';
import { consentHistory, type Tx } from '../consent/ledger.js';
import {
  auditEvents,
  entitlements,
  loginTokens,
  profiles,
  rules,
  selfReadCounts,
  sessions,
  usageEvents,
  userKeys,
  users,
} from '../db/schema.js';
import { ApiError } from '../errors.js';
import { loadMeals } from '../meals/store.js';
import { loadConversationsForExport } from '../mentor/conversations.js';
import { loadProposalsForExport } from '../mentor/proposals.js';
import { loadPantryForExport } from '../pantry/store.js';
import { knownMealWindows } from '../profile/store.js';
import { loadRules } from '../rules/store.js';
import { AI_PROCESSOR_IDS } from '../ai/processors.js';

/** The exact words the player types to delete their account. */
const DELETE_PHRASE = 'delete my account';

const PROCESSORS_FILE = new URL('../../../../docs/compliance/processors.json', import.meta.url);

const ProcessorRegister = z.object({
  processors: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        purpose: z.string().min(1),
        country: z.string().min(1),
        contact: z.string().min(1),
        status: z.string().min(1),
        data_categories: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});

/**
 * A recipient of the player's data (GDPR Art. 15(1)(c)), as the export lists it.
 * `status` is the register's own wording; `inUse` is false while the register
 * says the processor is only planned; `detailsConfirmed` is false while its
 * name, country or contact is still a placeholder ([verify], TBD).
 */
interface Processor {
  name: string;
  purpose: string;
  country: string;
  contact: string;
  status: string;
  inUse: boolean;
  detailsConfirmed: boolean;
}

/**
 * The processor list the export carries (C-7), from the checked-in register.
 * Processors that receive no user data at all (build-time tools) are not
 * recipients and are left out. The AI processors are in use only when this
 * server runs with the AI on (`aiOn`): the register says "built", but
 * production keeps the AI off until their DPAs are signed (P-11).
 */
function loadProcessors(aiOn: boolean): Processor[] {
  const doc = ProcessorRegister.parse(JSON.parse(readFileSync(PROCESSORS_FILE, 'utf8')));
  return doc.processors
    .filter((p) => !p.data_categories.every((c) => /^none\b/i.test(c)))
    .map(({ id, name, purpose, country, contact, status }) => ({
      name,
      purpose,
      country,
      contact,
      status,
      inUse: !/^planned\b/i.test(status) && (aiOn || !(AI_PROCESSOR_IDS as readonly string[]).includes(id)),
      detailsConfirmed: !/\[verify|\bTBD\b/i.test(`${name} ${country} ${contact}`),
    }));
}

const HOUR = 60 * 60 * 1000;

/** A failed lock or read because a concurrent transaction deleted the row (REPEATABLE READ). */
function isSerializationFailure(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === '40001') return true;
  }
  return false;
}

const signedOut = () => new ApiError(401, 'unauthorized', 'Sign in required');

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Everything stored about the user, health data decrypted (C-7, Review Focus 6).
 * Every table linked to a user appears here; `test/account.test.ts` enumerates
 * them from the schema, so a later table fails it until it is added.
 * Left out on purpose: token hashes, the wrapped data key and sealed blobs
 * (credentials and ciphertext, not information about the player), a mentor
 * proposal's undo payload and written-row ref (internal bookkeeping for undo),
 * internal row ids other than rule, meal, pantry, conversation and proposal
 * ids, and the audit actor id (the player themselves,
 * or a staff identifier).
 */
async function buildExport(tx: Tx, config: Config, userId: string, now: Date, processors: Processor[]) {
  const user = (
    await tx
      .select({ id: users.id, email: users.email, createdAt: users.createdAt, ageConfirmedAt: users.ageConfirmedAt })
      .from(users)
      .where(eq(users.id, userId))
  ).at(0);
  if (!user) throw signedOut();

  const profile = (
    await tx
      .select({
        marketDays: profiles.marketDays,
        mealsPerWeek: profiles.mealsPerWeek,
        country: profiles.country,
        region: profiles.region,
        mealWindows: profiles.mealWindows,
        updatedAt: profiles.updatedAt,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
  ).at(0);

  const ruleTimes = new Map(
    (
      await tx
        .select({ id: rules.id, createdAt: rules.createdAt, updatedAt: rules.updatedAt })
        .from(rules)
        .where(eq(rules.userId, userId))
    ).map((r) => [r.id, r]),
  );
  const decrypted = (await loadRules(tx, config.keyring, userId)).map((r) => ({
    ...r,
    createdAt: iso(ruleTimes.get(r.id)?.createdAt ?? null),
    updatedAt: iso(ruleTimes.get(r.id)?.updatedAt ?? null),
  }));

  // Meal logs (H-7) and pantry items (H-11), decrypted, with their row ids.
  const meals = (await loadMeals(tx, config.keyring, userId)).map(({ id, eatenOn, slot, item, createdAt }) => ({
    id,
    eatenOn,
    slot,
    item,
    createdAt: iso(createdAt),
  }));
  const pantry = (await loadPantryForExport(tx, config.keyring, userId)).map(({ id, name, ingredientId, createdAt }) => ({
    id,
    name,
    ingredientId,
    createdAt: iso(createdAt),
  }));

  // Pan conversations with their stored messages, and proposal cards, decrypted (I-1, I-4, C-12).
  const convs = (await loadConversationsForExport(tx, config.keyring, userId)).map((c) => ({
    id: c.id,
    startedAt: iso(c.startedAt),
    lastTurnAt: iso(c.lastTurnAt),
    turnSeq: c.turnSeq,
    messages: c.messages.map((m) => ({ ...m, createdAt: iso(m.createdAt) })),
  }));
  const proposals = (await loadProposalsForExport(tx, config.keyring, userId)).map((p) => ({
    ...p,
    createdAt: iso(p.createdAt),
    expiresAt: iso(p.expiresAt),
    decidedAt: iso(p.decidedAt),
  }));

  const ents = await tx
    .select({
      kind: entitlements.kind,
      source: entitlements.source,
      startsAt: entitlements.startsAt,
      endsAt: entitlements.endsAt,
      createdAt: entitlements.createdAt,
    })
    .from(entitlements)
    .where(eq(entitlements.userId, userId))
    .orderBy(asc(entitlements.createdAt), asc(entitlements.id));

  const usage = await tx
    .select({
      feature: usageEvents.feature,
      events: sql<number>`count(*)::int`,
      units: sql<number>`sum(${usageEvents.units})::bigint`.mapWith(Number),
      costMicroUsd: sql<number>`sum(${usageEvents.costMicroUsd})::bigint`.mapWith(Number),
      firstAt: sql<Date>`min(${usageEvents.createdAt})`.mapWith(usageEvents.createdAt),
      lastAt: sql<Date>`max(${usageEvents.createdAt})`.mapWith(usageEvents.createdAt),
    })
    .from(usageEvents)
    .where(eq(usageEvents.userId, userId))
    .groupBy(usageEvents.feature)
    .orderBy(asc(usageEvents.feature));

  const reads = await tx
    .select({ resource: selfReadCounts.resource, day: selfReadCounts.day, count: selfReadCounts.count })
    .from(selfReadCounts)
    .where(eq(selfReadCounts.userId, userId))
    .orderBy(asc(selfReadCounts.day), asc(selfReadCounts.resource));

  const sess = await tx
    .select({ createdAt: sessions.createdAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(asc(sessions.createdAt), asc(sessions.id));

  const tokens = await tx
    .select({ createdAt: loginTokens.createdAt, expiresAt: loginTokens.expiresAt, usedAt: loginTokens.usedAt })
    .from(loginTokens)
    .where(eq(loginTokens.email, user.email))
    .orderBy(asc(loginTokens.createdAt), asc(loginTokens.id));

  const dataKey = (
    await tx
      .select({ keyId: userKeys.keyId, createdAt: userKeys.createdAt })
      .from(userKeys)
      .where(eq(userKeys.userId, userId))
  ).at(0);

  const events = await tx
    .select({
      at: auditEvents.at,
      actorKind: auditEvents.actorKind,
      action: auditEvents.action,
      target: auditEvents.target,
      requestId: auditEvents.requestId,
    })
    .from(auditEvents)
    .where(eq(auditEvents.subjectUserId, userId))
    .orderBy(asc(auditEvents.at), asc(auditEvents.id));

  return {
    exportedAt: now.toISOString(),
    user: { id: user.id, email: user.email, createdAt: iso(user.createdAt), ageConfirmedAt: iso(user.ageConfirmedAt) },
    profile: profile
      ? { ...profile, mealWindows: knownMealWindows(profile.mealWindows), updatedAt: iso(profile.updatedAt) }
      : null,
    rules: decrypted,
    meals,
    pantry,
    conversations: convs,
    proposals,
    consents: await consentHistory(tx, userId),
    entitlements: ents.map((e) => ({
      ...e,
      startsAt: iso(e.startsAt),
      endsAt: iso(e.endsAt),
      createdAt: iso(e.createdAt),
    })),
    usage: usage.map((u) => ({ ...u, firstAt: iso(u.firstAt), lastAt: iso(u.lastAt) })),
    selfReadCounts: reads,
    sessions: sess.map((s) => ({ createdAt: iso(s.createdAt), expiresAt: iso(s.expiresAt) })),
    loginTokens: tokens.map((t) => ({
      createdAt: iso(t.createdAt),
      expiresAt: iso(t.expiresAt),
      usedAt: iso(t.usedAt),
    })),
    dataKey: dataKey ? { keyId: dataKey.keyId, createdAt: iso(dataKey.createdAt) } : null,
    auditEvents: events.map((e) => ({ ...e, at: iso(e.at) })),
    processors,
  };
}

/**
 * The player's data rights: `GET /me/export` (access and portability, C-7)
 * and `DELETE /me` (erasure, C-8). Both are audited (C-5) and free forever.
 */
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, now } = app.deps;
  // Read once at boot, so a missing or malformed register stops the server.
  const processors = loadProcessors(config.ai !== null);
  // Per app instance; an export is heavy (every table, every rule decrypted).
  const exportLimiter = new SlidingWindowLimiter(5, HOUR);
  const stopSweeping = sweepPeriodically([exportLimiter], () => now().getTime());
  app.addHook('onClose', (_app, done) => {
    stopSweeping();
    done();
  });

  app.get('/me/export', { preHandler: requireUser }, async (req, reply) => {
    const at = now();
    const userId = req.user.id;
    const wait = exportLimiter.waitMs(userId, at.getTime());
    if (wait > 0) {
      reply.header('retry-after', String(Math.ceil(wait / 1000)));
      throw new ApiError(429, 'rate_limited', 'Too many exports; try again later');
    }
    exportLimiter.hit(userId, at.getTime());
    // One snapshot, so the file is consistent; the export event is in it and commits with it.
    let data;
    try {
      data = await db.transaction(
        async (tx) => {
          // First: hold the user row (KEY SHARE) until commit. A concurrent account
          // delete then waits for this export, so its pseudonymize sees the export
          // event; a delete that got there first makes this fail (no row, or a
          // serialization failure), and the export is refused.
          await lockLiveUser(tx, userId);
          await audit(
            tx,
            { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'account.export', requestId: req.id },
            at,
          );
          return buildExport(tx, config, userId, at, processors);
        },
        { isolationLevel: 'repeatable read' },
      );
    } catch (err) {
      if (isSerializationFailure(err)) throw signedOut();
      throw err;
    }
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', 'attachment; filename="kitchen-quest-export.json"')
      .send(data);
  });

  app.delete('/me', { preHandler: requireUser }, async (req, reply) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || (body as { confirm?: unknown }).confirm !== DELETE_PHRASE) {
      throw new ApiError(
        400,
        'confirmation_required',
        `Deleting your account needs your confirmation (confirm: "${DELETE_PHRASE}")`,
      );
    }
    const at = now();
    const { id: userId, email } = req.user;
    // One transaction, in this order: the delete event first (so it is pseudonymized
    // with the rest), then the user (cascading to sessions, profile, rules, meal logs, pantry,
    // conversations, messages, mentor proposals, consents, user_keys, entitlements, usage, self-read counts), then sign-in links by email,
    // then the audit trail, which the database pseudonymizes only once the user is gone.
    // A running export holds the user row, so the delete waits for it (see above).
    await db.transaction(async (tx) => {
      // Serializes with /auth/request for this email, so no sign-in link slips in
      // between deleting the links and commit.
      await lockSignInEmail(tx, email);
      await audit(
        tx,
        { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'account.delete', requestId: req.id },
        at,
      );
      const deleted = await tx.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
      if (deleted.length === 0) throw signedOut();
      await tx.delete(loginTokens).where(eq(loginTokens.email, email));
      await pseudonymizeAudit(tx, config.pseudonymKey, userId);
    });
    // The mentor's in-memory history goes too (C-12): nothing of the account is kept.
    app.mentor.memory.delete(`${userId}:`);
    reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    return reply.status(204).send();
  });
}
