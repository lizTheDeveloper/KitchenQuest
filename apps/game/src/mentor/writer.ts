import {
  confirmedLines, isSevereCard, pantryMatcher, rejectedLine, SEVERE, trailSummary, undoneLine, UNDO_WINDOW_MS, validateRules, withSeverity,
  type CheckOffCard, type CheckResult, type IngredientGraph, type LineRef, type MarginNote, type PantryItem, type Plan, type PlanCard, type ProposalCard, type ReplyPart,
  type Rule, type RuleTerm, type ServerCard, type Severity, type SharedEntry, type TrailEntry,
} from '@kitchenquest/core/engine';
import { localDate } from '../recipes/rules';
import type { WeekTurn } from './week-turn';
import { refreshAccount } from '../api/account';
import type { ApiClient } from '../api/client';
import type { ApiResult, Profile } from '../api/types';
import { rulesStateForApiError } from '../recipes/rules';
import { routeHref } from '../shell/router';
import type { LocalProfile, PlayerStore } from '../state/store';
import type { Dialogue } from './dialogue';
import type { CardView, PanItem } from './reply';

/**
 * Runs a card the player confirmed, turned down or wants undone (M4 Step 9). Server cards go through the
 * Step 8 write guard. Local cards (the scripted engine's) go through the M2/M5 REST routes when signed in, or
 * to the device store when signed out; their undo data lives only in this writer's memory. A severe card is
 * never written on a typed yes (§7.6), and each card is written at most once.
 */
export type WriteOutcome =
  /** `ticked`: a check-off card's row keys actually ticked (M6 fix round 1, m2). */
  | { ok: true; trail: TrailEntry; items: PanItem[]; ticked?: string[]; already?: string[] }
  /** `busy`: this card's write is already in flight (a tap and a typed yes at once); nothing to show, the first one answers. */
  /** `limited`: the daily write limit (the same for every plan, never sold): the card stays open, the line says so. */
  | { ok: false; reason: 'tap_required' | 'consent_required' | 'needs_account' | 'invalid' | 'closed' | 'network' | 'busy' | 'limited'; items: PanItem[] }
  /**
   * M5 Step 10 (409 `plan_changed`): the week changed since the plan card was shown. Nothing was saved; the card
   * closes and is offered again on the week as it is now (`offered`: a local card, a server proposal, or none).
   */
  | { ok: false; reason: 'plan_changed'; items: PanItem[]; offered: ProposalCard | ServerCard | null };

/**
 * What an undo did (Step 8 fix round 1 carry). `undone`: reversed, drop the trail entry. `nothing`: there was
 * nothing to reverse (the window closed, the card vanished), drop it. `busy`: an undo of this entry is already in
 * flight; nothing changes and the first one answers. `full`: the pantry is at its limit and
 * nothing changed, keep it while the window is open. `failed`: offline or a server error, keep it to try again.
 */
export interface UndoOutcome { status: 'undone' | 'nothing' | 'full' | 'failed' | 'busy'; items: PanItem[] }

/**
 * M5 Step 11: the after-cook cards, built by the game's code (after-cook.ts) and kept only by the player's tap.
 * A margin note (Form 2-M/MARGIN) is health data (Ruling 9); a Shared Table entry (Form 5-S) holds fixed values only
 * (Ruling 10). Both are account-only. `summary` is the code-built read-back.
 */
interface MarginNoteCard { kind: 'margin_note'; note: MarginNote; summary: string }
interface CookedForCard { kind: 'cooked_for'; entry: SharedEntry; summary: string }
export type BookCard = MarginNoteCard | CookedForCard;

/**
 * What keeping a book card did. `id` is the stored row's (its undo deletes exactly that row). `check` is the server's
 * "cook with my notes" check over all the player's notes on the dish (margin notes only). Refusals: `consent_required`
 * (the consent card is in `items`), `needs_account`, `too_many` (400 `too_many_notes`), `limited` (the daily write
 * cap), `network`, `invalid`, `busy`, and `family_table` (§19: nothing is kept).
 */
export type KeepOutcome =
  | { ok: true; id: string; items: PanItem[]; check: CheckResult | null; undoUntil: string }
  | { ok: false; reason: 'consent_required' | 'needs_account' | 'too_many' | 'limited' | 'network' | 'invalid' | 'busy' | 'family_table'; items: PanItem[] };

export interface CardWriter {
  /** severe + typed_yes → tap_required, with no call. */
  confirm(card: CardView, via: 'tap' | 'typed_yes', edits?: { severity?: Severity }): Promise<WriteOutcome>;
  /**
   * Raise an account rule to the stricter severity of this rule card (the rules screen's "Raise it on my account"),
   * by the card's tap: the write has an undo that puts the account's rule back as it was. Signed-in only.
   */
  raiseRule(card: CardView, accountRule: Rule): Promise<WriteOutcome>;
  reject(card: CardView): Promise<PanItem[]>;
  undo(entry: TrailEntry): Promise<UndoOutcome>;
  /**
   * M5 Step 11: keep a margin note (POST /notes) or a Shared Table entry (POST /shared-table) the player tapped, with
   * their local date as `today`. Each card object is kept at most once (a second tap while the first is in flight is `busy`).
   */
  keep(card: BookCard): Promise<KeepOutcome>;
  /** Undo a kept book card: deletes exactly that row (a row already gone counts as undone). Never touches anything earned. */
  unkeep(kind: BookCard['kind'], id: string): Promise<'undone' | 'failed' | 'family_table'>;
}

/** Strictest first: a raise may only move a rule up this ranking. */
export const SEVERITY_RANK: Readonly<Record<Rule['severity'], number>> = { anaphylactic: 3, allergy: 2, intolerance: 1, preference: 0 };
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
const sameTarget = (a: Rule, b: Omit<Rule, 'id'>) => a.type === b.type && a.target.kind === b.target.kind && sameIds(a.target.ids, b.target.ids);

type Row = PantryItem & { id: string };
const EMPTY_PROFILE: LocalProfile = { marketDays: [], mealsPerWeek: null, country: null, region: null, mealWindows: [] };

/** How to reverse a local write, kept in memory only. */
type Undo =
  | { kind: 'rule'; card: ProposalCard; where: 'account' | 'device'; id: string }
  | { kind: 'raise'; card: ProposalCard; id: string; before: Omit<Rule, 'id'>; wrote: Rule }
  | { kind: 'meal'; card: ProposalCard; id: string }
  | { kind: 'profile'; card: ProposalCard; where: 'account'; before: Partial<Profile> }
  | { kind: 'profile'; card: ProposalCard; where: 'device'; before: LocalProfile | null }
  | { kind: 'pantry'; card: ProposalCard; where: 'account' | 'device'; removed: Row[]; addedIds: string[] }
  | { kind: 'plan'; card: ProposalCard; weekStart: string; previous: Plan | null }
  /** M6 Step 10: a check-off card's undo (the week's code unticks exactly the rows it ticked); false: try again. */
  | { kind: 'check_off'; card: ProposalCard; undo: () => Promise<boolean> };

/**
 * Reply parts as panel items. A `text` part is dropped: the model's free text is never shown (ruling R9).
 */
export function partsToItems(parts: readonly ReplyPart[], dialogue: Dialogue): PanItem[] {
  return parts.flatMap((p): PanItem[] => {
    switch (p.kind) {
      case 'line': return [{ kind: 'said', said: dialogue.say(p.line.trigger, p.line.vars) }];
      case 'choices': return [{ kind: 'choices', options: p.options, severity: p.severity }];
      case 'consent': return [{ kind: 'consent', purpose: p.purpose }];
      // A navigation chip (Ruling 15): its nav.offer line on a button; only a tap navigates.
      case 'go': return [{ kind: 'go', target: p.target, said: dialogue.say(p.line.trigger, p.line.vars) }];
      case 'text':
        if (import.meta.env.DEV) console.warn('mentor: a text part from the server was dropped (ruling R9)');
        return [];
      // M7: the server sends a heard card only for a transcript turn, which this device sends from Step 9 on; it is
      // drawn there (P7). Until then it is ignored, and nothing in it was acted on.
      case 'heard': return [];
    }
  });
}

const isConsentPurpose = (x: unknown): x is 'health_data' | 'ai_health' => x === 'health_data' || x === 'ai_health';

export function createCardWriter(deps: {
  client: ApiClient; store: PlayerStore; dialogue: Dialogue; graph: IngredientGraph; ruleTerms: readonly RuleTerm[]; now: () => Date;
  /** M5 Step 10: the week's code (a plan card's write and undo), loaded on first use (Ruling 1). */
  week?: () => Promise<WeekTurn>;
  /**
   * The AI conversation the player is in now (undefined: none). A server card's tap names it, so the server closes a
   * card from an earlier or cleared conversation instead of writing it (fix round 5, H2).
   */
  conversationId?: () => string | null | undefined;
}): CardWriter {
  const { client, store, dialogue, graph, ruleTerms } = deps;
  // The week's code loads with the first plan write or undo, so first paint doesn't carry it.
  const weekTurn = (): Promise<WeekTurn> => deps.week?.() ?? import('./week-turn').then((m) => m.createWeekTurn({
    store, client, now: deps.now, dialogue, recipes: [], cooks: {},
  }));
  const today = () => localDate(deps.now());
  const inFlight = new Set<string>();
  const undoing = new Set<string>();
  const closed = new Set<string>();
  const undos = new Map<string, Undo>();
  const keeping = new WeakSet<BookCard>();
  const kept = new WeakSet<BookCard>();

  const say = (l: LineRef): PanItem => ({ kind: 'said', said: dialogue.say(l.trigger, l.vars) });
  const line = (trigger: string, vars: Record<string, string> = {}): PanItem => say({ trigger, vars });
  const keyOf = (c: CardView) => (c.origin === 'server' ? `server:${c.proposalId}` : `local:${c.localId}`);
  const signedIn = () => store.get().account !== null;
  /** §19: in Family Table mode nothing is written or kept, whatever asks (defence in depth: the panel has no text box). */
  const familyTable = () => store.get().settings.familyTable;
  /**
   * Fix round 1 (I1): the change lands in the cached account rules at once, so a refresh that is rate-limited or
   * offline (which keeps the cache) can't leave a stamped allergen out. Rules that never loaded stay unloaded (fail closed).
   */
  const editAccountRules = (email: string | undefined, fn: (rules: Rule[]) => Rule[]) =>
    // Fix round 2 (E5): only on the account the call was made for; a sign-out or another sign-in meanwhile wins.
    store.update((s) => (s.accountRules === null || email === undefined || s.account?.email !== email ? s : { ...s, accountRules: fn(s.accountRules) }));
  const accountEmail = () => store.get().account?.email;
  const trail = (id: string, origin: TrailEntry['origin'], card: ProposalCard): TrailEntry =>
    ({ id, origin, kind: card.kind, summary: trailSummary(card), undoUntil: new Date(deps.now().getTime() + UNDO_WINDOW_MS).toISOString() });

  /** A refused or failed call as an outcome: 403 asks for consent (the card stays open), 409 is closed, status 0 is offline. */
  function refused(r: Extract<ApiResult<unknown>, { ok: false }>, card: ProposalCard): Extract<WriteOutcome, { ok: false }> {
    const { status, error } = r;
    const rulesError = rulesStateForApiError(error, status);
    if (rulesError?.status === 'error') {
      return { ok: false, reason: 'invalid', items: [{ kind: 'rules_error', message: rulesError.message, href: routeHref({ name: 'rules' }) }] };
    }
    if (status === 403 && error.code === 'consent_required') {
      const purpose = (error.details as { purpose?: unknown } | undefined)?.purpose;
      return { ok: false, reason: 'consent_required', items: [line('consent.health_first'), { kind: 'consent', purpose: isConsentPurpose(purpose) ? purpose : 'health_data' }] };
    }
    if ((status === 409 && error.code === 'proposal_closed') || status === 404) return { ok: false, reason: 'closed', items: [] };
    if (status === 400 && error.code === 'tap_required') return { ok: false, reason: 'tap_required', items: [tapNeeded(card)] };
    // Ruling 5: a plan the rules now refuse (a dish ⛔ since the card was built). The server closed the card; its own
    // `plan.blocked_dish` lines say which dish, and are shown, never dropped.
    if (status === 400 && error.code === 'plan_invalid' && card.kind === 'plan') {
      const parts = (error.details as { parts?: unknown } | undefined)?.parts;
      const items = Array.isArray(parts) ? partsToItems(parts as ReplyPart[], dialogue) : [];
      return { ok: false, reason: 'closed', items: items.length > 0 ? items : [line('write.not_done')] };
    }
    if (status === 401) return { ok: false, reason: 'needs_account', items: [] };
    // The daily write cap (only it sets details.scope 'day', M5 final m2; the per-minute limiters also send
    // retryAfterSeconds): trying again would fail for hours, so say so instead of "try again" (M4 final, 429 on the tap).
    if (isWriteCap(r)) return { ok: false, reason: 'limited', items: [line('write.daily_limit')] };
    // Offline, rate-limited or a server error: nothing is known to be written, and the card stays open to try again.
    if (status === 0 || status === 429 || status >= 500) return { ok: false, reason: 'network', items: [] };
    return { ok: false, reason: 'invalid', items: [line('write.not_done')] };
  }
  /** A refused book write (Step 11): consent asks with the card; the cap, offline and the rest say nothing new. */
  function keepRefused(r: Extract<ApiResult<unknown>, { ok: false }>): Extract<KeepOutcome, { ok: false }> {
    if (r.status === 403 && r.error.code === 'consent_required') {
      return { ok: false, reason: 'consent_required', items: [line('consent.health_first'), { kind: 'consent', purpose: 'health_data' }] };
    }
    if (r.status === 401) return { ok: false, reason: 'needs_account', items: [] };
    if (isWriteCap(r)) return { ok: false, reason: 'limited', items: [line('write.daily_limit')] };
    if (r.status === 0 || r.status === 429 || r.status >= 500) return { ok: false, reason: 'network', items: [] };
    return { ok: false, reason: 'invalid', items: [line('write.not_done')] };
  }
  const isWriteCap = (r: Extract<ApiResult<unknown>, { ok: false }>) =>
    r.status === 429 && (r.error.details as { scope?: unknown } | undefined)?.scope === 'day';
  const tapNeeded = (card: ProposalCard): PanItem => line('rule.tap_needed', { ingredient: card.kind === 'rule' ? card.display.ingredient : '' });

  /** A local card written to the account (signed in) or the device (signed out). */
  async function writeLocal(card: ProposalCard): Promise<WriteOutcome> {
    const account = signedIn();
    switch (card.kind) {
      case 'rule': {
        if (account) {
          const email = accountEmail();
          const r = await client.createRule(card.rule, true);
          if (!r.ok) return refused(r, card);
          const saved = r.data.rule;
          editAccountRules(email, (rules) => [...rules.filter((x) => x.id !== saved.id), saved]);
          await refreshAccount(client, store);
          undos.set(r.data.rule.id, { kind: 'rule', card, where: 'account', id: r.data.rule.id });
          return { ok: true, trail: trail(r.data.rule.id, 'local', card), items: confirmedLines(card).map(say) };
        }
        const rule = { ...card.rule, id: crypto.randomUUID() };
        // Validated against the rules this update builds on (another tab's writes included), not this tab's memory.
        const after = store.update((s) =>
          (validateRules([...s.localRules, rule], graph).length === 0 ? { ...s, localRules: [...s.localRules, rule] } : s));
        if (!after.localRules.some((r) => r.id === rule.id)) return { ok: false, reason: 'invalid', items: [line('write.not_done')] };
        undos.set(rule.id, { kind: 'rule', card, where: 'device', id: rule.id });
        return { ok: true, trail: trail(rule.id, 'local', card), items: confirmedLines(card).map(say) };
      }
      case 'meal': {
        // Meal logs are account-only in M4 (README ruling 5).
        if (!account) return { ok: false, reason: 'needs_account', items: [line('log.needs_account')] };
        const r = await client.createMeal(card.meal, true);
        if (!r.ok) return refused(r, card);
        undos.set(r.data.meal.id, { kind: 'meal', card, id: r.data.meal.id });
        return { ok: true, trail: trail(r.data.meal.id, 'local', card), items: confirmedLines(card).map(say) };
      }
      case 'profile': {
        const id = crypto.randomUUID();
        if (account) {
          const got = await client.getProfile();
          if (!got.ok) return refused(got, card);
          // Only the keys the card changes are put back on undo.
          const before = Object.fromEntries(Object.keys(card.patch).map((k) => [k, got.data[k as keyof Profile]])) as Partial<Profile>;
          const r = await client.putProfile(card.patch);
          if (!r.ok) return refused(r, card);
          undos.set(id, { kind: 'profile', card, where: 'account', before });
        } else {
          const before = store.get().localProfile;
          store.update((s) => ({ ...s, localProfile: { ...(s.localProfile ?? EMPTY_PROFILE), ...card.patch } }));
          undos.set(id, { kind: 'profile', card, where: 'device', before });
        }
        return { ok: true, trail: trail(id, 'local', card), items: confirmedLines(card).map(say) };
      }
      case 'pantry': {
        const id = crypto.randomUUID();
        let removed: Row[];
        let addedIds: string[];
        if (account) {
          const r = await client.changePantry({ add: card.add, removeNames: card.remove, removeIds: card.removeIds ?? [] }, true);
          if (!r.ok) return refused(r, card);
          removed = r.data.removed;
          addedIds = r.data.addedIds;
        } else {
          const matches = pantryMatcher(card.remove, card.removeIds ?? [], graph);
          const rows = store.get().localPantry;
          removed = rows.filter(matches);
          const added = card.add.map((a) => ({ name: a.name, ingredientId: a.ingredientId, id: crypto.randomUUID() }));
          addedIds = added.map((a) => a.id);
          store.update((s) => ({ ...s, localPantry: [...s.localPantry.filter((i) => !matches(i)), ...added] }));
        }
        undos.set(id, { kind: 'pantry', card, where: account ? 'account' : 'device', removed, addedIds });
        return { ok: true, trail: trail(id, 'local', card), items: confirmedLines(card, removed.map((r) => r.name)).map(say) };
      }
      case 'plan':
        return writePlan(card);
      case 'check_off':
        return writeCheckOff(card);
    }
  }

  /**
   * A local check-off card (M6 Step 10, C31), ticked by the week's code (week-turn.ts `writeCheckOff`): its got rows
   * through the week source (device, or the API with `today`), each skipped when no longer open; missing rows never.
   */
  async function writeCheckOff(card: CheckOffCard): Promise<WriteOutcome> {
    const w = await (await weekTurn()).writeCheckOff(card);
    if (!w.ok) return w;
    const id = crypto.randomUUID();
    undos.set(id, { kind: 'check_off', card, undo: w.undo });
    return { ok: true, trail: trail(id, 'local', card), items: confirmedLines(card, w.names).map(say), ticked: w.keys, already: w.already };
  }

  /**
   * A local plan card (the scripted engine's): the week is read again first, and saved only while it is still the
   * week the card was built on (its `basis`); otherwise the card is offered again on the week as it is now
   * (`plan_changed`, as the server does), never saved over an edit. Signed in through PUT /plans with `today`;
   * signed out to the device. A plan the rules now refuse is not saved: `plan.blocked_dish` names the dish (Ruling 5).
   */
  async function writePlan(card: PlanCard): Promise<WriteOutcome> {
    const w = await (await weekTurn()).writePlan(card);
    switch (w.kind) {
      case 'saved': {
        const id = crypto.randomUUID();
        undos.set(id, { kind: 'plan', card, weekStart: w.weekStart, previous: w.previous });
        return { ok: true, trail: trail(id, 'local', card), items: confirmedLines(card).map(say) };
      }
      case 'reoffer': return { ok: false, reason: 'plan_changed', items: w.lines.map(say), offered: w.card };
      case 'blocked': return { ok: false, reason: 'closed', items: w.lines.map(say) };
      case 'left': return { ok: false, reason: 'closed', items: [] };
      case 'refused':
        switch (w.failure.kind) {
          case 'consent': return { ok: false, reason: 'consent_required', items: [line('consent.health_first'), { kind: 'consent', purpose: 'health_data' }] };
          case 'network': return { ok: false, reason: 'network', items: [] };
          case 'limited': return { ok: false, reason: 'limited', items: [line('write.daily_limit')] };
          case 'closed':
          case 'family_table':
          case 'invalid':
          case 'rules':
            return { ok: false, reason: 'invalid', items: [line('write.not_done')] };
        }
    }
  }

  /** Reverses a local write; false when the reverse call failed, so the undo stays possible. */
  async function reverse(u: Undo): Promise<PanItem[] | null> {
    const goneIsFine = (r: ApiResult<unknown>) => r.ok || r.status === 404;
    switch (u.kind) {
      case 'rule': {
        if (u.where === 'device') {
          store.update((s) => ({ ...s, localRules: s.localRules.filter((r) => r.id !== u.id) }));
          return [];
        }
        const email = accountEmail();
        if (!goneIsFine(await client.deleteRule(u.id))) return null;
        editAccountRules(email, (rules) => rules.filter((x) => x.id !== u.id));
        await refreshAccount(client, store);
        return [];
      }
      case 'raise': // undone by `undoRaise`, which checks the rule first
        return null;
      case 'plan': // undone by `undoPlan`, which says why when the week as it was can't be put back
        return null;
      case 'check_off':
        return (await u.undo()) ? [] : null;
      case 'meal':
        return goneIsFine(await client.deleteMeal(u.id)) ? [] : null;
      case 'profile':
        if (u.where === 'device') {
          const before = u.before;
          store.update((s) => ({ ...s, localProfile: before }));
          return [];
        }
        return (await client.putProfile(u.before)).ok ? [] : null;
      case 'pantry': {
        if (u.where === 'device') {
          const added = new Set(u.addedIds);
          store.update((s) => ({ ...s, localPantry: [...s.localPantry.filter((i) => !added.has(i.id)), ...u.removed] }));
          return [];
        }
        // By id, so an item of the same name that was already there is never touched. The route's add takes no ids.
        const add = u.removed.map(({ name, ingredientId }) => ({ name, ingredientId }));
        const r = await client.changePantry({ add, removeNames: [], removeIds: u.addedIds }, true);
        if (!r.ok && r.error.code === 'too_many_items') return [line('pantry.undo_full')];
        return r.ok ? [] : null;
      }
    }
  }

  /**
   * Puts a raised rule back only if the account still holds exactly what the raise wrote. A rule changed since (another
   * tab or device) is left alone: an undo never lowers a rule below what it is now, nor below what it was before the raise.
   */
  async function undoRaise(entryId: string, u: Extract<Undo, { kind: 'raise' }>): Promise<UndoOutcome> {
    const email = accountEmail();
    const list = await client.listRules();
    if (!list.ok) return { status: 'failed', items: [] };
    const now = list.data.rules.find((x) => x.id === u.id);
    const changed = (): UndoOutcome => { undos.delete(entryId); return { status: 'nothing', items: [line('undo.rule_changed')] }; };
    if (now === undefined || now.severity !== u.wrote.severity || !sameTarget(now, u.wrote)) return changed();
    if (SEVERITY_RANK[u.before.severity] >= SEVERITY_RANK[now.severity]) { undos.delete(entryId); return { status: 'nothing', items: [line('undo.nothing')] }; }
    // N4: written only over the version just read, so a stricter edit another device makes meanwhile is never lowered.
    const put = await client.updateRule(u.id, u.before, true, list.data.versions?.[u.id]);
    if (!put.ok && put.status === 409 && put.error.code === 'rule_changed') { await refreshAccount(client, store); return changed(); }
    if (!put.ok) return { status: 'failed', items: isWriteCap(put) ? [line('write.daily_limit')] : [] };
    const back = put.data.rule;
    editAccountRules(email, (rules) => rules.map((x) => (x.id === back.id ? back : x)));
    await refreshAccount(client, store);
    undos.delete(entryId);
    return { status: 'undone', items: [line('undo')] };
  }

  /** Reverses `entry` once (the caller holds the in-flight guard). */
  async function undoOnce(entry: TrailEntry): Promise<UndoOutcome> {
    if (deps.now().getTime() > Date.parse(entry.undoUntil)) return { status: 'nothing', items: [line('undo.nothing')] };
    if (entry.origin === 'server') {
      const r = await client.undoWrite(entry.id);
      if (r.ok) {
        const items = partsToItems(r.data.parts, dialogue);
        if (r.data.undone) return { status: 'undone', items };
        // A full pantry keeps the entry (still undoable in the window); anything else had nothing to reverse.
        const full = r.data.parts.some((p) => p.kind === 'line' && p.line.trigger === 'pantry.undo_full');
        return { status: full ? 'full' : 'nothing', items };
      }
      return r.status === 409 || r.status === 404 ? { status: 'nothing', items: [line('undo.nothing')] } : { status: 'failed', items: [] };
    }
    const u = undos.get(entry.id);
    if (u === undefined) return { status: 'nothing', items: [line('undo.nothing')] };
    if (u.kind === 'raise') return undoRaise(entry.id, u);
    if (u.kind === 'plan') {
      const r = await (await weekTurn()).restore(u.weekStart, u.previous);
      if (r.kind === 'failed') return { status: 'failed', items: [] };
      undos.delete(entry.id);
      // M7: the week as it was holds a dish the rules now refuse: nothing changes, and the line names it.
      if (r.kind === 'blocked') return { status: 'nothing', items: r.lines.map(say) };
      return { status: 'undone', items: [say(undoneLine(u.card))] };
    }
    const done = await reverse(u);
    if (done === null) return { status: 'failed', items: [] };
    if (done.length > 0) return { status: 'full', items: done }; // the pantry is full: nothing changed, and the undo stays possible
    undos.delete(entry.id);
    return { status: 'undone', items: [say(undoneLine(u.card))] };
  }

  return {
    async confirm(view, via, edits) {
      if (familyTable()) return { ok: false, reason: 'invalid', items: [] };
      const key = keyOf(view);
      if (inFlight.has(key)) return { ok: false, reason: 'busy', items: [] };
      if (closed.has(key)) return { ok: false, reason: 'closed', items: [] };
      let card = view.card;
      const severity = edits?.severity;
      // A severe card, or an edit that makes one, needs a tap on the card itself (§7.6). No call is made.
      if (via !== 'tap' && (isSevereCard(card) || (severity !== undefined && SEVERE.has(severity)))) {
        return { ok: false, reason: 'tap_required', items: [tapNeeded(card)] };
      }
      // A typed yes to a server card is the server's own turn (Step 8 runTurn); this client never sends it as a tap.
      if (view.origin === 'server' && via !== 'tap') return { ok: false, reason: 'tap_required', items: [] };
      inFlight.add(key);
      try {
        let out: WriteOutcome;
        if (view.origin === 'server') {
          const now = deps.conversationId?.();
          // A plan card's week window reads the player's local date (Step 6 I2): `today` goes with every week write.
          const r = await client.confirmProposal(view.proposalId, edits, now, card.kind === 'plan' || card.kind === 'check_off' ? today() : undefined);
          if (!r.ok && r.status === 409 && r.error.code === 'plan_changed') {
            // The week changed since the card was shown: the server closed it and offered it again on the week now.
            const d = (r.error.details ?? {}) as { card?: ServerCard; parts?: ReplyPart[] };
            out = { ok: false, reason: 'plan_changed', items: partsToItems(Array.isArray(d.parts) ? d.parts : [], dialogue), offered: d.card ?? null };
          } else out = r.ok ? { ok: true, trail: r.data.trail, items: partsToItems(r.data.parts, dialogue) } : refused(r, card);
          // M-6: a card from an earlier conversation (cleared, or started again since) closes with the reason, not silently.
          if (!out.ok && out.reason === 'closed' && view.conversationId !== undefined && view.conversationId !== (now ?? null)) {
            out = { ...out, items: [line('card.earlier_conversation')] };
          }
        } else {
          if (severity !== undefined && card.kind === 'rule') card = withSeverity(card, severity, graph, ruleTerms);
          out = await writeLocal(card);
        }
        if (out.ok || out.reason === 'closed' || out.reason === 'plan_changed') closed.add(key);
        return out;
      } finally {
        inFlight.delete(key);
      }
    },

    async raiseRule(view, accountRule) {
      if (familyTable() || view.card.kind !== 'rule') return { ok: false, reason: 'invalid', items: [] };
      const key = keyOf(view);
      if (inFlight.has(key)) return { ok: false, reason: 'busy', items: [] };
      if (closed.has(key)) return { ok: false, reason: 'closed', items: [] };
      const card = view.card;
      inFlight.add(key);
      try {
        const email = accountEmail();
        // What the account holds now, from the server: the screen's copy can be stale (another tab or device).
        const list = await client.listRules();
        if (!list.ok) return refused(list, card);
        const current = list.data.rules.find((x) => x.id === accountRule.id);
        // Gone, or no longer the same rule (another type or target under that id): nothing is written.
        if (current === undefined || !sameTarget(current, card.rule)) {
          closed.add(key);
          await refreshAccount(client, store);
          return { ok: false, reason: 'closed', items: [line('rule.raise_gone')] };
        }
        // Not stricter than what the account has: a raise never lowers or sidesteps a rule. Nothing is written.
        if (SEVERITY_RANK[card.rule.severity] <= SEVERITY_RANK[current.severity]) {
          closed.add(key);
          await refreshAccount(client, store);
          return { ok: false, reason: 'closed', items: [line('rule.raise_not_stricter')] };
        }
        const { id: _id, ...before } = current;
        // The account rule's note is kept: a raise changes the severity, nothing the player wrote beside it.
        const raised: Omit<Rule, 'id'> = current.note === undefined ? card.rule : { ...card.rule, note: current.note };
        // N4: written only over the version just read; another write since (another tab or device) is a 409.
        const r = await client.updateRule(current.id, raised, true, list.data.versions?.[current.id]);
        if (!r.ok && r.status === 409 && r.error.code === 'rule_changed') {
          closed.add(key);
          await refreshAccount(client, store);
          return { ok: false, reason: 'closed', items: [line('rule.raise_gone')] };
        }
        if (!r.ok) return refused(r, card);
        const saved = r.data.rule;
        editAccountRules(email, (rules) => rules.map((x) => (x.id === saved.id ? saved : x)));
        await refreshAccount(client, store);
        // Its own trail id: the rule's id may already name this rule's creation in the undo memory.
        const id = crypto.randomUUID();
        undos.set(id, { kind: 'raise', card, id: saved.id, before, wrote: saved });
        closed.add(key);
        return { ok: true, trail: trail(id, 'local', card), items: confirmedLines(card).map(say) };
      } finally {
        inFlight.delete(key);
      }
    },

    async reject(view) {
      if (familyTable()) return [];
      const key = keyOf(view);
      if (closed.has(key)) return [];
      closed.add(key);
      if (view.origin === 'local') return [say(rejectedLine(view.card.kind))];
      const r = await client.rejectProposal(view.proposalId);
      if (r.ok) return partsToItems(r.data.parts, dialogue);
      if (r.status === 409 || r.status === 404) return [];
      closed.delete(key); // offline or a server error: still open
      return [];
    },

    async undo(entry) {
      if (familyTable()) return { status: 'nothing', items: [] };
      // One reverse at a time per entry: a second tap or a typed undo meanwhile never reverses twice.
      const key = `${entry.origin}:${entry.id}`;
      if (undoing.has(key)) return { status: 'busy', items: [] };
      undoing.add(key);
      try {
        return await undoOnce(entry);
      } finally {
        undoing.delete(key);
      }
    },

    async keep(card) {
      if (familyTable()) return { ok: false, reason: 'family_table', items: [] };
      if (!signedIn()) return { ok: false, reason: 'needs_account', items: card.kind === 'margin_note' ? [line('margin.needs_account')] : [] };
      if (kept.has(card) || keeping.has(card)) return { ok: false, reason: 'busy', items: [] };
      keeping.add(card);
      try {
        const undoUntil = () => new Date(deps.now().getTime() + UNDO_WINDOW_MS).toISOString();
        if (card.kind === 'margin_note') {
          const r = await client.createNote(card.note, today());
          if (r.ok) { kept.add(card); return { ok: true, id: r.data.note.id, items: [], check: r.data.note.check, undoUntil: undoUntil() }; }
          if (r.status === 400 && r.error.code === 'too_many_notes') return { ok: false, reason: 'too_many', items: [] };
          return keepRefused(r);
        }
        const r = await client.recordShared(card.entry, today());
        if (!r.ok) return keepRefused(r);
        kept.add(card);
        // Equal warmth either way (audit M-9): nothing is counted against eating alone.
        const warm = card.entry.cookedFor.count === 'just_me' ? 'cooked_for.alone' : 'cooked_for.shared';
        return { ok: true, id: r.data.id, items: [line(warm)], check: null, undoUntil: undoUntil() };
      } finally {
        keeping.delete(card);
      }
    },

    async unkeep(kind, id) {
      if (familyTable()) return 'family_table'; // §19, fix I1: Family Table deletes nothing
      const r = kind === 'margin_note' ? await client.deleteNote(id) : await client.deleteShared(id);
      return r.ok || r.status === 404 ? 'undone' : 'failed';
    },
  };
}
