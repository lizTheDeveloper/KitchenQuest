// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { buildProfileCard, type TurnRequest } from '@kitchenquest/core/engine';
import { createApiClient, type ApiClient } from '../api/client';
import type { ConsentPurpose } from '../api/types';
import { content } from '../content';
import { createStore, type PlayerState, type PlayerStore } from '../state/store';
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
async function mount(client: ApiClient, step: PlayerState['intake']['step'] = 'done', aiMentor = true): Promise<MentorPanel> {
  // index.ts mounts one panel per page: a fresh module for each test.
  vi.resetModules();
  const { mountMentor } = await import('./index');
  store = createStore(null);
  store.update((s) => ({ ...s, account: { email: 'cook@example.com' }, accountRules: [], intake: { ...s.intake, step }, settings: { ...s.settings, aiMentor, reducedMotion: 'on' } }));
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

test('C-1: a child turn during Form 1-A sets the sticky child flag: the intake answers and free text that follow never reach the AI', async () => {
  const h = harness();
  await mount(h.client, 'market_day');
  await sleep(20); // the intake's first question
  await send('hello', 50); // an unparsed market-day answer: goes to the AI backend (and loads its code)
  expect(h.texts()).toEqual(['hello']);
  await send('hi im mia im 8 my mum lets me use it', 20);
  await send('idk whenever we want', 20); // unparsed: the intake would ask the AI
  await send('what should I cook tonight', 20);
  for (const line of said().slice(-3)) expect(lines('child.grownup')).toContain(line);
  // Only the child's own turn is delivered (its reply ignored); nothing after it is sent anywhere.
  expect(h.texts()).toEqual(['hello', 'hi im mia im 8 my mum lets me use it']);
});

const CHILD = 'hi im mia im 8 my mum lets me use it';
const cardsShown = () => document.querySelectorAll('.pan-card').length;
const grownup = (l: string | undefined) => l !== undefined && lines('child.grownup').includes(l);

describe.each([
  { ai: true, name: 'AI on' },
  { ai: false, name: 'AI off (scripted)' },
])('m-4: one child flag per conversation, $name', ({ ai }) => {
  test('the reviewer probe: a child turn at market_day, then "saturday": the grown-up line, no card', async () => {
    const h = harness();
    await mount(h.client, 'market_day', ai);
    await sleep(20); // the intake's first question
    await send(CHILD, 20);
    await send('saturday', 20);
    expect(grownup(said().at(-1))).toBe(true);
    expect(cardsShown()).toBe(0);
    expect(store.get().intake.step).toBe('market_day');
  });

  test('the reviewer probe: a child turn at allergies, then "eggs": the grown-up line, no rule card', async () => {
    const h = harness();
    await mount(h.client, 'allergies', ai);
    await sleep(20);
    await send(CHILD, 20);
    await send('eggs', 20);
    await send('peanuts, severe', 20);
    expect(said().slice(-3).every(grownup)).toBe(true);
    expect(cardsShown()).toBe(0);
  });

  test('a quick answer tapped after a child turn makes no card', async () => {
    const h = harness();
    await mount(h.client, 'market_day', ai);
    await sleep(20);
    await send('whenever', 50); // unparsed: the Pan asks again with quick answers (or the AI answers nothing)
    await send(CHILD, 20);
    const pick = [...document.querySelectorAll<HTMLButtonElement>('.pan-quick')].find((b) => b.textContent === 'Saturday' && !b.disabled);
    expect(pick).toBeDefined();
    pick!.click();
    await sleep(20);
    expect(grownup(said().at(-1))).toBe(true);
    expect(cardsShown()).toBe(0);
  });

  test('outside the intake: after a child turn a meal, a market day, a pantry add and a rule all get the grown-up line and no card', async () => {
    const h = harness();
    await mount(h.client, 'done', ai);
    await send(CHILD, 20);
    for (const t of ['I had porridge for breakfast', 'my market day is saturday', 'I bought eggs and milk', "I'm allergic to eggs", 'yes']) await send(t, 20);
    expect(said().slice(-5).every(grownup)).toBe(true);
    expect(cardsShown()).toBe(0);
    expect(store.get().accountRules).toEqual([]);
  });

  test('an emergency after a child turn still gets the emergency line first, with no ask and no card', async () => {
    const h = harness();
    await mount(h.client, 'done', ai);
    await send(CHILD, 20);
    await send("my throat is closing, I'm allergic to peanuts", 20);
    expect(lines('rule.emergency')).toContain(said().at(-1));
    expect(cardsShown()).toBe(0);
    // And the conversation stays a child's.
    await send('my market day is saturday', 20);
    expect(grownup(said().at(-1))).toBe(true);
  });

  test('an emergency during the intake after a child turn gets the emergency line', async () => {
    const h = harness();
    await mount(h.client, 'allergies', ai);
    await sleep(20);
    await send(CHILD, 20);
    await send("my throat is closing, I'm allergic to peanuts", 20);
    expect(lines('rule.emergency')).toContain(said().at(-1));
    expect(cardsShown()).toBe(0);
  });
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

test('G3: an emergency typed while a turn waits reaches the server after it, in the same conversation', async () => {
  const h = harness({ delay: 40 });
  await mount(h.client);
  await loadAi();
  await send('what should I cook tonight', 0);
  await send(EMERGENCY, 200);
  expect(h.texts()).toEqual(['hello', 'what should I cook tonight', EMERGENCY]);
  expect(h.ids()).toEqual([null, 'c1', 'c1']);
});

test('I-1: a plain "yes" with no recent server card on screen is answered on the device and never sent', async () => {
  const h = harness({ delay: 40 });
  await mount(h.client);
  await loadAi();
  await send(EMERGENCY);
  await send('yes', 200);
  expect(h.texts()).toEqual(['hello', EMERGENCY]);
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

/** The real API client over a fake fetch: turns whose text `hangs` names never answer (until the client's own timeout). */
function realClient(hangs: (text: string) => boolean, timeoutMs: number) {
  const sent: string[] = [];
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  const fetchFn = ((url: string, init: RequestInit) => {
    if (url.endsWith('/mentor/turn')) {
      const text = (JSON.parse(init.body as string) as TurnRequest).input.text;
      sent.push(text);
      if (hangs(text)) return new Promise<Response>((_r, reject) => { init.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }); });
      return json({ conversationId: 'c1', parts: [], cards: [], actions: [], route: 'deterministic', notice: null });
    }
    if (url.endsWith('/me/consents')) {
      return json({ consents: ['health_data', 'ai_health'].map((purpose) => ({ purpose, withdrawnAt: null, current: true })), needsReconsent: [], notices: {} });
    }
    return Promise.reject(new Error('offline'));
  }) as unknown as typeof fetch;
  return { client: createApiClient({ fetch: fetchFn, timeoutMs }), sent };
}
const busy = () => document.querySelector('.bubbles')!.getAttribute('aria-busy') === 'true';

test('H1: a hung delivery never holds up a second emergency; the client timeout settles the queue and the waiting turn is answered', async () => {
  const r = realClient((t) => t === EMERGENCY, 300);
  await mount(r.client);
  await loadAi();
  await send(EMERGENCY, 20); // its delivery hangs
  await send('what should I cook tonight', 20); // waits behind it
  expect(busy()).toBe(true);
  await send("he's not breathing", 5);
  expect(lines('rule.emergency')).toContain(said().at(-1));
  expect(r.sent).toEqual(['hello', EMERGENCY]);
  // The delivery times out (status 0): the queue moves on, the waiting turn goes out and is answered.
  await sleep(450);
  expect(r.sent).toEqual(['hello', EMERGENCY, 'what should I cook tonight', "he's not breathing"]);
  expect(busy()).toBe(false);
});

test('H1: turning the AI off while a delivery hangs answers the waiting turn from the script at once; the panel works again', async () => {
  const r = realClient((t) => t === EMERGENCY, 60_000);
  await mount(r.client);
  await loadAi();
  await send(EMERGENCY, 20);
  await send('what should I cook tonight', 20);
  expect(busy()).toBe(true);
  store.update((s) => ({ ...s, settings: { ...s.settings, aiMentor: false } }));
  await sleep(20);
  expect(busy()).toBe(false);
  await send('thank you', 20);
  expect(busy()).toBe(false);
  expect(r.sent).toEqual(['hello', EMERGENCY]);
});

test('H2: a server card tap names the conversation the panel is in (index.ts gives the writer the shared id)', async () => {
  const confirms: unknown[][] = [];
  const card = buildProfileCard({ marketDays: [6] });
  const client = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => {
      if (name === 'mentorTurn') {
        return Promise.resolve({ ok: true, status: 200, data: {
          conversationId: 'c1', parts: [], actions: [], route: 'ai', notice: null,
          cards: [{ proposalId: 'P1', expiresAt: '2099-01-01T00:00:00Z', card }],
        } });
      }
      if (name === 'confirmProposal') confirms.push(args);
      return Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } });
    },
  }) as ApiClient;
  await mount(client);
  await send('My market day is Saturday.', 50);
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Ink it ✔')!.click();
  await sleep(10);
  expect(confirms).toEqual([['P1', undefined, 'c1', undefined]]);
});
