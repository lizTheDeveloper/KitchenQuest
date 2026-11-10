import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { countSelfRead } from '../audit/self-reads.js';
import { ipKey, SlidingWindowLimiter, sweepPeriodically } from '../auth/rate-limit.js';
import { requireUser } from '../auth/session.js';
import type { Catalog } from '../catalog.js';
import type { Tx } from '../consent/ledger.js';
import { ApiError } from '../errors.js';
import { createRuleIn, deleteRuleIn, updateRuleIn } from './service.js';
import { loadRules, type StoredRule } from './store.js';

export { MAX_RULES_PER_USER } from './service.js';

/** Ingredient searches per client IP per minute (M-5); the search needs no sign-in. */
export const SEARCHES_PER_MINUTE = 120;

const SearchQuery = z.object({ q: z.string().max(100).default('') }).strict();

/**
 * A rule as the client sends it: `Omit<Rule, 'id'>`, the id being the row id.
 * Only the keys are fixed here; whether the values are a valid rule is core's
 * decision (`validateRules`), so they pass through as unknown.
 */
/**
 * When `value` is an object, it may hold only `keys`, so nothing beyond the
 * rule itself is sealed into health data. Its values, and whether it is an
 * object at all, are left to core, except that a string under a key in
 * `caps` may be at most that many characters (N-7, data-inventory.md §3.13).
 */
const keysOnly = (keys: readonly string[], caps: Readonly<Record<string, number>> = {}) =>
  z.unknown().superRefine((v, ctx) => {
    if (typeof v !== 'object' || v === null) return;
    if (!Object.keys(v).every((k) => keys.includes(k))) {
      ctx.addIssue({ code: 'custom', message: `Only these keys are allowed: ${keys.join(', ')}` });
      return;
    }
    // N-7: free text sealed into health data is capped; a non-string is left to core.
    for (const [k, max] of Object.entries(caps)) {
      const s = (v as Record<string, unknown>)[k];
      if (typeof s === 'string' && s.length > max) {
        ctx.addIssue({ code: 'custom', path: [k], message: `At most ${max} characters` });
      }
    }
  });

const RuleBody = z
  .object({
    target: keysOnly(['kind', 'ids']),
    type: z.unknown(),
    severity: z.unknown(),
    limit: keysOnly(['amount', 'unit', 'per'], { unit: 32 }).optional(),
    phase: keysOnly(['start', 'end', 'journeyId'], { journeyId: 64 }).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
const RuleWrite = z.object({ rule: RuleBody, confirmed: z.unknown() }).strict();

/**
 * A rule write needs an explicit yes for this rule (spec §7.0), then a body of
 * the rule's shape; both are checked here, before any query. Consent (C-11)
 * is checked once, inside the write's transaction under a row lock
 * (`lockConsentIn`, via the service), after the live-user check: so a deleted
 * account gets 401, not 403, and the check is atomic with a withdrawal.
 */
function parseWrite(req: FastifyRequest): StoredRule {
  const body = req.body;
  if (typeof body !== 'object' || body === null || (body as { confirmed?: unknown }).confirmed !== true) {
    throw new ApiError(400, 'confirmation_required', 'Saving a rule needs your confirmation (confirmed: true)');
  }
  const { rule } = RuleWrite.parse(body);
  // Drop keys sent as undefined so the stored value is exactly the rule.
  return Object.fromEntries(Object.entries(rule).filter(([, v]) => v !== undefined)) as StoredRule;
}

/**
 * Ingredient search, and the player's allergy and diet rules. Rules are
 * health data: sealed per user and row (C-3/C-4), written only with consent
 * (C-11) and `confirmed: true`, and validated by core, never by the API.
 * Writes are audited by action and rule id only (C-5); the player's own reads
 * are counted per day, not logged per read (`countSelfRead`).
 */
export async function rulesRoutes(app: FastifyInstance, catalog: Catalog): Promise<void> {
  const { db, config, now } = app.deps;
  const { keyring } = config;
  const deps = { keyring, catalog };
  // Per app instance, in memory only (N-2), like the sign-in limiters.
  const searchLimiter = new SlidingWindowLimiter(SEARCHES_PER_MINUTE, 60_000);
  const stopSweeping = sweepPeriodically([searchLimiter], () => now().getTime());
  app.addHook('onClose', (_app, done) => {
    stopSweeping();
    done();
  });

  // No sign-in needed: it searches the shared catalog, so it is limited per IP.
  // The query never reaches the log (C-9).
  app.get('/ingredients/search', async (req, reply) => {
    const t = now().getTime();
    const ip = ipKey(req.ip);
    const wait = searchLimiter.waitMs(ip, t);
    if (wait > 0) {
      reply.header('retry-after', String(Math.ceil(wait / 1000)));
      throw new ApiError(429, 'rate_limited', 'Too many searches; try again shortly');
    }
    searchLimiter.hit(ip, t);
    const { q } = SearchQuery.parse(req.query);
    return { results: catalog.graph.search(q) };
  });

  // Reading needs no consent: after a "keep" withdrawal the rules stay readable.
  app.get('/rules', { preHandler: requireUser }, async (req) => {
    const list = await loadRules(db, keyring, req.user.id);
    await countSelfRead(db, req.user.id, 'rules', now());
    return { rules: list };
  });

  app.post('/rules', { preHandler: requireUser }, async (req, reply) => {
    const at = now();
    const value = parseWrite(req);
    const rule = await db.transaction((tx: Tx) => createRuleIn(tx, deps, req.user.id, value, at, req.id));
    return reply.status(201).send({ rule });
  });

  app.put<{ Params: { id: string } }>('/rules/:id', { preHandler: requireUser }, async (req) => {
    const at = now();
    const value = parseWrite(req);
    // A malformed id is a 404 from the service, after the same locks as any other.
    const rule = await db.transaction((tx: Tx) => updateRuleIn(tx, deps, req.user.id, req.params.id, value, at, req.id));
    return { rule };
  });

  // No consent and no `confirmed` needed: deleting a rule only makes the
  // player less restricted in the app, and the UI asks before it calls this.
  // It must also work after consent is withdrawn, so the player can clear kept data.
  app.delete<{ Params: { id: string } }>('/rules/:id', { preHandler: requireUser }, async (req, reply) => {
    const at = now();
    await db.transaction((tx: Tx) => deleteRuleIn(tx, req.user.id, req.params.id, at, req.id));
    return reply.status(204).send();
  });
}
