import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { countSelfRead } from '../audit/self-reads.js';
import { ipKey, SlidingWindowLimiter, sweepPeriodically } from '../auth/rate-limit.js';
import { requireUser } from '../auth/session.js';
import type { Catalog } from '../catalog.js';
import type { Tx } from '../consent/ledger.js';
import { ApiError } from '../errors.js';
import { createRuleIn, deleteRuleIn, RuleBody, updateRuleIn } from './service.js';
import { loadRules, loadRuleVersions, type StoredRule } from './store.js';

export { MAX_RULES_PER_USER } from './service.js';

/** Ingredient searches per client IP per minute (M-5); the search needs no sign-in. */
export const SEARCHES_PER_MINUTE = 120;

const SearchQuery = z.object({ q: z.string().max(100).default('') }).strict();

/** The body of POST and PUT: the rule (parsed again by the service, which owns its shape) and the player's yes. */
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
  // Parsed here too so a shape error names its path under `rule` (e.g. `rule.note`).
  const { rule } = RuleWrite.parse(body);
  return rule as StoredRule;
}

/** `If-Match: "<version>"` (N4): the rule version the write expects, or undefined when absent; anything else is a 400. */
function ifMatchVersion(req: FastifyRequest): number | undefined {
  const raw = req.headers['if-match'];
  if (raw === undefined) return undefined;
  const m = /^"?([1-9]\d{0,9})"?$/.exec(Array.isArray(raw) ? (raw[0] ?? '') : raw.trim());
  if (!m) throw new ApiError(400, 'bad_request', 'If-Match must be a rule version, e.g. "3"');
  return Number(m[1]);
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
    const versions = await loadRuleVersions(db, req.user.id);
    await countSelfRead(db, req.user.id, 'rules', now());
    return { rules: list, versions };
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
    const expected = ifMatchVersion(req);
    // A malformed id is a 404 from the service, after the same locks as any other.
    const { rule, version } = await db.transaction((tx: Tx) => updateRuleIn(tx, deps, req.user.id, req.params.id, value, at, req.id, expected));
    return { rule, version };
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
