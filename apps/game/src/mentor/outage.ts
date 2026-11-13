import { classifyTurn, stripPageEvents, type IngredientGraph } from '@kitchenquest/core/engine';
import { safetyReply } from './safety-reply';
import { createScriptedBackend, type MentorInput } from './backend';
import { createChildFlag, type ChildFlag } from './child-flag';
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
  const scripted = createScriptedBackend(engine);
  return async (input, ctx) => {
    // A transcript is a turn like a typed one (M7 Step 6): the same notice.
    return withNotice({ kind: 'said', said: dialogue.say('mentor.ai_unavailable') }, await scripted.reply(input, ctx));
  };
}

/**
 * One place for the AI conversation's server id. `gen` changes when the conversation is cleared, so a reply still on
 * its way from the old conversation never writes its id back (fix round 4, G4).
 */
export interface ConversationRef { id: string | null; gen?: number }

/** Start a new conversation on both sides: the next turn goes with no id, and any reply already in flight is ignored. */
export function newConversation(ref: ConversationRef): void {
  ref.id = null;
  ref.gen = (ref.gen ?? 0) + 1;
}

/** A turn answered on the device. `deliver` says whether its own intent is emergency, medical or child (fix round 4, G2). */
export interface LocalAnswer { reply: PanReply; deliver: boolean }

export interface LocalSafety {
  /** The answer for an emergency, medical or child turn (or any turn once a child spoke), or null for any other turn. Sends nothing. */
  reply(input: MentorInput, ctx: TurnContext): LocalAnswer | null;
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
 * Nothing is sent from here. A turn whose own intent is one of the three is marked `deliver`: the lazy backend hands it
 * to the loaded AI backend's queue (ai-backend.ts `deliver`, same consent gate, reply ignored). A turn answered only
 * because a child spoke earlier is never sent anywhere.
 */
export function createLocalSafety(deps: { dialogue: Dialogue; graph: IngredientGraph; child?: ChildFlag }): LocalSafety {
  // The conversation's one child flag (m-4), shared with the scripted engine and the intake.
  const child = deps.child ?? createChildFlag();
  const d = { dialogue: deps.dialogue, graph: deps.graph, child };
  return {
    reset() { child.reset(); },
    reply(input) {
      // M7 Step 6: a transcript gets the same answers first (§19: a child's speech never reaches the AI either).
      const intent = classifyTurn(stripPageEvents(input.text).text.trim());
      const reply = safetyReply(intent, input.text, d);
      return reply === null ? null : { reply, deliver: intent === 'emergency' || intent === 'child' || intent === 'medical' };
    },
  };
}
