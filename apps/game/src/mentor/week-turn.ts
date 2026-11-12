import {
  blockedDishLine, buildCheckOffCard, buildPlanCard, checkOffIntent, checkOffShaped, checkPlan, markOffered, navIntent, navPlace, planBasis, planFlags,
  planIntent, rebasePlanCard, normalizeTurn,
  type CheckOffCard, type CheckStatus, type LineRef, type MarketRunView, type NavTarget, type Plan, type PlanCard, type PlanItem, type PlanRequest, type ProposalCard,
} from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { knownRun, loadKnownRun } from '../week/market-swaps';
import { activeRules, localDate } from '../recipes/rules';
import { routeHref } from '../shell/router';
import type { PlayerStore } from '../state/store';
import { blockedLinesFor, blockedSlugs } from '../week/blocked';
import { canonRecipes, devicePlan, planCardContextOf, planContextFor, rulesOf } from '../week/context';
import { currentToolkit, rememberedWeek, rememberWeek } from '../week/memory';
import { rememberRun } from '../week/run-memory';
import { renderPlanView, slotDay, weekdayName, writtenLine, type PlanRow } from '../week/plan-view';
import { createWeekSource, type WeekFailure, type WeekSource } from '../week/source';
import { isProposalCard } from './card-shape';
import { drawCheckOff } from './check-off-card';
import type { Dialogue } from './dialogue';
import type { PanItem, PanReply, TurnContext } from './reply';

/**
 * The week's turn code (M5 Step 10, Ruling 1), loaded on first use so first paint doesn't carry it: the scripted
 * engine's plan cards (core `planIntent` → `buildPlanCard`) and navigation chips (`navIntent`), the asks for a plan
 * the closed grammar refused, the plan card's Form 7-W body, and the plan card's write and undo. The fixed lines
 * (emergency, medical, child, allowance) never wait on this module: the engine answers them before it is asked for.
 */

/** Weekday words, and the day words that name no single day (the Pan asks which day: `plan.which_day`). */
const WD = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat)s?';
const LOOSE_LEAD = /^(?:plan|sort) (?:my|the|this) week\s*(?::|,|-|$)\s*/;
const LOOSE_PICK_AFTER = /^(?:pick|choose) (?:\d|one|two|three|four|five|six|seven)(?: (?:dishes|dinners|meals|things))?(?: for (?:this|the|my) week)? after (.+)$/;
const LOOSE_DISH_ON = /^(put )?(?:the )?(.+?) (?:on|for) (.+)$/;
const LOOSE_DISH_WD = new RegExp(`^(put )?(?:the )?(.+?) (${WD})$`);
const WEEKDAY_ONLY = new RegExp(`^${WD}$`);
const NUMBER_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

/**
 * A plan request the closed grammar (`planIntent`) refused, read only to say what the Pan can't place (Ruling 22,
 * C1): a dish name the cooks don't teach ("dal on Sunday" → `plan.dish_unknown`), a day that names no single day
 * (`plan.which_day`), "pick N after <not one day>" (`plan.after_which_day`). Every clause must be one of these
 * shapes, and without the "plan my week" lead each dish clause needs "put" or a weekday. Never a card: the player's
 * words come back in the asks, and nothing is planned from this reading.
 */
function loosePlan(own: string): PlanRequest | null {
  if (own.includes('?')) return null;
  const s = own.replace(/[.!]+$/, '');
  const lead = LOOSE_LEAD.exec(s);
  const clauses = (lead ? s.slice(lead[0].length) : s).split(/\s*(?:[,;]+|\band\b|\bthen\b)\s*/).map((c) => c.trim()).filter((c) => c !== '');
  if (clauses.length === 0) return null;
  const days: { weekday: string; dish: string }[] = [];
  let pick: number | null = null;
  let after: string | null = null;
  for (const c of clauses) {
    let m: RegExpExecArray | null;
    if ((m = LOOSE_PICK_AFTER.exec(c)) !== null && pick === null) {
      const n = /\d/.exec(c)?.[0];
      pick = n !== undefined ? Number(n) : NUMBER_WORDS[/(one|two|three|four|five|six|seven)/.exec(c)![1]];
      after = m[1];
      continue;
    }
    m = LOOSE_DISH_ON.exec(c) ?? LOOSE_DISH_WD.exec(c);
    if (m === null) return null;
    const [, put, dish, day] = m;
    if (dish.split(/\s+/).length > 4) return null;
    if (lead === null && put === undefined && !WEEKDAY_ONLY.test(day)) return null;
    days.push({ weekday: day, dish });
  }
  return { days: days.length > 0 ? days : null, pick, hard: null, after };
}

/** The lines a loose plan reading may say: the asks, never a read-back or a card. */
const ASK_TRIGGERS: ReadonlySet<string> = new Set(['plan.dish_unknown', 'plan.which_day', 'plan.after_which_day', 'plan.dish_sacred']);

/** What a plan card's write came to (the writer turns it into its outcome). */
type PlanWrite =
  | { kind: 'saved'; weekStart: string; previous: Plan | null }
  /** The week changed since the card was shown: nothing saved; the card again on the week now, or only lines. */
  | { kind: 'reoffer'; lines: LineRef[]; card: PlanCard | null }
  /** Ruling 5: a dish is ⛔ now: nothing saved, and `plan.blocked_dish` names it. */
  | { kind: 'blocked'; lines: LineRef[] }
  | { kind: 'refused'; failure: WeekFailure }
  /** N4: the account changed while the write was on its way. */
  | { kind: 'left' };

export interface WeekTurn {
  /** A plan (closed grammar) → its card and read-back; a navigation → a chip; else null. */
  intent(text: string, turn: number): PanReply | null;
  /** The asks for a plan request the closed grammar refused (never a card). */
  asks(stripped: string): PanItem[];
  /** The plan card's day rows (plan-view.ts), its food-group line and its slot, checked with the rules now (M8). */
  planCardBody(card: PlanCard): HTMLElement;
  /** A plan card in the shape the panel draws (M1: a re-offered card is checked like any other). */
  isPlanCard(card: unknown): card is PlanCard;
  writePlan(card: PlanCard): Promise<PlanWrite>;
  /**
   * An undo: `previous` back (or the week's plan deleted). `blocked` (M7): the week as it was holds a dish the rules
   * now refuse, so it can't be put back; its lines name the dish.
   */
  restore(weekStart: string, previous: Plan | null): Promise<{ kind: 'ok' } | { kind: 'blocked'; lines: LineRef[] } | { kind: 'failed' }>;
  /** Signed in with no week read this session: read it once (a read), so a card is built on the right week (M3). */
  prefetch(): Promise<void>;
  /**
   * M6 Step 10 (Ruling 13, C30): the closed check-off grammar, run by the scripted engine after the fixed lines and the
   * short replies and before the health check, exactly where the API runs it. Core `checkOffShaped` first (Step 8 N1:
   * the client gates on it as the server does), then core `checkOffIntent` with the player's rule terms against the
   * current run (device or account), read only. A claimed message → a local `check_off` card (`source: 'grammar'`) and
   * a confirm intent, so it ticks at once with an Undo (C31). Null → the message goes on to the health path. Never in
   * Family Table, on an allergies intake answer, or while a rule or meal card is open (any doubt is the health path's).
   */
  checkOff(text: string, ctx: Pick<TurnContext, 'turn' | 'intakeStep' | 'openCards'>): Promise<PanReply | null>;
  /**
   * Ticks a check-off card's got rows (device or API, with `today`), skipping rows no longer open (ticked on screen
   * since, out of stock, gone); missing rows are never ticked. `names`: the rows ticked; `undo` unticks exactly those
   * (false: it failed, try again). Refused (nothing ticked): signed in without health_data, the consent card.
   */
  /** The check-off card's drawing (check-off-card.ts), here so it loads with the week's code, never at first paint. */
  drawCheckOff: typeof drawCheckOff;
  writeCheckOff(card: CheckOffCard): Promise<{ ok: true; names: string[]; keys: string[]; already: string[]; undo: () => Promise<boolean> } | { ok: false; reason: 'consent_required' | 'network' | 'limited' | 'closed'; items: PanItem[] }>;
}

const RANK: Record<CheckStatus, number> = { ok: 0, swap: 1, unverified: 2, blocked: 3 };
const worse = (a: CheckStatus, b: CheckStatus): CheckStatus => (RANK[a] >= RANK[b] ? a : b);

export function createWeekTurn(d: {
  store: PlayerStore; client: ApiClient; now: () => Date; dialogue: Dialogue;
  recipes: readonly { slug: string; title: string }[]; cooks: Readonly<Record<string, string>>; source?: WeekSource;
}): WeekTurn {
  const { store, dialogue, recipes } = d;
  const source = d.source ?? createWeekSource({ store, client: d.client, today: () => localDate(d.now()) });
  const today = () => localDate(d.now());
  const account = () => store.get().account?.email ?? null;
  const say = (l: LineRef): PanItem => ({ kind: 'said', said: dialogue.say(l.trigger, l.vars) });
  const reply = (items: PanItem[], cards: ProposalCard[] = [], turn = 0): PanReply => ({
    items, cards: cards.map((card) => ({ origin: 'local', localId: crypto.randomUUID(), card, issuedTurn: turn })), intents: [], actions: [], notice: null,
  });
  const context = () => planCardContextOf(store.get(), today(), (w) => devicePlan(store.get(), w), currentToolkit());
  const rulesError = (): PanItem => {
    const r = activeRules(store.get(), graph);
    return { kind: 'rules_error', message: r.status === 'error' ? r.message : '', href: routeHref({ name: 'rules' }) };
  };
  const goItem = (target: NavTarget): PanItem => {
    const name = target.to === 'visit' ? (d.cooks[target.cook] ?? null)
      : target.to === 'recipe' ? (recipes.find((r) => r.slug === target.slug)?.title.replace(/\s*\([^)]*\)\s*$/, '').trim() ?? null) : null;
    return { kind: 'go', target, said: dialogue.say('nav.offer', { place: navPlace(target, name) }) };
  };
  const planReply = (req: PlanRequest, turn: number): PanReply => {
    const ctx = context();
    if (ctx === null) return reply([rulesError()]);
    const built = buildPlanCard(req, ctx);
    if ('none' in built) return reply(built.none.map(say));
    return reply(built.readback.map(say), [built], turn);
  };

  /** The card rebuilt on the week as it is now: the same new dishes on the same weekdays, checked again. */
  const reoffer = (card: PlanCard, weekStart: string, stored: Plan | null): PlanWrite => {
    const ctx = planCardContextOf(store.get(), today(), (w) => (w === weekStart ? stored : null), currentToolkit());
    if (ctx === null) return { kind: 'refused', failure: { kind: 'rules' } };
    // The weekday of each new item stays the same when the plan week starts on another day.
    const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
    const shift = (dow(card.weekStart) - dow(ctx.weekStart) + 7) % 7;
    const added: PlanItem[] = card.added.map((i) => ({ ...i, day: (i.day + shift) % 7 }));
    const rebuilt = rebasePlanCard({ ...card, added }, ctx);
    return 'none' in rebuilt ? { kind: 'reoffer', lines: rebuilt.none, card: null } : { kind: 'reoffer', lines: rebuilt.readback, card: rebuilt };
  };

  /**
   * The current market run, read only: signed out the device's run for this plan week, its rows recomputed now (the
   * device's own open, which never creates a run that isn't there); signed in the run as last read this session.
   */
  const currentRun = async (): Promise<MarketRunView | null> => {
    const known = account() === null ? knownRun(store.get(), today()) : await loadKnownRun(store.get(), d.client, today());
    if (known === null || known.doneAt !== null) return null;
    if (account() !== null) return known;
    const r = await source.openRun(known.weekStart, today());
    return r.ok && r.value.doneAt === null ? r.value : null;
  };
  /** The run a card was built on, or null when it is another run now (a new week, another account). */
  const runFor = async (runId: string): Promise<MarketRunView | null> => {
    const run = await currentRun();
    return run !== null && run.id === runId ? run : null;
  };

  const tickCheckOff = async (card: CheckOffCard): Promise<{ kind: 'ticked'; runId: string; keys: string[]; names: string[]; already: string[] } | { kind: 'refused'; failure: WeekFailure }> => {
    const who = account();
    let run = await runFor(card.runId);
    if (run === null) return { kind: 'refused', failure: { kind: 'closed' } };
    const keys: string[] = [];
    const names: string[] = [];
    /** M6 final: rows already ticked (on screen, earlier): the card says "(already ticked)", not "(not ticked)". */
    const already: string[] = [];
    for (const key of card.got) {
      const before = run.items.find((i) => i.key === key);
      // Ticked on screen since, out of stock, or gone: skipped, never ticked twice (the server's own rule).
      if (before?.ticked === true) { already.push(key); continue; }
      if (before === undefined || before.outOfStock === true) continue;
      const r = await source.tick(run, key, true, today());
      if (account() !== who) break;
      if (r.ok) {
        run = r.value;
        if (who !== null) rememberRun(run, who);
        if (run.items.find((i) => i.key === key)?.ticked === true) { keys.push(key); names.push(before.name); }
        continue;
      }
      if (r.kind === 'closed' || r.kind === 'invalid') continue;
      // Consent, the write cap, offline: nothing more is tried; what was ticked stays (and is undone together).
      if (keys.length === 0) return { kind: 'refused', failure: r };
      break;
    }
    return { kind: 'ticked', runId: run.id, keys, names, already };
  };
  const untickCheckOff = async (runId: string, keys: readonly string[]): Promise<{ kind: 'ok' } | { kind: 'failed' }> => {
    let run = await runFor(runId);
    if (run === null) return { kind: 'ok' };
    for (const key of keys) {
      const r = await source.tick(run, key, false, today());
      if (r.ok) { run = r.value; continue; }
      if (r.kind === 'closed' || r.kind === 'invalid') continue;
      return { kind: 'failed' };
    }
    if (account() !== null) rememberRun(run, account());
    return { kind: 'ok' };
  };

  return {
    intent(text, turn) {
      const plan = planIntent(text, recipes);
      if (plan !== null) return planReply(plan, turn);
      const nav = navIntent(text, { cooks: new Set(Object.keys(d.cooks)), slugs: new Set(recipes.map((r) => r.slug)) });
      return nav === null ? null : reply([goItem(nav)]);
    },

    asks(stripped) {
      const loose = loosePlan(normalizeTurn(stripped));
      const ctx = loose === null ? null : context();
      if (loose === null || ctx === null) return [];
      const built = buildPlanCard(loose, ctx);
      return ('none' in built ? built.none : built.readback).filter((l) => ASK_TRIGGERS.has(l.trigger)).map(say);
    },

    planCardBody(card) {
      const rules = rulesOf(store.get());
      const rows: PlanRow[] = card.items.map((item, i) => {
        // A check that isn't this item's can't be verified: ❓, never ✅.
        const own: CheckStatus = card.checks[i]?.slug === item.slug ? card.checks[i].status : 'unverified';
        if (rules === null) return { item, status: own, findings: [] };
        const [now] = checkPlan({ weekStart: card.weekStart, items: [item], hard: card.hard, slot: 'unanswered' }, planContextFor(card.weekStart, rules));
        // Never shown better than the rules say now (a rule filed since the card was built).
        return { item, status: worse(own, now.status), findings: now.findings };
      });
      const plan: Plan = { weekStart: card.weekStart, items: card.items, hard: card.hard, slot: 'unanswered' };
      const day = card.offer === null || card.hard ? null : slotDay(plan, card.offer, today());
      return renderPlanView({
        weekStart: card.weekStart, rows, line: writtenLine,
        flag: rules === null ? null : planFlags(plan, planContextFor(card.weekStart, rules)),
        offer: card.offer === null || card.hard || day === null ? null : { offer: card.offer, day: weekdayName(card.weekStart, day) },
      });
    },

    isPlanCard: (card): card is PlanCard => isProposalCard(card) && (card as { kind?: unknown }).kind === 'plan',

    async writePlan(card) {
      const day = today();
      // N4: the account this write is for, read before the first await; a session that changed meanwhile is never remembered.
      const who = account();
      const same = () => account() === who;
      const cur = await source.current(day);
      if (!cur.ok) return { kind: 'refused', failure: cur };
      const { weekStart, plan: stored } = cur.value;
      if (!same()) return { kind: 'left' };
      rememberWeek(weekStart, stored, who);
      if (weekStart !== card.weekStart || planBasis(stored) !== card.basis) return reoffer(card, weekStart, stored);
      // M5 final m1: an offer the card shows marks an unanswered week 'offered', pinned to that technique and dish.
      const kept: Plan = { weekStart, items: card.items, hard: card.hard, slot: stored?.slot ?? 'unanswered', ...(stored?.offer ? { offer: stored.offer } : {}) };
      const plan = markOffered(kept, card.offer);
      const r = await source.save(plan, day);
      if (!r.ok) {
        const slugs = r.kind === 'invalid' ? blockedSlugs(r.problems) : [];
        if (slugs.length > 0) {
          const rules = rulesOf(store.get());
          const lines = rules === null ? [] : blockedLinesFor(plan, rules);
          return { kind: 'blocked', lines: lines.length > 0 ? lines : slugs.map((slug) => blockedDishLine(slug, [], canonRecipes(), graph)) };
        }
        return { kind: 'refused', failure: r };
      }
      // The session changed while the save was on its way: it landed for the old one, so no undo is offered here
      // (it would write to the new session) and nothing is remembered for it.
      if (!same()) return { kind: 'left' };
      rememberWeek(weekStart, plan, who);
      return { kind: 'saved', weekStart, previous: r.value.previous };
    },

    async restore(weekStart, previous) {
      const who = account();
      const r = await source.restore(weekStart, previous, today());
      if (r.ok) { if (account() === who) rememberWeek(weekStart, previous, who); return { kind: 'ok' }; }
      const rules = rulesOf(store.get());
      if (r.kind === 'invalid' && previous !== null && rules !== null) {
        const lines = blockedLinesFor(previous, rules);
        if (lines.length > 0) return { kind: 'blocked', lines };
      }
      return { kind: 'failed' };
    },

    async checkOff(text, ctx) {
      if (store.get().settings.familyTable) return null;
      if (ctx.intakeStep === 'allergies' || ctx.openCards.some((c) => c.card.kind === 'rule' || c.card.kind === 'meal')) return null;
      const terms = content.ruleTerms;
      if (!checkOffShaped(text, graph, terms)) return null;
      const run = await currentRun();
      const read = checkOffIntent(text, run, graph, terms);
      const card = run === null || read === null ? null : buildCheckOffCard(run, read.got, read.missing, 'grammar');
      if (card === null) return null;
      const localId = crypto.randomUUID();
      return {
        items: card.readback.map(say), cards: [{ origin: 'local', localId, card, issuedTurn: ctx.turn }],
        // A grammar card is applied at once (C31): the writer ticks its got rows, and the card shows its Undo.
        intents: [{ kind: 'confirm', localId }], actions: [], notice: null,
      };
    },

    drawCheckOff,

    async writeCheckOff(card) {
      const t = await tickCheckOff(card);
      if (t.kind === 'refused') {
        const f = t.failure.kind;
        if (f === 'consent') return { ok: false, reason: 'consent_required', items: [say({ trigger: 'consent.health_first', vars: {} }), { kind: 'consent', purpose: 'health_data' }] };
        if (f === 'network') return { ok: false, reason: 'network', items: [] };
        if (f === 'limited') return { ok: false, reason: 'limited', items: [say({ trigger: 'write.daily_limit', vars: {} })] };
        return { ok: false, reason: 'closed', items: [say({ trigger: 'write.not_done', vars: {} })] };
      }
      return { ok: true, names: t.names, keys: t.keys, already: t.already, undo: async () => (await untickCheckOff(t.runId, t.keys)).kind === 'ok' };
    },

    async prefetch() {
      const who = account();
      if (who === null || rememberedWeek(who) !== null) return;
      const cur = await source.current(today());
      if (cur.ok && account() === who) rememberWeek(cur.value.weekStart, cur.value.plan, who);
    },
  };
}
