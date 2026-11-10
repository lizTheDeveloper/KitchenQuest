import {
  confirmedLines, isSevereCard, pantryMatcher, rejectedLine, SEVERE, trailSummary, undoneLine, UNDO_WINDOW_MS, validateRules, withSeverity,
  type IngredientGraph, type LineRef, type PantryItem, type ProposalCard, type ReplyPart, type Rule, type RuleTerm, type Severity, type TrailEntry,
} from '@kitchenquest/core/engine';
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
  | { ok: true; trail: TrailEntry; items: PanItem[] }
  | { ok: false; reason: 'tap_required' | 'consent_required' | 'needs_account' | 'invalid' | 'closed' | 'network'; items: PanItem[] };

export interface CardWriter {
  /** severe + typed_yes → tap_required, with no call. */
  confirm(card: CardView, via: 'tap' | 'typed_yes', edits?: { severity?: Severity }): Promise<WriteOutcome>;
  reject(card: CardView): Promise<PanItem[]>;
  undo(entry: TrailEntry): Promise<PanItem[]>;
}

type Row = PantryItem & { id: string };
const EMPTY_PROFILE: LocalProfile = { marketDays: [], mealsPerWeek: null, country: null, region: null, mealWindows: [] };

/** How to reverse a local write, kept in memory only. */
type Undo =
  | { kind: 'rule'; card: ProposalCard; where: 'account' | 'device'; id: string }
  | { kind: 'meal'; card: ProposalCard; id: string }
  | { kind: 'profile'; card: ProposalCard; where: 'account'; before: Partial<Profile> }
  | { kind: 'profile'; card: ProposalCard; where: 'device'; before: LocalProfile | null }
  | { kind: 'pantry'; card: ProposalCard; where: 'account' | 'device'; removed: Row[]; addedIds: string[] };

/**
 * Reply parts as panel items. A `text` part is dropped: the model's free text is never shown (ruling R9).
 */
export function partsToItems(parts: readonly ReplyPart[], dialogue: Dialogue): PanItem[] {
  return parts.flatMap((p): PanItem[] => {
    switch (p.kind) {
      case 'line': return [{ kind: 'said', said: dialogue.say(p.line.trigger, p.line.vars) }];
      case 'choices': return [{ kind: 'choices', options: p.options, severity: p.severity }];
      case 'consent': return [{ kind: 'consent', purpose: p.purpose }];
      case 'text': return [];
    }
  });
}

const isConsentPurpose = (x: unknown): x is 'health_data' | 'ai_health' => x === 'health_data' || x === 'ai_health';

export function createCardWriter(deps: {
  client: ApiClient; store: PlayerStore; dialogue: Dialogue; graph: IngredientGraph; ruleTerms: readonly RuleTerm[]; now: () => Date;
}): CardWriter {
  const { client, store, dialogue, graph, ruleTerms } = deps;
  const inFlight = new Set<string>();
  const closed = new Set<string>();
  const undos = new Map<string, Undo>();

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
  const editAccountRules = (fn: (rules: Rule[]) => Rule[]) =>
    store.update((s) => (s.accountRules === null ? s : { ...s, accountRules: fn(s.accountRules) }));
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
    if (status === 401) return { ok: false, reason: 'needs_account', items: [] };
    // Offline, rate-limited or a server error: nothing is known to be written, and the card stays open to try again.
    if (status === 0 || status === 429 || status >= 500) return { ok: false, reason: 'network', items: [] };
    return { ok: false, reason: 'invalid', items: [line('write.not_done')] };
  }
  const tapNeeded = (card: ProposalCard): PanItem => line('rule.tap_needed', { ingredient: card.kind === 'rule' ? card.display.ingredient : '' });

  /** A local card written to the account (signed in) or the device (signed out). */
  async function writeLocal(card: ProposalCard): Promise<WriteOutcome> {
    const account = signedIn();
    switch (card.kind) {
      case 'rule': {
        if (account) {
          const r = await client.createRule(card.rule, true);
          if (!r.ok) return refused(r, card);
          const saved = r.data.rule;
          editAccountRules((rules) => [...rules.filter((x) => x.id !== saved.id), saved]);
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
    }
  }

  /** Reverses a local write; false when the reverse call failed, so the undo stays possible. */
  async function reverse(u: Undo): Promise<PanItem[] | null> {
    const goneIsFine = (r: ApiResult<unknown>) => r.ok || r.status === 404;
    switch (u.kind) {
      case 'rule':
        if (u.where === 'device') {
          store.update((s) => ({ ...s, localRules: s.localRules.filter((r) => r.id !== u.id) }));
          return [];
        }
        if (!goneIsFine(await client.deleteRule(u.id))) return null;
        editAccountRules((rules) => rules.filter((x) => x.id !== u.id));
        await refreshAccount(client, store);
        return [];
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

  return {
    async confirm(view, via, edits) {
      if (familyTable()) return { ok: false, reason: 'invalid', items: [] };
      const key = keyOf(view);
      if (closed.has(key) || inFlight.has(key)) return { ok: false, reason: 'closed', items: [] };
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
          const r = await client.confirmProposal(view.proposalId, edits);
          out = r.ok ? { ok: true, trail: r.data.trail, items: partsToItems(r.data.parts, dialogue) } : refused(r, card);
        } else {
          if (severity !== undefined && card.kind === 'rule') card = withSeverity(card, severity, graph, ruleTerms);
          out = await writeLocal(card);
        }
        if (out.ok || out.reason === 'closed') closed.add(key);
        return out;
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
      if (familyTable()) return [];
      if (deps.now().getTime() > Date.parse(entry.undoUntil)) return [line('undo.nothing')];
      if (entry.origin === 'server') {
        const r = await client.undoWrite(entry.id);
        if (r.ok) return partsToItems(r.data.parts, dialogue);
        return r.status === 409 || r.status === 404 ? [line('undo.nothing')] : [];
      }
      const u = undos.get(entry.id);
      if (u === undefined) return [line('undo.nothing')];
      const done = await reverse(u);
      if (done === null) return [];
      if (done.length > 0) return done; // the pantry is full: nothing changed, and the undo stays possible
      undos.delete(entry.id);
      return [say(undoneLine(u.card))];
    },
  };
}
