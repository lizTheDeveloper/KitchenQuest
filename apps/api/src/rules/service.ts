import { randomUUID } from 'node:crypto';
import { validateRules, type IngredientGraph, type Rule, type Severity } from '@kitchenquest/core';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { assertUnderWriteCap } from '../usage/write-cap.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { Catalog } from '../catalog.js';
import { lockConsentIn, type Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { sealFor } from '../crypto/userkeys.js';
import { ADVISORY_LOCK } from '../db/advisory-locks.js';
import { rules } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { loadRules, ruleSealContext, type StoredRule } from './store.js';

/** At most this many rules per player (M-5; data-inventory.md §3.13). */
export const MAX_RULES_PER_USER = 200;

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

export const RuleBody = z
  .object({
    target: keysOnly(['kind', 'ids']),
    type: z.unknown(),
    severity: z.unknown(),
    limit: keysOnly(['amount', 'unit', 'per'], { unit: 32 }).optional(),
    phase: keysOnly(['start', 'end', 'journeyId'], { journeyId: 64 }).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
/**
 * `value` checked against the strict rule shape (`RuleBody`; throws a
 * ZodError, a 400 in the API), with keys holding undefined dropped, so what
 * is sealed is exactly the rule. Every write parses here, whoever calls it
 * (the REST routes, the mentor's confirm path), so no caller can seal extra keys.
 */
function parseStoredRule(value: unknown): StoredRule {
  const rule = RuleBody.parse(value);
  return Object.fromEntries(Object.entries(rule).filter(([, v]) => v !== undefined)) as StoredRule;
}

/** What a rule write needs beyond the transaction: the key ring (sealing) and the catalog (core validation). */
export interface RuleDeps {
  keyring: Keyring;
  catalog: Catalog;
}

const notFound = () => new ApiError(404, 'not_found', 'Rule not found');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `rowId` lowercased, or 404 (another user's id and a malformed one look the same, and never reach the database). */
function ruleRowId(rowId: string): string {
  if (!UUID.test(rowId)) throw notFound();
  return rowId.toLowerCase();
}

/**
 * Serializes the user's rule writes: pg_advisory_xact_lock(ADVISORY_LOCK.rules, hashtext(userId)),
 * held until commit. With it, the 200-rule cap and core's cross-rule
 * validation see every committed write of the same user, so neither can be
 * beaten by two writes racing. Re-entrant within one transaction.
 *
 * One global lock order (pre-flight C13), for every transaction in M4:
 * user row (`lockLiveUser`) → per-user advisory locks (`rules:<id>`, then
 * `pantry:<id>`; namespaces in `db/advisory-locks.ts`) → consent row
 * (`lockConsentIn`) → proposal row (`lockProposal`). Account delete takes
 * its sign-in-email lock, then the user row, before anything else, so it
 * still serializes ahead. Consent withdraw-with-delete takes the user row,
 * then the consent row, then deletes rules, meals, messages and proposals,
 * which fits the order. Call this right after `lockLiveUser`, before `lockConsentIn`.
 */
export async function lockUserRules(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK.rules}, hashtext(${userId}))`);
}

/** Throws 400 `bad_request` with core's problems unless the user's rules, with `rule` in place, are valid. */
function assertValid(rule: Rule, others: Rule[], catalog: Catalog): void {
  const problems = validateRules([rule, ...others], catalog.graph);
  if (problems.length > 0) throw new ApiError(400, 'bad_request', 'The rule is not valid', { problems });
}

/** Live user (401), then the user's rule lock, then `health_data` consent (403). */
async function lockForHealthWrite(tx: Tx, userId: string, at: Date): Promise<void> {
  await lockLiveUser(tx, userId);
  await lockUserRules(tx, userId);
  await lockConsentIn(tx, userId, 'health_data', at);
}

/**
 * Saves a new rule for the user, inside the caller's transaction. Lock order:
 * live user (401) → user rules → health_data consent (403) → cap (400
 * too_many_rules) → core validation (400 bad_request) → seal → insert →
 * audit 'rules.create'. The rule's shape is parsed first, before any query
 * (`RuleBody`). The caller has already checked the player's explicit yes.
 */
export async function createRuleIn(
  tx: Tx,
  deps: RuleDeps,
  userId: string,
  input: StoredRule,
  at: Date,
  requestId?: string,
): Promise<Rule> {
  const value = parseStoredRule(input);
  await lockForHealthWrite(tx, userId, at);
  const existing = await loadRules(tx, deps.keyring, userId);
  if (existing.length >= MAX_RULES_PER_USER) {
    throw new ApiError(400, 'too_many_rules', `You can save at most ${MAX_RULES_PER_USER} rules`, { max: MAX_RULES_PER_USER });
  }
  // Generated before insert: the seal is bound to it (C-3).
  const rowId = randomUUID();
  assertValid({ ...value, id: rowId }, existing, deps.catalog);
  const sealed = await sealFor(tx, deps.keyring, ruleSealContext(userId, rowId), value, at);
  await tx.insert(rules).values({ id: rowId, userId, sealed, createdAt: at, updatedAt: at });
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'rules.create', target: rowId, requestId }, at);
  return { ...value, id: rowId };
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { preference: 0, intolerance: 1, allergy: 2, anaphylactic: 3 };
/** How much a rule blocks: avoid blocks more than limit, limit more than prefer. */
const TYPE_RANK: Readonly<Record<StoredRule['type'], number>> = { prefer: 0, limit: 1, avoid: 2 };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * `next` blocks at least what `prev` did: every old target is still a target (itself, or under a new
 * category's kinds, with `graph`), the type blocks no less (avoid > limit > prefer; two limits must
 * match), the severity is no milder, and the phase is unchanged. Such an edit is never write-capped
 * (never rule 1). Fix round 1 (M6): category widening and limit → avoid count as stricter.
 */
export function atLeastAsStrict(prev: StoredRule, next: StoredRule, graph?: IngredientGraph): boolean {
  const covers = (id: string) =>
    next.target.ids.includes(id) ||
    (graph !== undefined && next.target.kind === 'category' && prev.target.kind !== 'component' &&
      next.target.ids.some((n) => graph.has(n) && graph.descendants(n).includes(id)));
  const kindOk = prev.target.kind === next.target.kind || (prev.target.kind === 'ingredient' && next.target.kind === 'category');
  return (
    kindOk &&
    prev.target.ids.every(covers) &&
    TYPE_RANK[next.type] >= TYPE_RANK[prev.type] &&
    (next.type !== 'limit' || same(prev.limit, next.limit)) &&
    SEVERITY_RANK[next.severity] >= SEVERITY_RANK[prev.severity] &&
    same(prev.phase, next.phase)
  );
}

/**
 * Replaces one of the user's rules, inside the caller's transaction, in the
 * same lock order as `createRuleIn`; 404 when `rowId` is not the user's.
 * A loosening edit past WRITES_PER_DAY in a day is a 429 (usage/write-cap.ts).
 * Audits 'rules.update'.
 */
export async function updateRuleIn(
  tx: Tx,
  deps: RuleDeps,
  userId: string,
  rowIdParam: string,
  input: StoredRule,
  at: Date,
  requestId?: string,
): Promise<Rule> {
  const value = parseStoredRule(input);
  await lockForHealthWrite(tx, userId, at);
  const rowId = ruleRowId(rowIdParam);
  const [row] = await tx
    .select({ id: rules.id })
    .from(rules)
    .where(and(eq(rules.id, rowId), eq(rules.userId, userId)))
    .for('update');
  if (!row) throw notFound();
  const all = await loadRules(tx, deps.keyring, userId);
  const before = all.find((r) => r.id === rowId);
  // A loosening (or sideways) edit counts against the daily write cap; a stricter one never does.
  if (before === undefined || !atLeastAsStrict(before, value, deps.catalog.graph)) await assertUnderWriteCap(tx, userId, ['rules.update'], at);
  const others = all.filter((r) => r.id !== rowId);
  assertValid({ ...value, id: rowId }, others, deps.catalog);
  const sealed = await sealFor(tx, deps.keyring, ruleSealContext(userId, rowId), value, at);
  await tx.update(rules).set({ sealed, updatedAt: at }).where(and(eq(rules.id, rowId), eq(rules.userId, userId)));
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'rules.update', target: rowId, requestId }, at);
  return { ...value, id: rowId };
}

/**
 * Deletes one of the user's rules, inside the caller's transaction: live user
 * (401), then the user's rule lock; 404 when `rowId` is not the user's.
 * No consent needed (M2): deleting only makes the player less restricted, and
 * it must work after a "keep" withdrawal so kept data can be cleared.
 * Audits 'rules.delete'.
 */
export async function deleteRuleIn(tx: Tx, userId: string, rowIdParam: string, at: Date, requestId?: string): Promise<void> {
  await lockLiveUser(tx, userId);
  await lockUserRules(tx, userId);
  const rowId = ruleRowId(rowIdParam);
  const deleted = await tx
    .delete(rules)
    .where(and(eq(rules.id, rowId), eq(rules.userId, userId)))
    .returning({ id: rules.id });
  if (deleted.length === 0) throw notFound();
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'rules.delete', target: rowId, requestId }, at);
}
