// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import type { TurnRequest } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { createDialogue } from './dialogue';
import { createLocalSafety } from './outage';
import type { PanReply, TurnContext } from './reply';

const dialogue = createDialogue(content.pan);
const ctx: TurnContext = { turn: 1, openCards: [], intakeStep: null, signedIn: true, trail: [] };
const t = (text: string) => ({ kind: 'text' as const, text });
const triggers = (r: PanReply | null) => (r?.items ?? []).flatMap((i) => (i.kind === 'said' ? [i.said.trigger] : []));
const S23 = 'hi im mia im 8 and my mum let me use it. my favourite food is pasta and im allergic to eggs. can you remember that';

function make(mentorTurn: (req: TurnRequest) => Promise<unknown> = () => Promise.resolve({ ok: true, status: 200, data: { conversationId: 'c1', parts: [] } })) {
  const calls: TurnRequest[] = [];
  const client = { mentorTurn: (req: TurnRequest) => { calls.push(req); return mentorTurn(req); } } as unknown as ApiClient;
  const conversation = { id: null as string | null };
  const safety = createLocalSafety({ client, dialogue, graph, now: () => new Date('2026-11-10T12:00:00Z'), conversation, screen: () => null, intakeStep: () => null });
  return { safety, calls, conversation };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('local safety answers (mirror of the server turn.ts)', () => {
  test('F3: an emergency that also states a rule gets the emergency line and the plain ask, never a card', () => {
    const { safety } = make();
    const r = safety.reply(t("I'm allergic to peanuts and my throat is closing"), ctx)!;
    expect(triggers(r)).toEqual(['rule.emergency', 'rule.ask_what_else']);
    expect(r.cards).toEqual([]);
  });

  test('an emergency with no rule stated is the emergency line alone', () => {
    expect(triggers(make().safety.reply(t('my throat is closing'), ctx))).toEqual(['rule.emergency']);
  });

  test('medical gets the deflect line; any other text is not answered here', () => {
    const { safety } = make();
    expect(triggers(safety.reply(t('should I take antibiotics for my rash'), ctx))).toEqual(['rule.medical_deflect']);
    expect(safety.reply(t('thank you'), ctx)).toBeNull();
    expect(safety.reply({ kind: 'voice' }, ctx)).toBeNull();
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

  test('F2: every answered turn is posted to the server in the background, in one conversation, one at a time', async () => {
    const { safety, calls, conversation } = make();
    safety.reply(t('my throat is closing'), ctx);
    safety.reply(t('should I take antibiotics for my rash'), ctx);
    safety.reply(t('thank you'), ctx); // not answered here, not posted
    safety.reply(t(S23), ctx);
    await flush();
    expect(calls.map((c) => c.input)).toEqual([
      { kind: 'text', text: 'my throat is closing' }, { kind: 'text', text: 'should I take antibiotics for my rash' }, { kind: 'text', text: S23 },
    ]);
    expect(calls.map((c) => c.conversationId)).toEqual([null, 'c1', 'c1']);
    expect(conversation.id).toBe('c1');
  });

  test('a failing background post changes nothing visible', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { safety, calls } = make(() => Promise.reject(new Error('offline')));
    const r = safety.reply(t('my throat is closing'), ctx);
    expect(triggers(r)).toEqual(['rule.emergency']);
    await flush();
    expect(calls).toHaveLength(1);
    expect(triggers(safety.reply(t('my throat is closing'), ctx))).toEqual(['rule.emergency']);
    err.mockRestore();
  });
});
