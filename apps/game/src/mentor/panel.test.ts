// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import type { MentorBackend } from './backend';
import { createDialogue } from './dialogue';
import { MAX_BUBBLES, mountMentorPanel } from './panel';

test('family table refuses a non-scripted backend before touching the DOM', () => {
  const root = new Proxy({}, { get() { throw new Error('touched'); } }) as unknown as HTMLElement;
  const backend: MentorBackend = { kind: 'ai', reply: async () => ({ trigger: 'x', text: 'x', ai: 'allowed' }) };
  const dialogue = createDialogue({ triggers: {} });
  expect(() => mountMentorPanel(root, { mode: 'familyTable', backend, dialogue, reducedMotion: () => true }))
    .toThrow('Family Table mode requires the scripted backend');
});

test('the panel keeps only the last 50 bubbles', () => {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const backend: MentorBackend = { kind: 'scripted', reply: async () => ({ trigger: 'x', text: 'x', ai: 'scripted' }) } as unknown as MentorBackend;
  const dialogue = createDialogue({ triggers: { hi: { lines: ['Hello {n}'] } } } as never);
  const pan = mountMentorPanel(root, { mode: 'familyTable', backend, dialogue, reducedMotion: () => true });
  expect(MAX_BUBBLES).toBe(50);
  for (let i = 0; i < 60; i++) pan.say('hi', { n: String(i) });
  const bubbles = root.querySelectorAll('.bubble');
  expect(bubbles.length).toBe(50);
  expect(bubbles[0].textContent).toBe('Hello 10');
  expect(bubbles[49].textContent).toBe('Hello 59');
});
