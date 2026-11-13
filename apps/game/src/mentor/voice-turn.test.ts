// M7 Step 9: the one path from a transcript to a backend (Ruling 4: the heard gate runs on the device first).
import { heardCheck, heardConfirmed, type HeardCheck, type TurnRequest, type TurnResponse } from '@kitchenquest/core/engine';
import { describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { createStore } from '../state/store';
import { createAiBackend } from './ai-backend';
import type { MentorBackend, MentorInput } from './backend';
import { createScriptedBackend } from './backend';
import { createChildFlag } from './child-flag';
import { createDialogue } from './dialogue';
import type { PanItem, PanReply, TurnContext } from './reply';
import { createScriptedEngine } from './scripted';
import { confirmHeard, transcriptTurn } from './voice-turn';

const T0 = new Date('2026-11-13T18:05:00');
const dialogue = createDialogue(content.pan);
const ctx: TurnContext = { turn: 1, openCards: [], intakeStep: null, signedIn: true, trail: [] };
const empty = (): PanReply => ({ items: [], cards: [], intents: [], actions: [], notice: null });

function fakeBackend() {
  const inputs: MentorInput[] = [];
  const backend: MentorBackend = { kind: 'ai', reply: vi.fn((i: MentorInput) => { inputs.push(i); return Promise.resolve(empty()); }) };
  return { backend, inputs, deps: { backend, graph, ruleTerms: content.ruleTerms, dialogue } };
}
const heardOf = (r: PanReply) => r.items.find((i): i is Extract<PanItem, { kind: 'heard' }> => i.kind === 'heard');
const triggers = (r: PanReply) => r.items.flatMap((i) => (i.kind === 'said' ? [i.said.trigger] : []));

describe('transcriptTurn', () => {
  test('"I can\'t eat sesame" → heard item with utteranceId and voice.heard_check_spelled; backend.reply never called', async () => {
    const { deps, backend } = fakeBackend();
    const r = await transcriptTurn("I can't eat sesame", 7, ctx, deps);
    const heard = heardOf(r)!;
    expect(heard.utteranceId).toBe(7);
    expect(heard.check.terms.map((t) => [t.heard, t.spelled])).toEqual([['sesame', 'S-E-S-A-M-E']]);
    expect(triggers(r)).toEqual(['voice.heard_check_spelled']);
    expect(r.items.find((i) => i.kind === 'said')!.kind === 'said' && (r.items[0] as Extract<PanItem, { kind: 'said' }>).said.text).toContain('S-E-S-A-M-E');
    expect(r.cards).toEqual([]);
    expect(backend.reply).not.toHaveBeenCalled();
  });

  test('confirm as heard → backend gets { kind: "transcript", text, heard: { words: ["sesame"] } }', async () => {
    const { deps, inputs } = fakeBackend();
    const r = await transcriptTurn("I can't eat sesame", 7, ctx, deps);
    await heardOf(r)!.onPick([null], ctx);
    expect(inputs).toEqual([{ kind: 'transcript', text: "I can't eat sesame", heard: { words: ['sesame'] }, utteranceId: 7 }]);
  });

  test('an alternative chip ("rice" → "rye") sends the replaced text with the re-checked words', async () => {
    const { deps, inputs } = fakeBackend();
    const r = await transcriptTurn("I'm allergic to rice", 3, ctx, deps);
    const heard = heardOf(r)!;
    const rye = heard.check.terms[0].alternatives.findIndex((a) => a.name === 'rye');
    expect(rye).toBeGreaterThanOrEqual(0);
    await heard.onPick([rye], ctx);
    // Fix round 1 (M-9): the text is no longer the utterance's, so it names no utterance (the API would say "rice").
    expect(inputs).toEqual([{ kind: 'transcript', text: "I'm allergic to rye", heard: { words: ['rye'] } }]);
    // The words sent are exactly what the server's own check of the sent text confirms.
    expect(heardConfirmed(heardCheck("I'm allergic to rye", graph, content.ruleTerms)!, ['rye'])).toBe(true);
  });

  test('"next step" → straight to the backend; "" → voice.didnt_catch', async () => {
    const { deps, inputs } = fakeBackend();
    await transcriptTurn('next step', 1, ctx, deps);
    expect(inputs).toEqual([{ kind: 'transcript', text: 'next step', utteranceId: 1 }]);
    const r = await transcriptTurn('  ', 2, ctx, deps);
    expect(triggers(r)).toEqual(['voice.didnt_catch']);
    expect(inputs).toHaveLength(1);
  });

  test('an emergency goes to the backend first (Ruling 4 order: the device safety answer), never to a heard card', async () => {
    const { deps, inputs } = fakeBackend();
    await transcriptTurn("I ate peanuts and my throat is closing, I can't breathe", 4, ctx, deps);
    expect(inputs.map((i) => i.text)).toEqual(["I ate peanuts and my throat is closing, I can't breathe"]);
  });

  test('a transcript too long to check is refused with voice.too_long, nothing sent', async () => {
    const { deps, backend } = fakeBackend();
    const r = await transcriptTurn(`I'm allergic to ${'sesame and '.repeat(80)}soy`, 5, ctx, deps);
    expect(triggers(r)).toEqual(['voice.too_long']);
    expect(heardOf(r)).toBeUndefined();
    expect(backend.reply).not.toHaveBeenCalled();
  });
});

describe('confirmHeard (carry 2: tryHeardChoice with the graph; keep asking on a refusal)', () => {
  test('a choice that would lower severity is refused: the card is asked again and nothing is sent', async () => {
    const { deps, backend } = fakeBackend();
    // A forged check whose "term" sits on the severity word: replacing it would lower severity, so it is refused.
    const text = "I'm anaphylactic to sesame";
    const check: HeardCheck = { tooLong: false, speakSpelling: true, terms: [{ heard: 'anaphylactic', spelled: 'A', id: null, at: [2], alternatives: [{ id: 'oat', name: 'mildly bothered by', spelled: 'X' }] }] };
    const r = await confirmHeard(text, check, [0], ctx, deps);
    expect(backend.reply).not.toHaveBeenCalled();
    const again = heardOf(r)!;
    expect(again.check).toBe(check);
    // Keeps asking: the re-shown card's own yes still works, with the words as heard.
    expect(triggers(r)).toEqual(['voice.heard_check_spelled']);
  });

  test('confirmHeard needs the graph (the severity guard): tryHeardChoice throws without it', async () => {
    const { deps } = fakeBackend();
    const check = heardCheck("I can't eat sesame", graph, content.ruleTerms)!;
    await expect(confirmHeard("I can't eat sesame", check, [null], ctx, { ...deps, graph: undefined as never })).rejects.toThrow(/graph is required/);
  });
});

describe('the server heard part (P7) and the turnKey (carry 2)', () => {
  function aiRig(answer: (req: TurnRequest) => TurnResponse) {
    const store = createStore(null);
    store.update((s) => ({ ...s, account: { email: 'a@b.c' } }));
    const reqs: TurnRequest[] = [];
    const client = {
      mentorTurn: vi.fn((req: TurnRequest) => { reqs.push(req); return Promise.resolve({ ok: true, status: 200, data: answer(req) }); }),
      // health_data and ai_health granted: a health-worded transcript may reach the server once its heard card is tapped.
      consents: vi.fn(() => Promise.resolve({ ok: true, status: 200, data: { consents: ['health_data', 'ai_health'].map((purpose) => ({ purpose, withdrawnAt: null, current: true })), needsReconsent: [], notices: {} } })),
    } as unknown as ApiClient;
    const recipes = Object.entries(content.recipes).map(([slug, r]) => ({ slug, title: r.meta.title }));
    const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes, now: () => T0 });
    const backend = createAiBackend({
      client, engine, dialogue, store, graph, ruleTerms: content.ruleTerms, now: () => T0, screen: () => null, intakeStep: () => null, events: new EventTarget(),
    });
    return { backend, reqs, deps: { backend, graph, ruleTerms: content.ruleTerms, dialogue } };
  }
  const base = { route: 'ai' as const, cards: [], actions: [], conversationId: 'c1', notice: null, replyId: 'r1', toolTurn: false };

  test('a server heard part for a word the device did not flag (an older device graph) renders the card, and confirming sends the server\'s words, which the server accepts (P7)', async () => {
    // The device's check of "pass the zorbleberries" names nothing; the server's (a newer graph) names "zorbleberries".
    const text = 'pass the zorbleberries';
    expect(heardCheck(text, graph, content.ruleTerms)).toBeNull();
    const serverCheck: HeardCheck = { tooLong: false, speakSpelling: false, terms: [{ heard: 'zorbleberries', spelled: 'Z-O-R-B-L-E-B-E-R-R-I-E-S', id: 'zorbleberry', at: [2], alternatives: [] }] };
    let accepted = false;
    const { reqs, deps } = aiRig((req) => {
      if (req.input.kind === 'transcript' && req.input.heard !== undefined) {
        accepted = heardConfirmed(serverCheck, req.input.heard.words);
        return { ...base, parts: [{ kind: 'line', line: { trigger: 'thanks', vars: {} } }] };
      }
      return { ...base, parts: [{ kind: 'line', line: { trigger: 'voice.heard_check', vars: { terms: 'zorbleberries' } } }, { kind: 'heard', check: serverCheck }] };
    });
    const r = await transcriptTurn(text, 9, ctx, deps);
    expect(r.replyId).toBe('r1');
    const heard = heardOf(r)!;
    expect(heard.utteranceId).toBe(9);
    expect(heard.check.terms[0].heard).toBe('zorbleberries');
    await heard.onPick([null], { ...ctx, turn: 2 });
    expect(reqs).toHaveLength(2);
    expect(reqs[1].input).toEqual({ kind: 'transcript', text, heard: { words: ['zorbleberries'] } });
    expect(accepted).toBe(true);
    // A confirmed turn is a new turn: its own turnKey (the server processes it, never replays the gated one).
    expect(reqs[1].turnKey).not.toBe(reqs[0].turnKey);
    // The utterance id never leaves the device in a turn.
    expect(JSON.stringify(reqs)).not.toContain('utteranceId');
  });

  test('a device-flagged transcript reaches the server only after the tap, with a new turnKey each time it is confirmed', async () => {
    const { reqs, deps } = aiRig(() => ({ ...base, parts: [{ kind: 'line', line: { trigger: 'thanks', vars: {} } }] }));
    const r = await transcriptTurn("I can't eat sesame", 1, ctx, deps);
    expect(reqs).toHaveLength(0);
    await heardOf(r)!.onPick([null], ctx);
    await heardOf(r)!.onPick([null], ctx);
    expect(reqs.map((q) => q.input)).toEqual([0, 1].map(() => ({ kind: 'transcript', text: "I can't eat sesame", heard: { words: ['sesame'] } })));
    expect(reqs[0].turnKey).not.toBe(reqs[1].turnKey);
  });
});

describe('carry 1 (M4, Step 6): the device scripted engine runs the heard gate before any card from a transcript', () => {
  const recipes = Object.entries(content.recipes).map(([slug, r]) => ({ slug, title: r.meta.title }));
  const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes, now: () => T0 });

  test('AI off: an unconfirmed transcript naming a food gets the heard card and no card; the same words typed get the rule card (positive control)', async () => {
    const backend = createScriptedBackend(engine);
    const spoken = await backend.reply({ kind: 'transcript', text: "I'm allergic to sesame" }, ctx);
    expect(spoken.cards).toEqual([]);
    expect(heardOf(spoken)).toBeDefined();
    const typed = await backend.reply({ kind: 'text', text: "I'm allergic to sesame" }, ctx);
    expect(typed.cards.map((c) => c.card.kind)).toEqual(['rule']);
    // Confirmed by its tap: now the engine builds the card.
    const confirmed = await heardOf(spoken)!.onPick([null], ctx);
    expect(confirmed.cards.map((c) => c.card.kind)).toEqual(['rule']);
  });

  test('the heard words must match: wrong or missing words keep the card; a meal and a pantry change are gated too', async () => {
    const backend = createScriptedBackend(engine);
    const wrong = await backend.reply({ kind: 'transcript', text: "I'm allergic to sesame", heard: { words: ['soy'] } }, ctx);
    expect(wrong.cards).toEqual([]);
    expect(heardOf(wrong)).toBeDefined();
    for (const text of ['I had rice for lunch', 'I bought some rice']) {
      const r = await backend.reply({ kind: 'transcript', text }, { ...ctx, signedIn: true });
      expect(r.cards, text).toEqual([]);
      expect(heardOf(r), text).toBeDefined();
    }
  });

  test('a transcript with no food word goes straight to the engine; a child or emergency transcript gets its fixed line first', async () => {
    const child = createChildFlag();
    const e = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes, now: () => T0, child });
    const backend = createScriptedBackend(e);
    const hi = await backend.reply({ kind: 'transcript', text: 'hello there' }, ctx);
    expect(heardOf(hi)).toBeUndefined();
    const em = await backend.reply({ kind: 'transcript', text: "I ate peanuts and my throat is closing, I can't breathe" }, ctx);
    expect(triggers(em)[0]).toBe('rule.emergency');
    expect(heardOf(em)).toBeUndefined();
  });
});

describe('carry 12 (Ruling 12): a spoken yes counts only for a non-severe card', () => {
  const recipes = Object.entries(content.recipes).map(([slug, r]) => ({ slug, title: r.meta.title }));
  const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes, now: () => T0 });
  const backend = createScriptedBackend(engine);
  const deps = { backend, graph, ruleTerms: content.ruleTerms, dialogue };
  const open = async (text: string) => (await backend.reply({ kind: 'text', text }, ctx)).cards[0];

  test('spoken "yes" with a non-severe card open: the confirm intent (the writer\'s typed_yes); with a severe card: none, and the tap line', async () => {
    const mild = await open("I'm intolerant to lactose");
    expect(mild.card.kind === 'rule' && mild.card.severe).toBe(false);
    const yesMild = await transcriptTurn('yes', 1, { ...ctx, turn: 2, openCards: [mild] }, deps);
    expect(yesMild.intents).toEqual([{ kind: 'confirm', localId: mild.origin === 'local' ? mild.localId : '' }]);
    const severe = await open("I'm allergic to sesame");
    expect(severe.card.kind === 'rule' && severe.card.severe).toBe(true);
    const yesSevere = await transcriptTurn('yes', 2, { ...ctx, turn: 2, openCards: [severe] }, deps);
    expect(yesSevere.intents).toEqual([]);
    expect(triggers(yesSevere)).toContain('rule.tap_needed');
  });
});
