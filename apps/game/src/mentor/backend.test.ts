import { expect, test } from 'vitest';
import content from 'virtual:kq-content';
import { graph } from '../content';
import { createScriptedBackend } from './backend';
import { createDialogue } from './dialogue';
import type { PanReply, TurnContext } from './reply';
import { createScriptedEngine } from './scripted';

const backend = () => {
  const dialogue = createDialogue(content.pan);
  const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes: [], now: () => new Date(2026, 10, 10, 9, 0) });
  return createScriptedBackend(engine);
};
const ctx: TurnContext = { turn: 1, openCards: [], intakeStep: null, signedIn: false, trail: [] };
const said = (r: PanReply) => r.items.flatMap((i) => (i.kind === 'said' ? [i.said.trigger] : []));

test('a thin wrapper over the engine: thanks → thanks; other text → the engine; a transcript → the heard gate, then the engine (M7 Step 9, carry 1)', async () => {
  const b = backend();
  expect(b.kind).toBe('scripted');
  for (const text of ['thanks', 'Thank you!', 'cheers mate', 'ta']) expect(said(await b.reply({ kind: 'text', text }, ctx))).toEqual(['thanks']);
  expect(said(await b.reply({ kind: 'text', text: 'tell me a joke' }, ctx))).toEqual(['didnt_understand']);
  const rule = await b.reply({ kind: 'text', text: "I'm allergic to sesame" }, ctx);
  expect(rule.cards.map((c) => c.card.kind)).toEqual(['rule']);
  // Unconfirmed: the heard card, never a card. Confirmed with exactly its words: the engine, as text.
  const spoken = await b.reply({ kind: 'transcript', text: "I'm allergic to sesame" }, ctx);
  expect(spoken.cards).toEqual([]);
  expect(spoken.items.map((i) => i.kind)).toEqual(['said', 'heard']);
  const confirmed = await b.reply({ kind: 'transcript', text: "I'm allergic to sesame", heard: { words: ['sesame'] } }, ctx);
  expect(confirmed.cards.map((c) => c.card.kind)).toEqual(['rule']);
  expect(said(confirmed)).toEqual(said(rule));
});

test('a throw from the engine arrives as a rejection', async () => {
  const b = createScriptedBackend({ reply: () => { throw new Error('boom'); }, replyTo: () => { throw new Error('boom'); }, cardFromChoice: () => { throw new Error('no'); } });
  await expect(b.reply({ kind: 'text', text: 'x' }, ctx)).rejects.toThrow('boom');
});
