import { and, isNotNull, lt, lte, or } from 'drizzle-orm';
import { purgeAuditBefore } from '../audit/audit.js';
import { loginTokens, sessions, usageEvents } from '../db/schema.js';
import type { Db } from '../types.js';

/** One table's retention rule (C-6): `run` deletes what has expired at `now` and returns how many rows. */
export interface RetentionPolicy {
  table: string;
  run(db: Db, now: Date): Promise<number>;
}

const policies = new Map<string, RetentionPolicy>();

/** Each table declares its policy once; later milestones register theirs (transcripts, Pantry posts, photos). */
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
      errors.push(err);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `retention failed for ${errors.length} table(s)`);
  return counts;
}

const HOUR = 60 * 60 * 1000;

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

// audit_events: 24 months, through the append-only trigger's purge function.
registerRetention({
  table: 'audit_events',
  run: (db, now) => purgeAuditBefore(db, monthsBefore(now, 24)),
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
      log.error({ err }, 'retention run failed');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
