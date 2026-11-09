import { randomUUID } from 'node:crypto';
import { validateRules, type Rule } from '@kitchenquest/core';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { countSelfRead } from '../audit/self-reads.js';
import { requireUser } from '../auth/session.js';
import type { Catalog } from '../catalog.js';
import { lockConsentIn, requireConsent, type Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { openFor, sealFor } from '../crypto/userkeys.js';
import { rules } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { Db } from '../types.js';

const SearchQuery = z.object({ q: z.string().max(100).default('') }).strict();

/**
 * A rule as the client sends it: `Omit<Rule, 'id'>`, the id being the row id.
 * Only the keys are fixed here; whether the values are a valid rule is core's
 * decision (`validateRules`), so they pass through as unknown.
 */
/**
 * When `value` is an object, it may hold only `keys`, so nothing beyond the
 * rule itself is sealed into health data. Its values, and whether it is an
 * object at all, are left to core.
 */
const keysOnly = (keys: readonly string[]) =>
  z.unknown().refine(
    (v) => typeof v !== 'object' || v === null || Object.keys(v).every((k) => keys.includes(k)),
    { message: `Only these keys are allowed: ${keys.join(', ')}` },
  );

const RuleBody = z
  .object({
    target: keysOnly(['kind', 'ids']),
    type: z.unknown(),
    severity: z.unknown(),
    limit: keysOnly(['amount', 'unit', 'per']).optional(),
    phase: keysOnly(['start', 'end', 'journeyId']).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
type StoredRule = Omit<Rule, 'id'>;

const RuleWrite = z.object({ rule: RuleBody, confirmed: z.unknown() }).strict();

const sealContext = (userId: string, rowId: string) => ({ table: 'rules', userId, rowId });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => new ApiError(404, 'not_found', 'Rule not found');

/** All of the user's rules, decrypted, oldest first, with `id` = row id. */
async function loadRules(db: Pick<Db, 'select'>, keyring: Keyring, userId: string): Promise<Rule[]> {
  const rows = await db
    .select({ id: rules.id, sealed: rules.sealed })
    .from(rules)
    .where(eq(rules.userId, userId))
    .orderBy(asc(rules.createdAt), asc(rules.id));
  const out: Rule[] = [];
  for (const row of rows) {
    const value = await openFor<StoredRule>(db, keyring, sealContext(userId, row.id), row.sealed);
    out.push({ ...value, id: row.id });
  }
  return out;
}

/**
 * Health writes need `health_data` consent (C-11), then an explicit yes for
 * this rule (spec §7.0), then a body of the rule's shape. This consent check
 * is the fast 403; the write's transaction checks again under a row lock
 * (`lockConsentIn`), which is what makes it atomic with a withdrawal.
 */
async function parseWrite(req: FastifyRequest, at: Date): Promise<StoredRule> {
  await requireConsent(req.server.deps.db, req.user.id, 'health_data', at);
  const body = req.body;
  if (typeof body !== 'object' || body === null || (body as { confirmed?: unknown }).confirmed !== true) {
    throw new ApiError(400, 'confirmation_required', 'Saving a rule needs your confirmation (confirmed: true)');
  }
  const { rule } = RuleWrite.parse(body);
  // Drop keys sent as undefined so the stored value is exactly the rule.
  return Object.fromEntries(Object.entries(rule).filter(([, v]) => v !== undefined)) as StoredRule;
}

/** Throws 400 `bad_request` with core's problems unless the user's rules, with `rule` in place, are valid. */
function assertValid(rule: Rule, others: Rule[], catalog: Catalog): void {
  const problems = validateRules([rule, ...others], catalog.graph);
  if (problems.length > 0) throw new ApiError(400, 'bad_request', 'The rule is not valid', { problems });
}

/** The caller's row id from the path, or 404 (another user's id and a malformed one look the same). */
function ruleIdParam(req: FastifyRequest<{ Params: { id: string } }>): string {
  const { id } = req.params;
  if (!UUID.test(id)) throw notFound();
  return id.toLowerCase();
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

  // No sign-in needed: it searches the shared catalog. The query never reaches the log (C-9).
  app.get('/ingredients/search', async (req) => {
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
    const value = await parseWrite(req, at);
    const userId = req.user.id;
    // Generated before insert: the seal is bound to it (C-3).
    const rowId = randomUUID();
    await db.transaction(async (tx: Tx) => {
      await lockConsentIn(tx, userId, 'health_data', at);
      assertValid({ ...value, id: rowId }, await loadRules(tx, keyring, userId), catalog);
      const sealed = await sealFor(tx, keyring, sealContext(userId, rowId), value);
      await tx.insert(rules).values({ id: rowId, userId, sealed });
      await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'rules.create', target: rowId, requestId: req.id }, at);
    });
    return reply.status(201).send({ rule: { ...value, id: rowId } });
  });

  app.put<{ Params: { id: string } }>('/rules/:id', { preHandler: requireUser }, async (req) => {
    const at = now();
    const value = await parseWrite(req, at);
    const userId = req.user.id;
    const rowId = ruleIdParam(req);
    await db.transaction(async (tx: Tx) => {
      await lockConsentIn(tx, userId, 'health_data', at);
      const [row] = await tx
        .select({ id: rules.id })
        .from(rules)
        .where(and(eq(rules.id, rowId), eq(rules.userId, userId)))
        .for('update');
      if (!row) throw notFound();
      const others = (await loadRules(tx, keyring, userId)).filter((r) => r.id !== rowId);
      assertValid({ ...value, id: rowId }, others, catalog);
      const sealed = await sealFor(tx, keyring, sealContext(userId, rowId), value);
      await tx.update(rules).set({ sealed }).where(and(eq(rules.id, rowId), eq(rules.userId, userId)));
      await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'rules.update', target: rowId, requestId: req.id }, at);
    });
    return { rule: { ...value, id: rowId } };
  });

  // No consent and no `confirmed` needed: deleting a rule only makes the
  // player less restricted in the app, and the UI asks before it calls this.
  // It must also work after consent is withdrawn, so the player can clear kept data.
  app.delete<{ Params: { id: string } }>('/rules/:id', { preHandler: requireUser }, async (req, reply) => {
    const at = now();
    const userId = req.user.id;
    const rowId = ruleIdParam(req);
    await db.transaction(async (tx: Tx) => {
      const deleted = await tx
        .delete(rules)
        .where(and(eq(rules.id, rowId), eq(rules.userId, userId)))
        .returning({ id: rules.id });
      if (deleted.length === 0) throw notFound();
      await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'rules.delete', target: rowId, requestId: req.id }, at);
    });
    return reply.status(204).send();
  });
}
