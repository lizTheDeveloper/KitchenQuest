// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import type { TurnRequest } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { ConsentPurpose } from '../api/types';
import { content } from '../content';
import { createStore, type PlayerStore } from '../state/store';
import type { MentorPanel } from './panel';

const S23 = 'hi im mia im 8 and my mum let me use it. my favourite food is pasta and im allergic to eggs. can you remember that';
const EMERGENCY = 'my throat is closing';
const MEDICAL = 'should I take antibiotics for my rash';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines = (trigger: string) => content.pan.triggers[trigger].lines;

/**
 * A server that answers every turn after `delay` ms. A turn with no conversation id opens a new one (c1, c2, …), as
 * the server does. Every reply is empty: if one were shown, the panel would say didnt_understand.
 */
function harness(opts: { granted?: ConsentPurpose[]; delay?: number } = {}) {
  const { granted = ['health_data', 'ai_health'], delay = 0 } = opts;
  const turns: TurnRequest[] = [];
  const names: string[] = [];
  let opened = 0;
  const client = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => {
      names.push(name);
      if (name === 'mentorTurn') {
        const req = args[0] as TurnRequest;
        turns.push(req);
        const conversationId = req.conversationId ?? `c${++opened}`;
        return sleep(delay).then(() => ({ ok: true, status: 200, data: { conversationId, parts: [], cards: [], actions: [], route: 'deterministic', notice: null } }));
      }
      if (name === 'consents') {
        return Promise.resolve({ ok: true, status: 200, data: { consents: granted.map((purpose) => ({ purpose, withdrawnAt: null, current: true })), needsReconsent: [], notices: {} } });
      }
      return Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } });
    },
  }) as ApiClient;
  return { client, turns, names, texts: () => turns.map((t) => t.input.text), ids: () => turns.map((t) => t.conversationId) };
}

let store: PlayerStore;
async function mount(client: ApiClient): Promise<MentorPanel> {
  // index.ts mounts one panel per page: a fresh module for each test.
  vi.resetModules();
  const { mountMentor } = await import('./index');
  store = createStore(null);
  store.update((s) => ({ ...s, account: { email: 'cook@example.com' }, accountRules: [], intake: { ...s.intake, step: 'done' }, settings: { ...s.settings, aiMentor: true, reducedMotion: 'on' } }));
  const pan = mountMentor(document, store, content.pan, client);
  pan.open();
  return pan;
}
/** Type a message and send it; `wait` ms later the next one can be typed. */
async function send(text: string, wait = 5) {
  document.querySelector<HTMLTextAreaElement>('#pan-text')!.value = text;
  document.querySelector('form')!.requestSubmit();
  await sleep(wait);
}
const said = () => [...document.querySelectorAll('.bubble.pan .bubble-text')].map((b) => b.textContent ?? '');
/** The first turn loads the AI code; the safety turns that follow can then be delivered through it. */
const loadAi = () => send('hello', 50);

beforeEach(() => { document.body.innerHTML = ''; });

test('a child turn is answered on the device and the conversation stays on the grown-up line; with the AI code not loaded yet nothing is sent', async () => {
  const h = harness();
  await mount(h.client);
  await send(S23, 20);
  await send("I'm allergic to eggs", 20);
  for (const line of said().slice(-2)) expect(lines('child.grownup')).toContain(line);
  // Not the AI backend's path: it would have asked for the consents first and shown a card or another line.
  expect(h.names).not.toContain('consents');
  expect(document.querySelector('.pan-card')).toBeNull();
  expect(h.turns).toEqual([]);
});

test('G1: without the consents an emergency and a medical question are answered on the device and never posted', async () => {
  const h = harness({ granted: [] });
  await mount(h.client);
  await loadAi();
  await send(EMERGENCY, 20);
  await send(MEDICAL, 20);
  expect(said().slice(-2)).toEqual([expect.toBeOneOf(lines('rule.emergency')), expect.toBeOneOf(lines('rule.medical_deflect'))]);
  expect(h.texts()).toEqual(['hello']);
});

test('G2: "im 8" is delivered, the grown-up answer to the next turn is never sent anywhere', async () => {
  const h = harness();
  await mount(h.client);
  await loadAi();
  await send('im 8', 20);
  await send('what should I cook tonight', 20);
  expect(said().slice(-2).every((l) => lines('child.grownup').includes(l))).toBe(true);
  expect(h.texts()).toEqual(['hello', 'im 8']);
  expect(h.ids()).toEqual([null, 'c1']);
});

test('G3: an emergency, a medical question and "hello" typed 5 ms apart reach the server in order, in one conversation; the server replies are not shown', async () => {
  const h = harness({ delay: 40 });
  const pan = await mount(h.client);
  await loadAi();
  pan.clearConversation(); // so the emergency opens the conversation
  await send(EMERGENCY);
  await send(MEDICAL);
  await send('hello', 200);
  expect(h.texts()).toEqual(['hello', EMERGENCY, MEDICAL, 'hello']);
  expect(h.ids()).toEqual([null, null, 'c2', 'c2']);
  // The emergency and medical lines only: the delivered turns' replies never reach the screen.
  const emergencyAt = said().findIndex((l) => lines('rule.emergency').includes(l));
  expect(said().slice(emergencyAt, emergencyAt + 2)).toEqual([expect.toBeOneOf(lines('rule.emergency')), expect.toBeOneOf(lines('rule.medical_deflect'))]);
  expect(said().filter((l) => lines('didnt_understand').includes(l))).toHaveLength(1); // the last "hello" reply (the clear removed the first), nothing more
});

test('G3: a "yes" typed just after an emergency reaches the server after the emergency', async () => {
  const h = harness({ delay: 40 });
  await mount(h.client);
  await loadAi();
  await send(EMERGENCY);
  await send('yes', 200);
  expect(h.texts()).toEqual(['hello', EMERGENCY, 'yes']);
  expect(h.ids()).toEqual([null, 'c1', 'c1']);
});

test('G5: a delivery still waiting when the AI is turned off is never sent', async () => {
  const h = harness({ delay: 40 });
  await mount(h.client);
  await send('hello', 0); // in flight
  await sleep(10); // the AI code is loaded and the turn is out
  await send(EMERGENCY, 0); // queued behind it
  store.update((s) => ({ ...s, settings: { ...s.settings, aiMentor: false } }));
  await sleep(100);
  expect(h.texts()).toEqual(['hello']);
});

test('G4/G6: clearConversation starts a new server conversation (the AI backend shares the id) and forgets the child flag', async () => {
  const h = harness();
  const pan = await mount(h.client);
  await loadAi();
  await send('hello', 20);
  await send('im 8', 20);
  pan.clearConversation();
  await send('what should I cook tonight', 20);
  expect(h.texts()).toEqual(['hello', 'hello', 'im 8', 'what should I cook tonight']);
  expect(h.ids()).toEqual([null, 'c1', 'c1', null]);
  expect(lines('child.grownup')).not.toContain(said().at(-1));
});
