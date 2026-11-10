// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import type { MentorBackend } from './backend';
import { createDialogue } from './dialogue';
import { MAX_BUBBLES, mountMentorPanel } from './panel';
import type { PanReply, TurnContext } from './reply';

const reply = (texts: string[]): PanReply => ({
  items: texts.map((t) => ({ kind: 'said', said: { trigger: 'x', text: t, ai: 'allowed' } })), cards: [], intents: [], actions: [], notice: null,
});

test('family table refuses a non-scripted backend before touching the DOM', () => {
  const root = new Proxy({}, { get() { throw new Error('touched'); } }) as unknown as HTMLElement;
  const backend: MentorBackend = { kind: 'ai', reply: () => Promise.resolve(reply(['x'])) };
  const dialogue = createDialogue({ triggers: {} });
  expect(() => mountMentorPanel(root, { mode: 'familyTable', backend, dialogue, reducedMotion: () => true, signedIn: () => false }))
    .toThrow('Family Table mode requires the scripted backend');
});

test('the panel keeps only the last 50 bubbles', () => {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const backend: MentorBackend = { kind: 'scripted', reply: () => Promise.resolve(reply(['x'])) };
  const dialogue = createDialogue({ triggers: { hi: { lines: ['Hello {n}'] } } } as never);
  const pan = mountMentorPanel(root, { mode: 'familyTable', backend, dialogue, reducedMotion: () => true, signedIn: () => false });
  expect(MAX_BUBBLES).toBe(50);
  for (let i = 0; i < 60; i++) pan.say('hi', { n: String(i) });
  const bubbles = root.querySelectorAll('.bubble');
  expect(bubbles.length).toBe(50);
  expect(bubbles[0].textContent).toBe('Hello 10');
  expect(bubbles[49].textContent).toBe('Hello 59');
});

test('a sent message gets the turn context and every said item as a bubble; cards and other items are not shown yet', async () => {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const seen: TurnContext[] = [];
  let signed = false;
  const backend: MentorBackend = {
    kind: 'scripted',
    reply: (_input, ctx) => {
      seen.push(ctx);
      const r = reply(['one', 'two']);
      r.items.push({ kind: 'consent', purpose: 'health_data' }, { kind: 'choices', options: [{ id: 'a', name: 'A' }], severity: null });
      return Promise.resolve(r);
    },
  };
  mountMentorPanel(root, { mode: 'standard', backend, dialogue: createDialogue({ triggers: {} }), reducedMotion: () => true, signedIn: () => signed });
  const send = (text: string) => {
    root.querySelector<HTMLTextAreaElement>('#pan-text')!.value = text;
    root.querySelector('form')!.requestSubmit();
  };
  send('hello');
  await new Promise((r) => setTimeout(r, 0));
  signed = true;
  send('again');
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toEqual([
    { turn: 1, openCards: [], intakeStep: null, signedIn: false },
    { turn: 2, openCards: [], intakeStep: null, signedIn: true },
  ]);
  expect([...root.querySelectorAll('.bubble.pan')].map((b) => b.textContent)).toEqual(['one', 'two', 'one', 'two']);
  expect(root.querySelectorAll('.bubble').length).toBe(6);
});
