import {
  classifyTurn, isHealthText, stripPageEvents,
  type CardAction, type IngredientGraph, type IntakeStep, type ReplyPart, type RuleTerm, type ServerCard, type TurnRequest, type TurnResponse,
} from '@kitchenquest/core/engine';
import { refreshAccount } from '../api/account';
import type { ApiClient } from '../api/client';
import type { ApiResult, ConsentPurpose, Consents } from '../api/types';
import { localDate } from '../recipes/rules';
import type { PlayerStore } from '../state/store';
import type { MentorBackend } from './backend';
import type { Dialogue } from './dialogue';
import type { PanItem, PanReply, ServerCardView, TurnContext } from './reply';
import type { ScriptedEngine } from './scripted';
import { withNotice, type ConversationRef } from './outage';
import { partsToItems } from './writer';

/** A failed turn is tried again once by itself after this long, or on the next `online` event if that comes first (pre-flight C23). */
export const RETRY_AFTER_MS = 5_000;

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** A 200 we can use: anything else is treated like invalid JSON. */
function isTurnResponse(x: unknown): x is TurnResponse {
  return isObj(x) && (x.route === 'ai' || x.route === 'deterministic' || x.route === 'scripted') &&
    Array.isArray(x.parts) && Array.isArray(x.cards) && Array.isArray(x.actions) && (x.conversationId === null || typeof x.conversationId === 'string');
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
const isDate = (x: unknown): x is string => isStr(x) && Number.isFinite(Date.parse(x));
const isLineRef = (x: unknown): boolean => isObj(x) && isStr(x.trigger) && isObj(x.vars) && Object.values(x.vars).every(isStr);
const RULE_FORMS: readonly unknown[] = ['rule_allergen', 'rule_intolerance', 'rule_diet'];
const KINDS: readonly unknown[] = ['rule', 'meal', 'profile', 'pantry'];

/** A proposal card with every field the panel draws (fix round 1, M8): anything else is dropped, never rendered. */
function isProposalCard(c: unknown): boolean {
  if (!isObj(c) || !Array.isArray(c.readback) || !c.readback.every(isLineRef)) return false;
  switch (c.kind) {
    case 'rule': {
      const d = c.display;
      const r = c.rule;
      return RULE_FORMS.includes(c.form) && typeof c.severe === 'boolean' && typeof c.severityUnclear === 'boolean' &&
        isObj(d) && isStr(d.ingredient) && isStr(d.spelled) && isStr(d.severity) && isStr(d.covers) &&
        isObj(r) && isObj(r.target) && isStrArr(r.target.ids) && isStr(r.severity);
    }
    case 'meal': {
      const m = c.meal;
      if (!isObj(m) || !isStr(m.eatenOn) || !isStr(m.slot) || !isObj(m.item) || !isStr(c.summary) || typeof c.estimate !== 'boolean') return false;
      return m.item.kind === 'dish' ? isStr(m.item.slug) && typeof m.item.servings === 'number' : m.item.kind === 'free' && isStr(m.item.description);
    }
    case 'profile': {
      const p = c.patch;
      if (!isObj(p) || !isStr(c.summary)) return false;
      return (p.marketDays === undefined || (Array.isArray(p.marketDays) && p.marketDays.every((d) => Number.isInteger(d)))) &&
        (p.mealsPerWeek === undefined || p.mealsPerWeek === null || typeof p.mealsPerWeek === 'number') &&
        (p.country === undefined || p.country === null || isStr(p.country)) && (p.region === undefined || p.region === null || isStr(p.region)) &&
        (p.mealWindows === undefined || (Array.isArray(p.mealWindows) && p.mealWindows.every((w) => isObj(w) && isStr(w.name) && isStr(w.start) && isStr(w.end))));
    }
    case 'pantry':
      return Array.isArray(c.add) && c.add.every((a) => isObj(a) && isStr(a.name) && (a.ingredientId === null || isStr(a.ingredientId))) &&
        isStrArr(c.remove) && isStr(c.summary) && (c.removeIds === undefined || isStrArr(c.removeIds));
    default:
      return false;
  }
}
const isServerCard = (x: unknown): x is ServerCard => isObj(x) && isStr(x.proposalId) && isDate(x.expiresAt) && isProposalCard(x.card);
const isTrail = (x: unknown): boolean =>
  isObj(x) && isStr(x.id) && (x.origin === 'server' || x.origin === 'local') && KINDS.includes(x.kind) && isStr(x.summary) && isDate(x.undoUntil);
const isAction = (x: unknown): x is CardAction => isObj(x) && (
  (x.kind === 'confirmed' && isStr(x.proposalId) && isTrail(x.trail)) || (x.kind === 'rejected' && isStr(x.proposalId)) || (x.kind === 'undone' && isStr(x.id)));

/** The server would not answer this turn: the script answers and the turn is tried again once (spec §7.5). */
const isOutage = (r: Extract<ApiResult<unknown>, { ok: false }>) => r.status === 0 || r.status === 429 || r.status >= 500 || r.error.code === 'bad_response';

/** A current, unwithdrawn grant (a stale notice never counts), as the server's `hasConsent`. */
function granted(c: Consents, purpose: ConsentPurpose): boolean {
  if (c.needsReconsent.includes(purpose)) return false;
  return c.consents.some((x) => x.purpose === purpose && x.withdrawnAt === null && x.current);
}

/**
 * The AI mentor (M4 Step 10): turns go to `POST /mentor/turn`, and on any failure, cap or missing consent the same
 * text goes to the scripted engine, so the player always gets an answer and can always stamp. The model's free text
 * is never shown (ruling R9): only scripted lines and cards. Health text never leaves the device without `ai_health`
 * (the client mirror of the server's stage-4 gate, pre-flight C1; core `isHealthText`). A failed turn is held in this
 * closure only, never in the store or storage (N-4).
 */
export function createAiBackend(deps: {
  client: ApiClient; engine: ScriptedEngine; dialogue: Dialogue; store: PlayerStore; graph: IngredientGraph; ruleTerms: readonly RuleTerm[];
  now: () => Date; screen: () => TurnRequest['screen']; intakeStep: () => IntakeStep | null;
  /** Where `online` events come from (the window). */
  events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** The conversation's server id, shared with the panel's clear (index.ts); the backend keeps its own when none is given. */
  conversation?: ConversationRef;
}): MentorBackend & { readonly conversationId: string | null } {
  const { client, engine, dialogue, store } = deps;
  const conversation = deps.conversation ?? { id: null };
  const listeners = new Set<(r: PanReply) => void>();
  const say = (trigger: string): PanItem => ({ kind: 'said', said: dialogue.say(trigger) });
  const lines = (...triggers: string[]): PanReply => ({ items: triggers.map(say), cards: [], intents: [], actions: [], notice: null });
  /** A notice goes first, except after an emergency, medical or child line, which always leads (outage.ts). */
  const prefixed = (items: PanItem[], r: PanReply): PanReply => items.reduceRight((acc, i) => withNotice(i, acc), r);
  /** Retries and late replies end here once the backend is replaced (fix round 1, I2). */
  let disposed = false;
  /** Read through a call, so a check after an await sees a dispose that happened meanwhile. */
  const isDisposed = () => disposed;
  const cancels = new Set<() => void>();
  /**
   * Every text turn, retry and delivered safety turn runs here one at a time, in the order it arrived, so each one
   * reads the conversation id the turn before it set and the server sees the turns in order (fix round 4, G3).
   */
  let chain: Promise<unknown> = Promise.resolve();
  /**
   * Settles on dispose. Every server call in a step waits on it too (`unlessGone`), so a hung step lets go and every
   * step behind it runs at once, answered by the script (fix round 5, H1).
   */
  let release!: () => void;
  const gone = new Promise<'gone'>((r) => { release = () => { r('gone'); }; });
  function serial<T>(step: () => Promise<T>): Promise<T> {
    const p = chain.then(step);
    chain = p.then(() => undefined, () => undefined);
    return p;
  }
  /** A call that stops waiting when the backend is disposed: 'gone' then, and the step answers without the server. */
  const unlessGone = <T>(p: Promise<T>): Promise<T | 'gone'> => Promise.race([p, gone]);
  /** The reply's conversation id, unless the conversation was cleared while it was on its way (G4). */
  const keepId = (gen: number | undefined, id: string | null) => { if (conversation.gen === gen) conversation.id = id; };

  /**
   * The ai_health card, once ever, after the engine's answer. `aiHealthOffered` is set by the panel when the card
   * is actually on screen (fix round 1, M5).
   */
  function offerAiHealth(r: PanReply): PanReply {
    if (store.get().aiHealthOffered) return r;
    return { ...r, items: [...r.items, { kind: 'consent', purpose: 'ai_health' }] };
  }

  /** Lines, choices and consent from the server; a part that isn't one of ours (or names no line) is dropped. */
  const itemsOf = (parts: readonly ReplyPart[]): PanItem[] => parts.flatMap((p) => {
    try {
      return partsToItems([p], dialogue);
    } catch (err) {
      console.error(err);
      return [];
    }
  });

  /** The server's reply as panel items and cards. Never empty (§7.6b.5): nothing usable gives didnt_understand. */
  function mapServer(res: TurnResponse, turn: number): PanReply {
    const good = res.cards.filter(isServerCard);
    const actions = res.actions.filter(isAction);
    const items = itemsOf(res.parts);
    // A malformed card is dropped with didnt_understand; a reply of only model text (dropped, R9) gets it too (M4).
    if (good.length < res.cards.length || (items.length === 0 && good.length === 0 && actions.length === 0)) items.push(say('didnt_understand'));
    const cards: ServerCardView[] = good.map((c) => ({
      origin: 'server', proposalId: c.proposalId, expiresAt: c.expiresAt, card: c.card, issuedTurn: turn, conversationId: res.conversationId,
    }));
    return { items, cards, intents: [], actions, notice: res.notice };
  }

  /** 'gone' when the backend was disposed meanwhile (J1): the caller answers from the script and offers nothing. */
  async function hasAiHealth(): Promise<boolean | 'gone'> {
    const r = await unlessGone(client.consents());
    if (r === 'gone' || isDisposed()) return 'gone';
    // Not known is not granted: the turn stays on the device.
    return r.ok && granted(r.data, 'health_data') && granted(r.data, 'ai_health');
  }

  function fromResponse(res: TurnResponse, text: string, ctx: TurnContext): PanReply {
    if (res.route !== 'scripted') return mapServer(res, ctx.turn);
    const scripted = { ...engine.reply(text, ctx), notice: res.notice };
    switch (res.notice) {
      case 'ai_unavailable': return prefixed([say('mentor.ai_unavailable')], scripted);
      case 'rate_limited': return prefixed([say('rate_limited')], scripted);
      case 'needs_ai_health': return offerAiHealth(scripted);
      case 'ai_off':
      case null:
        return scripted;
    }
  }

  /** One retry, held in memory: after RETRY_AFTER_MS or on `online`, whichever comes first. */
  function scheduleRetry(req: TurnRequest, ctx: TurnContext, scripted: PanReply): void {
    let fired = false;
    // A retry belongs to the conversation it was scheduled in: a clear meanwhile cancels it (fix round 5, H3).
    const gen = conversation.gen;
    const cancel = () => {
      fired = true;
      clearTimeout(timer);
      deps.events.removeEventListener('online', fire);
      cancels.delete(cancel);
    };
    const fire = () => {
      if (fired) return;
      cancel();
      if (disposed) return;
      serial(() => retry(req, ctx, scripted, gen)).catch((err: unknown) => { console.error(err); });
    };
    const timer = setTimeout(fire, RETRY_AFTER_MS);
    deps.events.addEventListener('online', fire);
    cancels.add(cancel);
  }

  async function retry(req: TurnRequest, ctx: TurnContext, scripted: PanReply, gen: number | undefined): Promise<void> {
    if (disposed || conversation.gen !== gen) return;
    // M-3: the health gate again, as for a new turn: ai_health withdrawn since the first try keeps the text on the device.
    if (isHealthTurn(stripPageEvents(req.input.text).text.trim(), ctx) && (await hasAiHealth()) !== true) return;
    if (isDisposed() || conversation.gen !== gen) return;
    const r = await unlessGone(client.mentorTurn({ ...req, conversationId: conversation.id }));
    const emit = (reply: PanReply) => { if (!isDisposed()) for (const fn of listeners) fn(reply); };
    // Disposed, or the conversation was cleared while it was on its way: nothing of it is kept or shown.
    if (r === 'gone' || isDisposed() || conversation.gen !== gen) return;
    if (r.ok && isTurnResponse(r.data)) {
      keepId(gen, r.data.conversationId);
      if (r.data.route === 'scripted') return;
      const mapped = mapServer(r.data, ctx.turn);
      // Shown only when it adds what the script didn't: a server card or a server write. Never model text (R9).
      const addsCards = mapped.cards.length > 0 && scripted.cards.length === 0;
      if (addsCards || mapped.actions.length > 0) emit({ ...mapped, cards: addsCards ? mapped.cards : [] });
      return;
    }
    if (!r.ok && r.status === 401) { await unlessGone(refreshAccount(client, store)); return; }
    emit({ items: [say('ai.try_again'), { kind: 'retry', text: req.input.text }], cards: [], intents: [], actions: [], notice: null });
  }

  /**
   * A new player turn: its own `turnKey` (J2), which its automatic retry reuses (the same request), so the server
   * processes it once. `answering` names the one server card a plain yes or no answers (I-1).
   */
  const request = (text: string, answering?: string): TurnRequest => {
    const now = deps.now();
    return {
      conversationId: conversation.id, input: { kind: 'text', text }, localDate: localDate(now), localTime: hhmm(now), screen: deps.screen(), intakeStep: deps.intakeStep(),
      ...(answering === undefined ? {} : { answering }), turnKey: crypto.randomUUID(),
    };
  };

  /** The stage-4 health gate, mirrored (pre-flight C1): health text stays on the device without ai_health. */
  const isHealthTurn = (stripped: string, ctx: TurnContext): boolean =>
    ctx.intakeStep === 'allergies' || ctx.openCards.some((c) => c.card.kind === 'rule' || c.card.kind === 'meal') ||
    isHealthText(stripped, deps.graph, deps.ruleTerms);

  async function send(text: string, ctx: TurnContext, answering?: string): Promise<PanReply> {
    // Turned off (or the account switched) while this turn waited its place: the script answers and nothing is sent (G5).
    if (isDisposed()) return engine.reply(text, ctx);
    const req = request(text, answering);
    const gen = conversation.gen;
    const r = await unlessGone(client.mentorTurn(req));
    if (r === 'gone') return engine.reply(text, ctx);
    if (r.ok && isTurnResponse(r.data)) {
      keepId(gen, r.data.conversationId);
      return fromResponse(r.data, text, ctx);
    }
    if (!r.ok && r.status === 401) {
      await unlessGone(refreshAccount(client, store));
      return engine.reply(text, ctx);
    }
    const scripted = prefixed([say('mentor.ai_unavailable')], engine.reply(text, ctx));
    if (r.ok || isOutage(r)) scheduleRetry(req, ctx, scripted);
    return scripted;
  }

  /** A text turn, in its place in the queue. */
  async function answer(text: string, ctx: TurnContext): Promise<PanReply> {
    // Released by a dispose: the script answers, nothing is asked of the server.
    if (isDisposed()) return engine.reply(text, ctx);
    const stripped = stripPageEvents(text).text.trim();
    const intent = classifyTurn(stripped);
    // A plain yes or no: a local card is the engine's; two open cards of either origin are never guessed between.
    // M4 final I-1: it goes to the server only when exactly one recent server card is on screen, naming that card;
    // with no recent card it is answered here (no model text is ever shown, R9, so there is nothing else it could answer).
    if (intent === 'yes' || intent === 'no') {
      const recent = ctx.openCards.filter((c) => c.issuedTurn === ctx.turn - 1);
      if (recent.length > 0 && ctx.openCards.length > 1) return lines('confirm.tap_card');
      const [one] = recent;
      if (recent.length !== 1 || one.origin === 'local') return engine.reply(text, ctx);
      return send(text, ctx, one.proposalId);
    }
    // A plain undo goes by the newest live trail entry (pre-flight C36).
    if (intent === 'undo') {
      const newest = ctx.trail.at(-1);
      return newest?.origin === 'server' ? send(text, ctx) : engine.reply(text, ctx);
    }
    if (isHealthTurn(stripped, ctx)) {
      const ok = await hasAiHealth();
      // J1: disposed while asking: the script answers, and no consent card is offered (it may well be granted).
      if (ok === 'gone') return engine.reply(text, ctx);
      if (!ok) return offerAiHealth(engine.reply(text, ctx));
    }
    return send(text, ctx);
  }

  return {
    kind: 'ai',
    get conversationId() { return conversation.id; },
    dispose() {
      disposed = true;
      release();
      for (const c of [...cancels]) c();
      listeners.clear();
    },
    onLate(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    reply(input, ctx) {
      if (input.kind === 'voice') return Promise.resolve(lines('voice.not_yet'));
      const { text } = input;
      return serial(() => answer(text, ctx));
    },
    deliver(input, ctx) {
      // Queued now, in arrival order; the reply is never shown, only its conversation id is kept.
      serial(async () => {
        const { text } = input;
        if (isHealthTurn(stripPageEvents(text).text.trim(), ctx) && (await hasAiHealth()) !== true) return;
        if (isDisposed()) return;
        const req = request(text);
        const gen = conversation.gen;
        const r = await unlessGone(client.mentorTurn(req));
        if (r !== 'gone' && !isDisposed() && r.ok && isTurnResponse(r.data)) keepId(gen, r.data.conversationId);
      }).catch(() => { /* Nothing visible depends on it. */ });
    },
  };
}
