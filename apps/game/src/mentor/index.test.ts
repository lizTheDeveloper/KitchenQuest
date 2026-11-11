import { describe, expect, test } from 'vitest';
import { createStore } from '../state/store';
import { createDialogue } from './dialogue';
import { backendKind, historyOptions, screenOf, switchingBackend } from './index';
import type { PanReply } from './reply';

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

describe('backend choice (M4 Step 10)', () => {
  test('Family Table → scripted; signed in with the AI mentor on → AI; otherwise scripted', () => {
    const s = createStore(null).get();
    expect(backendKind(s)).toBe('scripted');
    const signed = { ...s, account: { email: 'a@b.c' } };
    expect(backendKind(signed)).toBe('ai');
    expect(backendKind({ ...signed, settings: { ...s.settings, aiMentor: false } })).toBe('scripted');
    expect(backendKind({ ...signed, settings: { ...s.settings, familyTable: true } })).toBe('scripted');
  });

  test('the backend is rebuilt when the account or the AI setting changes, and late replies come from the current one', () => {
    const store = createStore(null);
    const built: { kind: 'scripted' | 'ai'; late?: (r: PanReply) => void }[] = [];
    const backend = switchingBackend(store, (kind) => {
      const b: { kind: 'scripted' | 'ai'; late?: (r: PanReply) => void } = { kind };
      built.push(b);
      return { kind, reply: () => Promise.reject(new Error('unused')), onLate: (fn) => { b.late = fn; return () => {}; } };
    });
    const seen: PanReply[] = [];
    backend.onLate?.((r) => seen.push(r));
    expect(backend.kind).toBe('scripted');
    store.update((s) => ({ ...s, account: { email: 'a@b.c' } }));
    expect(backend.kind).toBe('ai');
    store.update((s) => ({ ...s, dialogueHistory: { x: [1] } }));
    expect(built).toHaveLength(2);
    store.update((s) => ({ ...s, settings: { ...s.settings, aiMentor: false } }));
    expect(backend.kind).toBe('scripted');
    expect(built.map((b) => b.kind)).toEqual(['scripted', 'ai', 'scripted']);
    const r: PanReply = { items: [], cards: [], intents: [], actions: [], notice: null };
    built[1].late!(r); // an old backend's late reply is not shown
    built[2].late!(r);
    expect(seen).toEqual([r]);
  });

  test('the screen sent with a turn is the route, with the slug on a dish', () => {
    expect(screenOf('#/recipe/india/kerala/parippu')).toEqual({ route: 'recipe', slug: 'india/kerala/parippu' });
    expect(screenOf('#/settings')).toEqual({ route: 'settings' });
    expect(screenOf('#/nowhere')).toBeNull();
  });
});

test('N4: after a sign-out, the next Pan line leaves no earlier line history in localStorage', () => {
  const m = new Map<string, string>();
  const storage = {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => { m.delete(k); }, setItem: (k: string, v: string) => { m.set(k, v); },
  } as Storage;
  const store = createStore(storage);
  store.update((s) => ({ ...s, account: { email: 'cook@example.test' } }));
  const dialogue = createDialogue(bank, historyOptions(store)); // mounted once, for the page's life
  dialogue.say('g');
  dialogue.say('g');
  // Sign-out: the account leaves, and its session's history is cleared from the store (progress/index.ts).
  store.update((s) => ({ ...s, account: null, dialogueHistory: {} }));
  dialogue.say('g');
  const saved = (JSON.parse(storage.getItem('kq.player.v1')!) as { dialogueHistory: Record<string, number[]> }).dialogueHistory;
  expect(saved).toEqual({ g: [expect.any(Number)] });
  // And a new account starts fresh too.
  store.update((s) => ({ ...s, account: { email: 'other@example.test' } }));
  dialogue.say('g');
  expect((JSON.parse(storage.getItem('kq.player.v1')!) as { dialogueHistory: Record<string, number[]> }).dialogueHistory.g).toHaveLength(1);
});
