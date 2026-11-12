// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { content, graph } from '../content';
import { createDialogue } from './dialogue';
import { createLocalSafety, newConversation, type ConversationRef, type LocalAnswer } from './outage';
import type { PanReply, TurnContext } from './reply';

const dialogue = createDialogue(content.pan);
const ctx: TurnContext = { turn: 1, openCards: [], intakeStep: null, signedIn: true, trail: [] };
const t = (text: string) => ({ kind: 'text' as const, text });
const triggers = (a: LocalAnswer | PanReply | null) => { const r = a !== null && 'reply' in a ? a.reply : a; return (r?.items ?? []).flatMap((i) => (i.kind === 'said' ? [i.said.trigger] : [])); };
const S23 = 'hi im mia im 8 and my mum let me use it. my favourite food is pasta and im allergic to eggs. can you remember that';

function make() {
  return { safety: createLocalSafety({ dialogue, graph }) };
}
const answer = (r: LocalAnswer | null) => r?.reply ?? null;

describe('local safety answers (mirror of the server turn.ts)', () => {
  test('F3: an emergency that also states a rule gets the emergency line and the plain ask, never a card', () => {
    const { safety } = make();
    const r = answer(safety.reply(t("I'm allergic to peanuts and my throat is closing"), ctx))!;
    expect(triggers(r)).toEqual(['rule.emergency', 'rule.ask_what_else']);
    expect(r.cards).toEqual([]);
  });

  test('I-2: an emergency that names several allergens asks about every one, as the server does', () => {
    const r = answer(make().safety.reply(t('allergic to peanuts and shrimp and my throat is closing'), ctx))!;
    // One ask per allergen named (peanut, shrimp): before I-2 only the first was asked about.
    expect(triggers(r)).toEqual(['rule.emergency', 'rule.ask_what_else', 'rule.ask_what_else']);
    expect(r.cards).toEqual([]);
  });

  test('an emergency with no rule stated is the emergency line alone', () => {
    expect(triggers(make().safety.reply(t('my throat is closing'), ctx))).toEqual(['rule.emergency']);
  });

  test('medical gets the deflect line; any other text is not answered here', () => {
    const { safety } = make();
    expect(triggers(safety.reply(t('should I take antibiotics for my rash'), ctx))).toEqual(['rule.medical_deflect']);
    expect(safety.reply(t('thank you'), ctx)).toBeNull();
    // M7 Step 6: a transcript gets the same answers first (§19), and nothing for any other turn.
    expect(triggers(safety.reply({ kind: 'transcript', text: 'should I take antibiotics for my rash' }, ctx))).toEqual(['rule.medical_deflect']);
    expect(safety.reply({ kind: 'transcript', text: 'thank you' }, ctx)).toBeNull();
  });

  test('F1: after a child turn every later turn gets child.grownup, and an emergency gets no rule ask; reset forgets it', () => {
    const { safety } = make();
    expect(triggers(safety.reply(t(S23), ctx))).toEqual(['child.grownup']);
    expect(triggers(safety.reply(t("I'm allergic to eggs"), ctx))).toEqual(['child.grownup']);
    expect(triggers(safety.reply(t('yes'), ctx))).toEqual(['child.grownup']);
    expect(triggers(safety.reply(t("I'm allergic to peanuts and my throat is closing"), ctx))).toEqual(['rule.emergency']);
    expect(safety.reply(t('thank you'), ctx)).not.toBeNull(); // still a child conversation
    safety.reset();
    expect(safety.reply(t("I'm allergic to eggs"), ctx)).toBeNull();
  });

  test('an emergency does not set the child flag', () => {
    const { safety } = make();
    safety.reply(t("im 8 and my throat is closing"), ctx);
    expect(safety.reply(t("I'm allergic to eggs"), ctx)).toBeNull();
  });

  test('fix round 4 (G2): only a turn whose own intent is emergency, medical or child is marked for delivery; sticky-only turns never are', () => {
    const { safety } = make();
    expect(safety.reply(t('my throat is closing'), ctx)?.deliver).toBe(true);
    expect(safety.reply(t('should I take antibiotics for my rash'), ctx)?.deliver).toBe(true);
    expect(safety.reply(t('im 8'), ctx)?.deliver).toBe(true);
    const sticky = safety.reply(t('what should I cook tonight'), ctx);
    expect(triggers(sticky)).toEqual(['child.grownup']);
    expect(sticky?.deliver).toBe(false);
    expect(safety.reply(t('yes'), ctx)?.deliver).toBe(false);
  });

  test('newConversation drops the id and moves the generation on', () => {
    const ref: ConversationRef = { id: 'c1' };
    newConversation(ref);
    expect(ref).toEqual({ id: null, gen: 1 });
    newConversation(ref);
    expect(ref.gen).toBe(2);
  });
});
