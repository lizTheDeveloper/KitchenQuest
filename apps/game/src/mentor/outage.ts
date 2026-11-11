import { classifyTurn, stripPageEvents } from '@kitchenquest/core/engine';
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

/**
 * The deterministic emergency, medical and child answers, from the script, before anything is awaited: these lines never
 * wait on a chunk or a network call. Null for any other turn.
 */
export function localSafetyReply(engine: ScriptedEngine): (input: MentorInput, ctx: TurnContext) => PanReply | null {
  return (input, ctx) => {
    if (input.kind !== 'text') return null;
    const intent = classifyTurn(stripPageEvents(input.text).text.trim());
    return intent === 'emergency' || intent === 'medical' || intent === 'child' ? engine.reply(input.text, ctx) : null;
  };
}
