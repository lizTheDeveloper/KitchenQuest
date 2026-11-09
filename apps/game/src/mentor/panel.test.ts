import { expect, test } from 'vitest';
import type { MentorBackend } from './backend';
import { createDialogue } from './dialogue';
import { mountMentorPanel } from './panel';

test('family table refuses a non-scripted backend before touching the DOM', () => {
  const root = new Proxy({}, { get() { throw new Error('touched'); } }) as unknown as HTMLElement;
  const backend: MentorBackend = { kind: 'ai', reply: async () => ({ trigger: 'x', text: 'x', ai: 'allowed' }) };
  const dialogue = createDialogue({ triggers: {} });
  expect(() => mountMentorPanel(root, { mode: 'familyTable', backend, dialogue, reducedMotion: () => true }))
    .toThrow('Family Table mode requires the scripted backend');
});
