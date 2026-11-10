import { randomUUID } from 'node:crypto';
import { validateRules, type Rule } from '@kitchenquest/core';
import { and, eq, sql } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { Catalog } from '../catalog.js';
import { lockConsentIn, type Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { sealFor } from '../crypto/userkeys.js';
import { rules } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { loadRules, ruleSealContext, type StoredRule } from './store.js';

/** At most this many rules per player (M-5; data-inventory.md §3.13). */
export const MAX_RULES_PER_USER = 200;

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
 * Serializes the user's rule writes: pg_advisory_xact_lock(hashtextextended('rules:' || userId, 0)),
 * held until commit. With it, the 200-rule cap and core's cross-rule
 * validation see every committed write of the same user, so neither can be
 * beaten by two writes racing. Re-entrant within one transaction.
 *
 * One global lock order (pre-flight C13), for every transaction in M4:
 * user row (`lockLiveUser`) → per-user advisory locks (`rules:<id>`, then
 * `pantry:<id>`) → consent row (`lockConsentIn`) → proposal row
 * (`lockProposal`). Account delete takes the user row first, so it still
 * serializes ahead. Consent withdraw-with-delete takes the user row, then the
 * consent row, then deletes rules, meals, messages and proposals, which fits
 * the order. Call this right after `lockLiveUser`, before `lockConsentIn`.
 */
export async function lockUserRules(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'rules:' + userId}, 0))`);
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
 * audit 'rules.create'. The caller has already checked the player's explicit yes.
 */
export async function createRuleIn(
  tx: Tx,
  deps: RuleDeps,
  userId: string,
  value: StoredRule,
  at: Date,
  requestId?: string,
): Promise<Rule> {
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

/**
 * Replaces one of the user's rules, inside the caller's transaction, in the
 * same lock order as `createRuleIn`; 404 when `rowId` is not the user's.
 * Audits 'rules.update'.
 */
export async function updateRuleIn(
  tx: Tx,
  deps: RuleDeps,
  userId: string,
  rowIdParam: string,
  value: StoredRule,
  at: Date,
  requestId?: string,
): Promise<Rule> {
  await lockForHealthWrite(tx, userId, at);
  const rowId = ruleRowId(rowIdParam);
  const [row] = await tx
    .select({ id: rules.id })
    .from(rules)
    .where(and(eq(rules.id, rowId), eq(rules.userId, userId)))
    .for('update');
  if (!row) throw notFound();
  const others = (await loadRules(tx, deps.keyring, userId)).filter((r) => r.id !== rowId);
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
