// M7 Step 9: the one path from a transcript to a backend (Ruling 4). A lazy module: only voice reaches it.
//
// Speech-to-text output is untrusted user text (§7.6), and mishearing an allergen is the worst failure mode. So core
// `heardCheck` runs on the device before any backend sees a transcript: a transcript naming a food, a rule term or a
// sound-alike draws the heard card, and nothing is sent until a tap on it confirms the words (`input.heard.words`).
// The device's scripted engine runs the same gate (`heardGate`, carry 1), so a transcript that reaches it by any path
// (AI off, no ai_health, an outage, a retry) never builds a card from words nobody confirmed.
import {
  CHILD_PATTERNS, classifyTurn, heardCheck, heardConfirmed, heardLine, isEmergency, normalizeText, stripPageEvents, stripPageEventsFull, tryHeardChoice,
  type HeardCheck, type IngredientGraph, type RuleTerm,
} from '@kitchenquest/core/engine';
import { createChildFlag, type ChildFlag } from './child-flag';
import type { Dialogue } from './dialogue';
import { safetyReply } from './safety-reply';
import type { MentorInput, PanItem, PanReply, TurnContext } from './reply';

export interface VoiceTurnDeps {
  /** The panel's backend (backend.ts `MentorBackend`; named by shape, so the scripted engine can reach this module). */
  backend: { reply(input: MentorInput, ctx: TurnContext): Promise<PanReply> };
  graph: IngredientGraph;
  ruleTerms: readonly RuleTerm[];
  dialogue: Dialogue;
  /** The conversation's child flag: once a child spoke, the backend's fixed line answers (no card, no gate needed). */
  child?: { readonly on: boolean };
}
type Transcript = Extract<MentorInput, { kind: 'transcript' }>;

/** Ruling 4's order: emergency, medical and child answers come first; they build no card, so they skip the gate. */
const SAFETY_FIRST: ReadonlySet<string> = new Set(['emergency', 'medical', 'child']);
const safetyFirst = (text: string, child?: { readonly on: boolean }): boolean =>
  child?.on === true || SAFETY_FIRST.has(classifyTurn(stripPageEvents(text).text.trim()));

const lines = (items: PanItem[]): PanReply => ({ items, cards: [], intents: [], actions: [], notice: null });
const say = (d: Dialogue, trigger: string, vars?: Record<string, string>): PanItem => ({ kind: 'said', said: d.say(trigger, vars) });

/**
 * The heard card for `text`: its line (`voice.heard_check`, or `_spelled` with health wording: core `heardLine`,
 * spelled by code, §7.6b.2) and the card. `serverWords`: a server heard part's own words, sent back unchanged when
 * the player keeps the words as heard (P7: the server's graph may name a word the device's does not).
 */
function heardReply(text: string, check: HeardCheck, utteranceId: number | null, deps: VoiceTurnDeps, serverWords?: readonly string[]): PanReply {
  const line = heardLine(check);
  return lines([
    say(deps.dialogue, line.trigger, line.vars),
    { kind: 'heard', check, utteranceId, onPick: (choice, ctx) => confirmHeard(text, check, choice, ctx, deps, { utteranceId, ...(serverWords ? { serverWords } : {}) }) },
  ]);
}

/**
 * The device heard gate (carry 1): null when the transcript may go on (a safety text, nothing heard, or exactly the
 * words its card's tap confirmed); else the heard card, or `voice.too_long` for a text too long to check (N7: tested
 * first). Nothing is sent from here.
 */
export function heardGate(input: Transcript, deps: VoiceTurnDeps): PanReply | null {
  if (safetyFirst(input.text, deps.child)) return null;
  const check = heardCheck(input.text, deps.graph, deps.ruleTerms);
  if (check === null) return null;
  if (check.tooLong) return lines([say(deps.dialogue, 'voice.too_long')]);
  if (heardConfirmed(check, input.heard?.words)) return null;
  return heardReply(input.text, check, input.utteranceId ?? null, deps);
}

/**
 * A spoken turn: '' → `voice.didnt_catch`; a local heard check → the heard card (with `utteranceId`) and its line,
 * nothing sent; else `backend.reply({ kind: 'transcript', text }, ctx)`.
 */
export async function transcriptTurn(text: string, utteranceId: number, ctx: TurnContext, deps: VoiceTurnDeps): Promise<PanReply> {
  if (text.trim() === '') return lines([say(deps.dialogue, 'voice.didnt_catch')]);
  const input: Transcript = { kind: 'transcript', text, utteranceId };
  return heardGate(input, deps) ?? deps.backend.reply(input, ctx);
}

/**
 * The heard card's "Yes, that's what I said" tap (Ruling 4). `choice[i]` swaps term i for its alternative (null keeps
 * the words as heard). Core `tryHeardChoice(…, graph)` applies it (the graph guards severity); any refusal keeps
 * asking: the card again, or `voice.too_long`. The words sent are those a check of the final text names: the server
 * heard part's own words when the text is unchanged (P7), else the device's re-check. It is a new backend turn, so it
 * carries a new turnKey (ai-backend.ts `request`).
 */
export function confirmHeard(
  text: string, check: HeardCheck, choice: readonly (number | null)[], ctx: TurnContext, deps: VoiceTurnDeps,
  opts: { serverWords?: readonly string[]; utteranceId?: number | null } = {},
): Promise<PanReply> {
  return Promise.resolve().then(() => {
    const utteranceId = opts.utteranceId ?? null;
    const r = tryHeardChoice(text, check, choice, deps.graph);
    if (!r.ok) return r.reason === 'too_long' ? lines([say(deps.dialogue, 'voice.too_long')]) : heardReply(text, check, utteranceId, deps, opts.serverWords);
    let words: string[];
    if (opts.serverWords !== undefined && r.text === text) words = [...opts.serverWords];
    else {
      const again = heardCheck(r.text, deps.graph, deps.ruleTerms);
      if (again?.tooLong === true) return lines([say(deps.dialogue, 'voice.too_long')]);
      words = again === null ? [] : again.terms.map((t) => t.heard);
    }
    // Fix round 1 (M-9): a changed text is no longer what the utterance said, so it names no utterance (the API would
    // speak the original words while the screen shows the swapped ones).
    const sameUtterance = utteranceId !== null && r.text === text;
    const input: Transcript = {
      kind: 'transcript', text: r.text, ...(words.length > 0 ? { heard: { words } } : {}), ...(sameUtterance ? { utteranceId } : {}),
    };
    return deps.backend.reply(input, ctx);
  });
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isAlt = (a: unknown): boolean => isObj(a) && isStr(a.id) && isStr(a.name) && isStr(a.spelled);
const isTerm = (t: unknown): boolean => isObj(t) && isStr(t.heard) && isStr(t.spelled) && Array.isArray(t.at) && t.at.every(Number.isInteger)
  && Array.isArray(t.alternatives) && t.alternatives.every(isAlt);
/** A server `heard` part's check, shape-checked before it is drawn (a malformed one is dropped). */
export function isHeardCheck(x: unknown): x is HeardCheck {
  return isObj(x) && x.tooLong === false && typeof x.speakSpelling === 'boolean' && Array.isArray(x.terms) && x.terms.length > 0 && x.terms.every(isTerm);
}

/** A server heard part (P7) as the panel's heard item: confirming sends the server's own words back. */
export function serverHeardItem(check: HeardCheck, input: Transcript, deps: VoiceTurnDeps): PanItem {
  const utteranceId = input.utteranceId ?? null;
  const serverWords = check.terms.map((t) => t.heard);
  return { kind: 'heard', check, utteranceId, onPick: (choice, ctx) => confirmHeard(input.text, check, choice, ctx, deps, { serverWords, utteranceId }) };
}

/**
 * M7 Step 10 fix round 4 (controller ruling): a transcript too long to take in is never sent, but an emergency or a
 * child in it is never missed. The whole text is scanned, uncapped (core `normalizeText` of `stripPageEventsFull`),
 * emergency first, then child, in the API turn's order. An emergency gets the reply a typed one gets (rule.emergency,
 * then its asks); a child sets the conversation's child flag (which closes voice) and gets child.grownup. Otherwise
 * null: the caller says voice.too_long. Nothing is sent from here.
 *
 * M7 Step 11 (F4-1, emergency half): `emergency` is the API's own whole-text finding for a transcript over MAX_TEXT,
 * which never reaches the device (`text` is then empty): the same emergency reply, first.
 */
export function overLongSafety(text: string, deps: { dialogue: Dialogue; graph: IngredientGraph; child?: ChildFlag }, emergency = false): PanReply | null {
  const full = normalizeText(stripPageEventsFull(text).text);
  const d = { ...deps, child: deps.child ?? createChildFlag() };
  if (emergency || isEmergency(full)) return safetyReply('emergency', text, d);
  if (CHILD_PATTERNS.some((p) => p.test(full))) return safetyReply('child', text, d);
  return null;
}
