import { classifyTurn, emergencyRuleAsk, emergencyStatesRule, stripPageEvents, type IngredientGraph, type IntakeStep, type TurnRequest } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { localDate } from '../recipes/rules';
import { createScriptedBackend, type MentorInput } from './backend';
import type { Dialogue } from './dialogue';
import type { PanItem, PanReply, TurnContext } from './reply';
import type { ScriptedEngine } from './scripted';

/** Lines that must reach a player first, plainly, whatever else is going on (voice.md: no joke before an emergency). */
const SAFETY_FIRST: ReadonlySet<string> = new Set(['rule.emergency', 'rule.medical_deflect', 'child.grownup']);

/**
 * A notice ("answering from the script", "slow down") placed in a reply. A reply that leads with an emergency, medical
 * or child line keeps that line first: the notice follows it, never comes before it.
 */
export function withNotice(notice: PanItem, r: PanReply): PanReply {
  const [head, ...rest] = r.items;
  if (head?.kind === 'said' && SAFETY_FIRST.has(head.said.trigger)) return { ...r, items: [head, notice, ...rest] };
  return { ...r, items: [notice, ...r.items] };
}

/** What answers a turn when the AI backend can't (its code won't load, or loads too slowly): the script, notice after any safety line. */
export function scriptedWhenUnavailable(engine: ScriptedEngine, dialogue: Dialogue): (input: MentorInput, ctx: TurnContext) => Promise<PanReply> {
  const scripted = createScriptedBackend(engine, dialogue);
  return async (input, ctx) => {
    const r = await scripted.reply(input, ctx);
    return input.kind === 'text' ? withNotice({ kind: 'said', said: dialogue.say('mentor.ai_unavailable') }, r) : r;
  };
}

/** One place for the AI conversation's server id, shared by the AI backend and the local safety answers so both speak in the same conversation. */
export interface ConversationRef { id: string | null }

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export interface LocalSafety {
  /** The answer for an emergency, medical or child turn (or any turn once a child spoke), or null for any other turn. Sends nothing a player can see. */
  reply(input: MentorInput, ctx: TurnContext): PanReply | null;
  /** A new conversation: the child flag is forgotten (as the server's is, with its conversation). */
  reset(): void;
}

/**
 * The emergency, medical and child answers, from the script, before anything is awaited (these lines never wait on a
 * chunk or a network call). Mirrors the server's turn.ts stages 2a/2b exactly:
 * - an emergency gets the emergency line, then the plain ask when the message states a rule (never a card), and no ask
 *   in a conversation where a child spoke; it does not set the child flag;
 * - a child turn, and every later turn of the conversation, gets `child.grownup` (§19, P-9: a child never reaches the AI);
 * - a medical question gets the deflect line.
 * Each answered turn is also posted to the server in the background (reply ignored, failures swallowed, one at a time),
 * so the server's child flag and turn counter advance as if it had answered.
 */
export function createLocalSafety(deps: {
  client: ApiClient; dialogue: Dialogue; graph: IngredientGraph; now: () => Date; conversation: ConversationRef;
  screen: () => TurnRequest['screen']; intakeStep: () => IntakeStep | null;
}): LocalSafety {
  const { client, dialogue, graph } = deps;
  let child = false;
  let queue: Promise<unknown> = Promise.resolve();
  const say = (trigger: string, vars: Record<string, string> = {}): PanItem => ({ kind: 'said', said: dialogue.say(trigger, vars) });
  const post = (text: string): void => {
    const now = deps.now();
    queue = queue.then(async () => {
      try {
        const r = await client.mentorTurn({
          conversationId: deps.conversation.id, input: { kind: 'text', text }, localDate: localDate(now), localTime: hhmm(now),
          screen: deps.screen(), intakeStep: deps.intakeStep(),
        });
        if (r.ok && (typeof r.data.conversationId === 'string')) deps.conversation.id = r.data.conversationId;
      } catch {
        // Nothing visible depends on it.
      }
    });
  };
  return {
    reset() { child = false; },
    reply(input) {
      if (input.kind !== 'text') return null;
      const raw = input.text;
      const intent = classifyTurn(stripPageEvents(raw).text.trim());
      let items: PanItem[];
      if (intent === 'emergency') {
        items = [say('rule.emergency')];
        if (!child && emergencyStatesRule(raw, graph)) {
          const ask = emergencyRuleAsk(raw, [], graph) ?? { trigger: 'rule.ask_keep_off', vars: {} };
          items.push(say(ask.trigger, ask.vars));
        }
      } else if (intent === 'child' || child) {
        child = true;
        items = [say('child.grownup')];
      } else if (intent === 'medical') {
        items = [say('rule.medical_deflect')];
      } else {
        return null;
      }
      post(raw);
      return { items, cards: [], intents: [], actions: [], notice: null };
    },
  };
}
