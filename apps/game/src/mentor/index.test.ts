import { expect, test } from 'vitest';
import { createStore } from '../state/store';
import { createDialogue } from './dialogue';
import { historyOptions } from './index';

const bank = { triggers: { g: { ai: 'never' as const, lines: ['A', 'B', 'C'] } } };

test('standard mode keeps line history in the player store', () => {
  const store = createStore(null);
  createDialogue(bank, historyOptions(store)).say('g');
  expect(store.get().dialogueHistory.g).toHaveLength(1);
});

test('Family Table mode persists no dialogue history', () => {
  const store = createStore(null);
  store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
  const before = store.get();
  const opts = historyOptions(store);
  expect(opts.onHistory).toBeUndefined();
  const d = createDialogue(bank, opts);
  for (let i = 0; i < 3; i++) d.say('g');
  expect(store.get()).toBe(before); // no update at all
  expect(store.get().dialogueHistory).toEqual({});
});
