// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildProfileCard, type TurnRequest } from '@kitchenquest/core/engine';
import { createApiClient, type ApiClient } from '../api/client';
import type { ConsentPurpose } from '../api/types';
import { content } from '../content';
import { createStore, type PlayerState, type PlayerStore } from '../state/store';
import type { MentorPanel } from './panel';

const S23 = 'hi im mia im 8 and my mum let me use it. my favourite food is pasta and im allergic to eggs. can you remember that';
const EMERGENCY = 'my throat is closing';
const MEDICAL = 'should I take antibiotics for my rash';
const lines = (trigger: string) => content.pan.triggers[trigger].lines;
// Fix round 1, I2 (Task 5 ruling 3): no wall-clock waits. Every wait is for a state ("the reply is shown", "the turn
// is out", "nothing is pending"), and a held server reply lands only when the test releases it, so an ordering the
// test states can't be raced by a slow machine.
/** One macrotask: lets submitted events and resolved promises run. Not a timing wait. */
const tick = () => new Promise<void>((r) => { setTimeout(r, 0); });
/** Waits for a condition (an assertion that passes), however long the machine takes. */
const until = (check: () => void) => vi.waitFor(check, { timeout: 15_000, interval: 2 });

type Reply = { ok: true; status: 200; data: { conversationId: string; parts: []; cards: unknown[]; actions: []; route: 'deterministic'; notice: null } };
/**
 * A server that answers every turn at once, or, while `hold` is on, only when the test calls `release()`. A turn
 * with no conversation id opens a new one (c1, c2, …), as the server does. Every reply is empty: if one were shown,
 * the panel would say didnt_understand.
 */
function harness(opts: { granted?: ConsentPurpose[]; hold?: boolean } = {}) {
  const { granted = ['health_data', 'ai_health'] } = opts;
  const turns: TurnRequest[] = [];
  const names: string[] = [];
  const held: (() => void)[] = [];
  const outstanding: Promise<unknown>[] = [];
  let opened = 0;
  const state = { hold: opts.hold ?? false };
  const client = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => {
      names.push(name);
      if (name === 'mentorTurn') {
        const req = args[0] as TurnRequest;
        turns.push(req);
        const conversationId = req.conversationId ?? `c${++opened}`;
        const data: Reply = { ok: true, status: 200, data: { conversationId, parts: [], cards: [], actions: [], route: 'deterministic', notice: null } };
        const p = new Promise<Reply>((res) => { if (state.hold) held.push(() => { res(data); }); else res(data); });
        outstanding.push(p);
        return p;
      }
      if (name === 'consents') {
        return Promise.resolve({ ok: true, status: 200, data: { consents: granted.map((purpose) => ({ purpose, withdrawnAt: null, current: true })), needsReconsent: [], notices: {} } });
      }
      return Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } });
    },
  }) as ApiClient;
  /** Answers every held turn, and any that the answers send in turn, until none is outstanding and the panel is idle. */
  const drain = async () => {
    for (let round = 0; round < 50; round++) {
      state.hold = false;
      for (const go of held.splice(0)) go();
      await Promise.all(outstanding);
      await tick();
      if (held.length === 0 && !busy()) return;
    }
    throw new Error('the harness never settled');
  };
  return {
    client, turns, names, state, held, drain,
    texts: () => turns.map((t) => t.input.text), ids: () => turns.map((t) => t.conversationId),
    /** Answers the oldest held turn. */
    release: async () => { held.shift()?.(); await Promise.all(outstanding); await tick(); },
  };
}

let store: PlayerStore;
async function mount(client: ApiClient, step: PlayerState['intake']['step'] = 'done', aiMentor = true): Promise<MentorPanel> {
  // index.ts mounts one panel per page: a fresh module for each test (its transforms are warm: see the top of the file).
  vi.resetModules();
  const { mountMentor } = await import('./index');
  store = createStore(null);
  store.update((s) => ({ ...s, account: { email: 'cook@example.com' }, accountRules: [], intake: { ...s.intake, step }, settings: { ...s.settings, aiMentor, reducedMotion: 'on' } }));
  const pan = mountMentor(document, store, content.pan, client);
  pan.open();
  await tick();
  return pan;
}
const busy = () => document.querySelector('.bubbles')?.getAttribute('aria-busy') === 'true';
/** Type a message and press Send; returns as soon as the panel has taken it (a held turn may still be out). */
async function type(text: string) {
  document.querySelector<HTMLTextAreaElement>('#pan-text')!.value = text;
  document.querySelector('form')!.requestSubmit();
  await tick();
}
/** Type a message, send it, and wait until its answer is shown and nothing is pending. */
async function send(text: string) {
  await type(text);
  await until(() => { expect(busy()).toBe(false); });
}
const said = () => [...document.querySelectorAll('.bubble.pan .bubble-text')].map((b) => b.textContent ?? '');
/** The intake's first question is on screen. */
const intakeAsked = () => until(() => { expect(said().length).toBeGreaterThan(0); });
/** The first turn loads the AI code and is answered; the safety turns that follow can then be delivered through it. */
const loadAi = async (h: { turns: unknown[] }) => {
  await send('hello');
  await until(() => { expect(h.turns.length).toBeGreaterThan(0); });
};

// The modules a test's first turn imports, loaded once here so each test's fresh `./index` finds them transformed.
await import('./ai-backend');
await import('./week-turn');

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { vi.restoreAllMocks(); });

test('a child turn is answered on the device and the conversation stays on the grown-up line; with the AI code not loaded yet nothing is sent', async () => {
  const h = harness();
  await mount(h.client);
  await send(S23);
  await send("I'm allergic to eggs");
  for (const line of said().slice(-2)) expect(lines('child.grownup')).toContain(line);
  // Not the AI backend's path: it would have asked for the consents first and shown a card or another line.
  expect(h.names).not.toContain('consents');
  expect(document.querySelector('.pan-card')).toBeNull();
  expect(h.turns).toEqual([]);
});

test('C-1: a child turn during Form 1-A sets the sticky child flag: the intake answers and free text that follow never reach the AI', async () => {
  const h = harness();
  await mount(h.client, 'market_day');
  await intakeAsked();
  await send('hello'); // an unparsed market-day answer: goes to the AI backend (and loads its code); answered
  expect(h.texts()).toEqual(['hello']);
  await send('hi im mia im 8 my mum lets me use it');
  await send('idk whenever we want'); // unparsed: the intake would ask the AI
  await send('what should I cook tonight');
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
    await intakeAsked();
    await send(CHILD);
    await send('saturday');
    expect(grownup(said().at(-1))).toBe(true);
    expect(cardsShown()).toBe(0);
    expect(store.get().intake.step).toBe('market_day');
  });

  test('the reviewer probe: a child turn at allergies, then "eggs": the grown-up line, no rule card', async () => {
    const h = harness();
    await mount(h.client, 'allergies', ai);
    await intakeAsked();
    await send(CHILD);
    await send('eggs');
    await send('peanuts, severe');
    expect(said().slice(-3).every(grownup)).toBe(true);
    expect(cardsShown()).toBe(0);
  });

  test('a quick answer tapped after a child turn makes no card', async () => {
    const h = harness();
    await mount(h.client, 'market_day', ai);
    await intakeAsked();
    await send('whenever'); // unparsed: the Pan asks again with quick answers (or the AI answers nothing)
    await send(CHILD);
    const pick = [...document.querySelectorAll<HTMLButtonElement>('.pan-quick')].find((b) => b.textContent === 'Saturday' && !b.disabled);
    expect(pick).toBeDefined();
    pick!.click();
    await tick();
    await until(() => { expect(busy()).toBe(false); });
    expect(grownup(said().at(-1))).toBe(true);
    expect(cardsShown()).toBe(0);
  });

  test('outside the intake: after a child turn a meal, a market day, a pantry add and a rule all get the grown-up line and no card', async () => {
    const h = harness();
    await mount(h.client, 'done', ai);
    await send(CHILD);
    for (const t of ['I had porridge for breakfast', 'my market day is saturday', 'I bought eggs and milk', "I'm allergic to eggs", 'yes']) await send(t);
    expect(said().slice(-5).every(grownup)).toBe(true);
    expect(cardsShown()).toBe(0);
    expect(store.get().accountRules).toEqual([]);
  });

  test('an emergency after a child turn still gets the emergency line first, with no ask and no card', async () => {
    const h = harness();
    await mount(h.client, 'done', ai);
    await send(CHILD);
    await send("my throat is closing, I'm allergic to peanuts");
    expect(lines('rule.emergency')).toContain(said().at(-1));
    expect(cardsShown()).toBe(0);
    // And the conversation stays a child's.
    await send('my market day is saturday');
    expect(grownup(said().at(-1))).toBe(true);
  });

  test('an emergency during the intake after a child turn gets the emergency line', async () => {
    const h = harness();
    await mount(h.client, 'allergies', ai);
    await intakeAsked();
    await send(CHILD);
    await send("my throat is closing, I'm allergic to peanuts");
    expect(lines('rule.emergency')).toContain(said().at(-1));
    expect(cardsShown()).toBe(0);
  });
});

test('G1: without the consents an emergency and a medical question are answered on the device and never posted', async () => {
  const h = harness({ granted: [] });
  await mount(h.client);
  await loadAi(h);
  await send(EMERGENCY);
  await send(MEDICAL);
  expect(said().slice(-2)).toEqual([expect.toBeOneOf(lines('rule.emergency')), expect.toBeOneOf(lines('rule.medical_deflect'))]);
  expect(h.texts()).toEqual(['hello']);
});

test('G2: "im 8" is delivered, the grown-up answer to the next turn is never sent anywhere', async () => {
  const h = harness();
  await mount(h.client);
  await loadAi(h);
  await send('im 8');
  await send('what should I cook tonight');
  expect(said().slice(-2).every((l) => lines('child.grownup').includes(l))).toBe(true);
  expect(h.texts()).toEqual(['hello', 'im 8']);
  expect(h.ids()).toEqual([null, 'c1']);
});

test('G3: an emergency, a medical question and "hello" typed while the deliveries wait reach the server in order, in one conversation; the server replies are not shown', async () => {
  const h = harness();
  const pan = await mount(h.client);
  await loadAi(h);
  pan.clearConversation(); // so the emergency opens the conversation
  h.state.hold = true; // every delivery now waits for the test
  await type(EMERGENCY);
  await type(MEDICAL);
  await type('hello');
  await h.drain();
  expect(h.texts()).toEqual(['hello', EMERGENCY, MEDICAL, 'hello']);
  expect(h.ids()).toEqual([null, null, 'c2', 'c2']);
  // The emergency and medical lines only: the delivered turns' replies never reach the screen.
  const emergencyAt = said().findIndex((l) => lines('rule.emergency').includes(l));
  expect(said().slice(emergencyAt, emergencyAt + 2)).toEqual([expect.toBeOneOf(lines('rule.emergency')), expect.toBeOneOf(lines('rule.medical_deflect'))]);
  expect(said().filter((l) => lines('didnt_understand').includes(l))).toHaveLength(1); // the last "hello" reply (the clear removed the first), nothing more
});

test('G3: an emergency typed while a turn waits reaches the server after it, in the same conversation', async () => {
  const h = harness();
  await mount(h.client);
  await loadAi(h);
  h.state.hold = true;
  await type('what should I cook tonight');
  await until(() => { expect(h.held).toHaveLength(1); }); // the turn is out and waiting
  await type(EMERGENCY); // answered on the device; its delivery queues behind the waiting turn
  expect(h.texts()).toEqual(['hello', 'what should I cook tonight']);
  await h.drain();
  expect(h.texts()).toEqual(['hello', 'what should I cook tonight', EMERGENCY]);
  expect(h.ids()).toEqual([null, 'c1', 'c1']);
});

test('I-1: a plain "yes" with no recent server card on screen is answered on the device and never sent', async () => {
  const h = harness();
  await mount(h.client);
  await loadAi(h);
  h.state.hold = true;
  await type(EMERGENCY);
  await type('yes');
  await h.drain();
  expect(h.texts()).toEqual(['hello', EMERGENCY]);
});

test('G5: a delivery still waiting when the AI is turned off is never sent', async () => {
  const h = harness({ hold: true });
  await mount(h.client);
  await type('hello'); // loads the AI code, then waits at the server
  await until(() => { expect(h.held).toHaveLength(1); }); // the AI code is loaded and the turn is out
  await type(EMERGENCY); // answered on the device; its delivery queues behind "hello"
  store.update((s) => ({ ...s, settings: { ...s.settings, aiMentor: false } }));
  await h.drain();
  expect(h.texts()).toEqual(['hello']);
});

test('fix round 1 (I2): a server reply that lands after a child turn shows only its written line, and none of its cards', async () => {
  // A grown-up's turn is waiting at the server when a child speaks. The child gets the grown-up line at once; the late
  // reply to the earlier turn may show its written line (R9: never model text), but never a card a child could tap.
  const card = buildProfileCard({ marketDays: [6] });
  const held: (() => void)[] = [];
  const turns: string[] = [];
  const client = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => {
      if (name === 'mentorTurn') {
        turns.push((args[0] as TurnRequest).input.text);
        const data = { ok: true, status: 200, data: { conversationId: 'c1', parts: [], actions: [], route: 'ai', notice: null,
          cards: turns.length === 2 ? [{ proposalId: 'P1', expiresAt: '2099-01-01T00:00:00Z', card }] : [] } };
        return turns.length === 1 ? Promise.resolve(data) : new Promise((res) => { held.push(() => { res(data); }); });
      }
      if (name === 'consents') return Promise.resolve({ ok: true, status: 200, data: { consents: ['health_data', 'ai_health'].map((purpose) => ({ purpose, withdrawnAt: null, current: true })), needsReconsent: [], notices: {} } });
      return Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } });
    },
  }) as ApiClient;
  await mount(client);
  await send('hello');
  await type('my market day is saturday');
  await until(() => { expect(held).toHaveLength(1); });
  await type(CHILD);
  expect(grownup(said().at(-1))).toBe(true);
  for (const go of held.splice(0)) go();
  await until(() => { expect(busy()).toBe(false); });
  await tick();
  expect(cardsShown()).toBe(0);
  expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Ink it ✔')).toBe(false);
});

test('G4/G6: clearConversation starts a new server conversation (the AI backend shares the id) and forgets the child flag', async () => {
  const h = harness();
  const pan = await mount(h.client);
  await loadAi(h);
  await send('hello');
  await send('im 8');
  pan.clearConversation();
  await send('what should I cook tonight');
  expect(h.texts()).toEqual(['hello', 'hello', 'im 8', 'what should I cook tonight']);
  expect(h.ids()).toEqual([null, 'c1', 'c1', null]);
  expect(lines('child.grownup')).not.toContain(said().at(-1));
});

/**
 * The real API client over a fake fetch: turns whose text `hangs` names never answer until the test calls `expire()`,
 * which fires that request's own client timeout. `AbortSignal.timeout` is the client's timer: here each call gets a
 * signal the test controls (fix round 1, I2), so "the timeout fires" happens when the test says, not after 300 ms.
 */
function realClient(hangs: (text: string) => boolean) {
  const sent: string[] = [];
  const timers = new Map<AbortSignal, AbortController>();
  const hung: AbortSignal[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const c = new AbortController();
    timers.set(c.signal, c);
    return c.signal;
  });
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  const fetchFn = ((url: string, init: RequestInit) => {
    if (url.endsWith('/mentor/turn')) {
      const text = (JSON.parse(init.body as string) as TurnRequest).input.text;
      sent.push(text);
      if (hangs(text)) {
        if (init.signal) hung.push(init.signal);
        return new Promise<Response>((_r, reject) => { init.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }); });
      }
      return json({ conversationId: 'c1', parts: [], cards: [], actions: [], route: 'deterministic', notice: null });
    }
    if (url.endsWith('/me/consents')) {
      return json({ consents: ['health_data', 'ai_health'].map((purpose) => ({ purpose, withdrawnAt: null, current: true })), needsReconsent: [], notices: {} });
    }
    return Promise.reject(new Error('offline'));
  }) as unknown as typeof fetch;
  return {
    client: createApiClient({ fetch: fetchFn, timeoutMs: 300 }),
    sent,
    turns: sent,
    /** The client timeout fires for every hung delivery. */
    expire: async () => {
      for (const sig of hung.splice(0)) timers.get(sig)?.abort(new DOMException('timed out', 'TimeoutError'));
      await tick();
    },
  };
}

test('H1: a hung delivery never holds up a second emergency; the client timeout settles the queue and the waiting turn is answered', async () => {
  const r = realClient((t) => t === EMERGENCY);
  await mount(r.client);
  await loadAi(r);
  await type(EMERGENCY); // its delivery hangs
  await until(() => { expect(r.sent).toEqual(['hello', EMERGENCY]); });
  await type('what should I cook tonight'); // waits behind it
  expect(busy()).toBe(true);
  await type("he's not breathing");
  expect(lines('rule.emergency')).toContain(said().at(-1));
  expect(r.sent).toEqual(['hello', EMERGENCY]);
  // The delivery times out (status 0): the queue moves on, the waiting turn goes out and is answered.
  await r.expire();
  await until(() => { expect(r.sent).toEqual(['hello', EMERGENCY, 'what should I cook tonight', "he's not breathing"]); });
  await until(() => { expect(busy()).toBe(false); });
});

test('H1: turning the AI off while a delivery hangs answers the waiting turn from the script at once; the panel works again', async () => {
  const r = realClient((t) => t === EMERGENCY);
  await mount(r.client);
  await loadAi(r);
  await type(EMERGENCY);
  await until(() => { expect(r.sent).toEqual(['hello', EMERGENCY]); });
  await type('what should I cook tonight');
  expect(busy()).toBe(true);
  store.update((s) => ({ ...s, settings: { ...s.settings, aiMentor: false } }));
  await until(() => { expect(busy()).toBe(false); });
  await send('thank you');
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
  await send('My market day is Saturday.');
  await until(() => { expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Ink it ✔')).toBe(true); });
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Ink it ✔')!.click();
  await until(() => { expect(confirms).toEqual([['P1', undefined, 'c1', undefined]]); });
});
