import { and, inArray, isNotNull, lt, lte, or } from 'drizzle-orm';
import { purgeAuditBefore } from '../audit/audit.js';
import { loggableError } from '../errors.js';
import { aiCostHours, conversations, loginTokens, marketRuns, mealPlans, mentorProposals, messages, selfReadCounts, sessions, usageEvents } from '../db/schema.js';
import { PLAN_RETENTION_WEEKS } from '../week/store.js';
import { TRANSCRIPT_RETENTION_DAYS } from '../mentor/constants.js';
import { undecidedExpired } from '../mentor/proposals.js';
import type { Db } from '../types.js';

/** One table's retention rule (C-6): `run` deletes what has expired at `now` and returns how many rows. */
export interface RetentionPolicy {
  table: string;
  run(db: Db, now: Date): Promise<number>;
}

const policies = new Map<string, RetentionPolicy>();

/** One policy's failure; `runRetention` throws an AggregateError of these. */
class RetentionError extends Error {
  constructor(
    readonly table: string,
    cause: unknown,
  ) {
    super(`retention failed for ${table}`, { cause });
    this.name = 'RetentionError';
  }
}

/** Each table declares its policy once; later milestones register theirs (Pantry posts, photos). */
export function registerRetention(policy: RetentionPolicy): void {
  if (policies.has(policy.table)) throw new Error(`retention policy for ${policy.table} is already registered`);
  policies.set(policy.table, policy);
}

/** Tables with a registered policy. */
export function retentionPolicies(): string[] {
  return [...policies.keys()];
}

/**
 * Runs every policy at the injected `now` and returns rows deleted per table.
 * One failing policy does not stop the others; the failures are thrown together at the end.
 */
export async function runRetention(db: Db, now: Date): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const errors: unknown[] = [];
  for (const p of policies.values()) {
    try {
      counts[p.table] = await p.run(db, now);
    } catch (err) {
      errors.push(new RetentionError(p.table, err));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `retention failed for ${errors.length} table(s)`);
  return counts;
}

const HOUR = 60 * 60 * 1000;

/** Loggable form of a retention failure: each failed table with its scrubbed error. */
function retentionFailures(err: unknown): { table: string; error: ReturnType<typeof loggableError> }[] {
  const list = err instanceof AggregateError ? err.errors : [err];
  return list.map((e) =>
    e instanceof RetentionError
      ? { table: e.table, error: loggableError(e.cause) }
      : { table: '(unknown)', error: loggableError(e) },
  );
}

function monthsBefore(now: Date, months: number): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

const deleted = async (q: Promise<unknown[]>) => (await q).length;

// login_tokens: 24 hours after expiry or use.
registerRetention({
  table: 'login_tokens',
  run: (db, now) => {
    const cutoff = new Date(now.getTime() - 24 * HOUR);
    return deleted(
      db
        .delete(loginTokens)
        .where(or(lt(loginTokens.expiresAt, cutoff), and(isNotNull(loginTokens.usedAt), lt(loginTokens.usedAt, cutoff))))
        .returning({ id: loginTokens.id }),
    );
  },
});

// sessions: on expiry (a session is live only while expires_at > now).
registerRetention({
  table: 'sessions',
  run: (db, now) => deleted(db.delete(sessions).where(lte(sessions.expiresAt, now)).returning({ id: sessions.id })),
});

// usage_events: 13 months.
registerRetention({
  table: 'usage_events',
  run: (db, now) =>
    deleted(db.delete(usageEvents).where(lt(usageEvents.createdAt, monthsBefore(now, 13))).returning({ id: usageEvents.id })),
});

// ai_cost_hours: 48 hours; the global budget reads only the last 24 (M4 Step 7, P5).
registerRetention({
  table: 'ai_cost_hours',
  run: (db, now) =>
    deleted(db.delete(aiCostHours).where(lt(aiCostHours.hour, new Date(now.getTime() - 48 * 3_600_000))).returning({ hour: aiCostHours.hour })),
});

// audit_events: 24 months, through the append-only trigger's purge function.
registerRetention({
  table: 'audit_events',
  run: (db, now) => purgeAuditBefore(db, monthsBefore(now, 24)),
});

// self_read_counts: 24 months, like the audit trail it stands in for; a day is
// kept while any part of it is within the window.
registerRetention({
  table: 'self_read_counts',
  run: (db, now) =>
    deleted(
      db
        .delete(selfReadCounts)
        .where(lt(selfReadCounts.day, monthsBefore(now, 24).toISOString().slice(0, 10)))
        .returning({ day: selfReadCounts.day }),
    ),
});

// Mentor transcripts (C-12): messages 30 days after they were written, then
// conversations 30 days after their last turn (taking any messages left with them).
const TRANSCRIPT_RETENTION_MS = TRANSCRIPT_RETENTION_DAYS * 24 * HOUR;
registerRetention({
  table: 'messages',
  run: (db, now) =>
    deleted(db.delete(messages).where(lt(messages.createdAt, new Date(now.getTime() - TRANSCRIPT_RETENTION_MS))).returning({ id: messages.id })),
});
registerRetention({
  table: 'conversations',
  run: (db, now) =>
    deleted(
      db
        .delete(conversations)
        .where(lt(conversations.lastTurnAt, new Date(now.getTime() - TRANSCRIPT_RETENTION_MS)))
        .returning({ id: conversations.id }),
    ),
});

// mentor_proposals: an undecided card ('open' or 'expired') as soon as its
// expires_at has passed; a decided one 24 hours after it was made, well past
// UNDO_WINDOW_MS (the undo and audit period). data-inventory I-4.
registerRetention({
  table: 'mentor_proposals',
  run: (db, now) =>
    deleted(
      db
        .delete(mentorProposals)
        .where(or(undecidedExpired(now), lt(mentorProposals.createdAt, new Date(now.getTime() - 24 * HOUR))))
        .returning({ id: mentorProposals.id }),
    ),
});

// Plans and market runs (H-11, Ruling 18): PLAN_RETENTION_WEEKS weeks after the plan week ends. A plan week runs 7
// days from `week_start`, so a plan goes once `week_start + 7 + 7 × PLAN_RETENTION_WEEKS` days is today or earlier
// (UTC date of `now`); this week's, and the last 8 weeks', stay. Runs first (they would go with their plan anyway).
const DAY = 24 * HOUR;
/** The newest `week_start` whose plan and run have expired at `now`. */
export function expiredPlanWeek(now: Date): string {
  return new Date(Date.parse(now.toISOString().slice(0, 10)) - (7 + 7 * PLAN_RETENTION_WEEKS) * DAY).toISOString().slice(0, 10);
}
registerRetention({
  table: 'market_runs',
  run: async (db, now) => {
    const expired = db.select({ id: mealPlans.id }).from(mealPlans).where(lte(mealPlans.weekStart, expiredPlanWeek(now)));
    return deleted(db.delete(marketRuns).where(inArray(marketRuns.planId, expired)).returning({ id: marketRuns.id }));
  },
});
registerRetention({
  table: 'meal_plans',
  run: (db, now) => deleted(db.delete(mealPlans).where(lte(mealPlans.weekStart, expiredPlanWeek(now))).returning({ id: mealPlans.id })),
});

/**
 * The scheduled task: runs retention now and then every `everyMs` (hourly by
 * default), logging counts only. Returns a stop function.
 */
export function scheduleRetention(
  db: Db,
  now: () => Date,
  log: { info(o: object, msg: string): void; error(o: object, msg: string): void },
  everyMs = HOUR,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      log.info({ deleted: await runRetention(db, now()) }, 'retention run');
    } catch (err) {
      log.error({ failures: retentionFailures(err) }, 'retention run failed');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
