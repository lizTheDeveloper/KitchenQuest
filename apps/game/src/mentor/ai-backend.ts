import {
  classifyTurn, isHealthText, stripPageEvents,
  type IngredientGraph, type IntakeStep, type RuleTerm, type TurnRequest, type TurnResponse,
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
}): MentorBackend & { readonly conversationId: string | null } {
  const { client, engine, dialogue, store } = deps;
  let conversationId: string | null = null;
  const listeners = new Set<(r: PanReply) => void>();
  const say = (trigger: string): PanItem => ({ kind: 'said', said: dialogue.say(trigger) });
  const lines = (...triggers: string[]): PanReply => ({ items: triggers.map(say), cards: [], intents: [], actions: [], notice: null });
  const prefixed = (items: PanItem[], r: PanReply): PanReply => ({ ...r, items: [...items, ...r.items] });

  /** The ai_health card, once ever (`aiHealthOffered`), after the engine's answer. */
  function offerAiHealth(r: PanReply): PanReply {
    if (store.get().aiHealthOffered) return r;
    store.update((s) => ({ ...s, aiHealthOffered: true }));
    return { ...r, items: [...r.items, { kind: 'consent', purpose: 'ai_health' }] };
  }

  async function hasAiHealth(): Promise<boolean> {
    const r = await client.consents();
    // Not known is not granted: the turn stays on the device.
    return r.ok && granted(r.data, 'health_data') && granted(r.data, 'ai_health');
  }

  const serverViews = (res: TurnResponse, turn: number): ServerCardView[] =>
    res.cards.map((c) => ({ origin: 'server', proposalId: c.proposalId, expiresAt: c.expiresAt, card: c.card, issuedTurn: turn }));

  function fromResponse(res: TurnResponse, text: string, ctx: TurnContext): PanReply {
    if (res.route !== 'scripted') {
      return { items: partsToItems(res.parts, dialogue), cards: serverViews(res, ctx.turn), intents: [], actions: res.actions, notice: res.notice };
    }
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
    const fire = () => {
      if (fired) return;
      fired = true;
      clearTimeout(timer);
      deps.events.removeEventListener('online', fire);
      retry(req, ctx, scripted).catch((err: unknown) => { console.error(err); });
    };
    const timer = setTimeout(fire, RETRY_AFTER_MS);
    deps.events.addEventListener('online', fire);
  }

  async function retry(req: TurnRequest, ctx: TurnContext, scripted: PanReply): Promise<void> {
    const r = await client.mentorTurn({ ...req, conversationId });
    const emit = (reply: PanReply) => { for (const fn of listeners) fn(reply); };
    if (r.ok && isTurnResponse(r.data)) {
      conversationId = r.data.conversationId;
      const res = r.data;
      // Shown only when it adds what the script didn't: a server card or a server write. Never model text (R9).
      const addsCards = res.cards.length > 0 && scripted.cards.length === 0;
      if (res.route !== 'scripted' && (addsCards || res.actions.length > 0)) {
        emit({ items: partsToItems(res.parts, dialogue), cards: addsCards ? serverViews(res, ctx.turn) : [], intents: [], actions: res.actions, notice: res.notice });
      }
      return;
    }
    if (!r.ok && r.status === 401) { await refreshAccount(client, store); return; }
    emit({ items: [say('ai.try_again'), { kind: 'retry', text: req.input.text }], cards: [], intents: [], actions: [], notice: null });
  }

  async function send(text: string, ctx: TurnContext): Promise<PanReply> {
    const now = deps.now();
    const req: TurnRequest = {
      conversationId, input: { kind: 'text', text }, localDate: localDate(now), localTime: hhmm(now), screen: deps.screen(), intakeStep: deps.intakeStep(),
    };
    const r = await client.mentorTurn(req);
    if (r.ok && isTurnResponse(r.data)) {
      conversationId = r.data.conversationId;
      return fromResponse(r.data, text, ctx);
    }
    if (!r.ok && r.status === 401) {
      await refreshAccount(client, store);
      return engine.reply(text, ctx);
    }
    const scripted = prefixed([say('mentor.ai_unavailable')], engine.reply(text, ctx));
    if (r.ok || isOutage(r)) scheduleRetry(req, ctx, scripted);
    return scripted;
  }

  return {
    kind: 'ai',
    get conversationId() { return conversationId; },
    onLate(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    async reply(input, ctx) {
      if (input.kind === 'voice') return lines('voice.not_yet');
      const { text } = input;
      const stripped = stripPageEvents(text).text.trim();
      const intent = classifyTurn(stripped);
      // A plain yes or no: a local card is the engine's; two open cards of either origin are never guessed between.
      if (intent === 'yes' || intent === 'no') {
        const recent = ctx.openCards.filter((c) => c.issuedTurn === ctx.turn - 1);
        if (recent.length > 0 && ctx.openCards.length > 1) return lines('confirm.tap_card');
        if (recent.length === 1 && recent[0].origin === 'local') return engine.reply(text, ctx);
        if (recent.length === 1) return send(text, ctx);
      }
      // A plain undo goes by the newest live trail entry (pre-flight C36).
      if (intent === 'undo') {
        const newest = ctx.trail.at(-1);
        return newest?.origin === 'server' ? send(text, ctx) : engine.reply(text, ctx);
      }
      // The stage-4 health gate, mirrored: health text stays on the device without ai_health.
      const health = ctx.intakeStep === 'allergies' || ctx.openCards.some((c) => c.card.kind === 'rule' || c.card.kind === 'meal') ||
        isHealthText(stripped, deps.graph, deps.ruleTerms);
      if (health && !(await hasAiHealth())) return offerAiHealth(engine.reply(text, ctx));
      return send(text, ctx);
    },
  };
}
