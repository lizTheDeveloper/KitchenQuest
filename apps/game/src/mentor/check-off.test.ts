// @vitest-environment happy-dom
// M6 Step 10 (Rulings 13, 14; C30, C31): the spoken check-off on the device. The scripted engine runs core's closed
// grammar after emergency and child and before health, exactly where the API does; a grammar card ticks at once with
// an Undo (no tap); a model card waits for its tap; without health_data nothing ticks; Family Table: no card, no tick.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildCheckOffCard, checkOffIntent, checkOffShaped, UNDO_WINDOW_MS, type CheckOffCard, type MarketRunView, type Plan } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { createStore, type PlayerState, type PlayerStore } from '../state/store';
import { createWeekStore } from '../week/local-week';
import { rememberRun } from '../week/run-memory';
import { createScriptedBackend } from './backend';
import { createDialogue } from './dialogue';
import { mountMentorPanel } from './panel';
import type { CardView, PanReply, TurnContext } from './reply';
import { createScriptedEngine } from './scripted';
import { createWeekTurn } from './week-turn';
import { createCardWriter } from './writer';

const NOW = new Date(2026, 10, 10, 12, 5); // Tuesday 10 November, local
const TODAY = '2026-11-10';
const MON = '2026-11-09';
const PARIPPU = 'india/kerala/parippu';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const recipes = Object.entries(content.recipes).map(([slug, r]) => ({ slug, title: r.meta.title }));
const plan = (): Plan => ({ weekStart: MON, items: [{ day: 0, kind: 'dish', slug: PARIPPU, servings: 3 }, { day: 2, kind: 'dish', slug: FRIJOLES, servings: 4 }], hard: false, slot: 'unanswered' });
const ctx = (patch: Partial<TurnContext> = {}): TurnContext => ({ turn: 1, openCards: [], intakeStep: null, signedIn: false, trail: [], ...patch });
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const noClient = new Proxy({}, { get: (_t, name: string) => () => Promise.reject(new Error(`unexpected call: ${name}`)) }) as ApiClient;

function device(patch: Partial<PlayerState> = {}): { store: PlayerStore; run: () => MarketRunView } {
  const store = createStore(null);
  store.update((s) => ({ ...s, ...patch }));
  const w = createWeekStore({ store });
  w.savePlan(plan());
  w.run(MON, TODAY);
  return { store, run: () => { const r = store.get().localWeek.runs[0]; return { id: r.id, weekStart: r.weekStart, items: r.items, doneAt: r.doneAt }; } };
}
function parts(store: PlayerStore, client: ApiClient = noClient) {
  const dialogue = createDialogue(content.pan);
  const turn = createWeekTurn({ store, client, now: () => NOW, dialogue, recipes, cooks: {} });
  const week = () => Promise.resolve(turn);
  const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes, now: () => NOW, week });
  const writer = createCardWriter({ client, store, dialogue, graph, ruleTerms: content.ruleTerms, now: () => NOW, week });
  return { dialogue, engine, writer, week };
}
const checkOff = (r: PanReply) => r.cards.find((c) => c.card.kind === 'check_off')?.card as CheckOffCard | undefined;
const said = (r: PanReply) => r.items.flatMap((i) => (i.kind === 'said' ? [i.said.trigger] : []));
const row = (run: MarketRunView, key: string) => run.items.find((i) => i.key === key)!;

function mountPanel(store: PlayerStore, client: ApiClient = noClient) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const p = parts(store, client);
  const pan = mountMentorPanel(root, {
    week: p.week, mode: store.get().settings.familyTable ? 'familyTable' : 'standard', backend: createScriptedBackend(p.engine, p.dialogue),
    dialogue: p.dialogue, writer: p.writer, engine: p.engine, client, forms: content.bureau.forms, store, reducedMotion: () => true, now: () => NOW,
  });
  const send = async (text: string) => {
    root.querySelector<HTMLTextAreaElement>('#pan-text')!.value = text;
    root.querySelector('form')!.requestSubmit();
    await flush();
  };
  return { root, pan, send };
}
const cardEl = (root: HTMLElement) => root.querySelector<HTMLElement>('.pan-checkoff-card');
const button = (el: Element | null, name: string) => [...(el?.querySelectorAll('button') ?? [])].find((b) => b.textContent === name);

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('scripted check-off: the safe side (C30)', () => {
  test.each([
    ['got the shallots', 'shallot', 'got'],
    ['picked up the onion', 'onion', 'got'],
    ['no shallots today', 'shallot', 'missing'],
  ] as const)('%s → a local grammar check_off card with a confirm intent (it ticks at once)', async (text, key, side) => {
    const d = device();
    const r = await parts(d.store).engine.reply(text, ctx());
    const card = checkOff(r)!;
    expect(card).toMatchObject({ kind: 'check_off', source: 'grammar', runId: d.run().id });
    expect(card[side]).toEqual([key]);
    expect(r.intents).toEqual([{ kind: 'confirm', localId: (r.cards[0] as { localId: string }).localId }]);
    expect(said(r)).toEqual(['market.checkoff_readback']);
    // The same message is the API's claim too (the same core function, with the rule terms as the 4th argument).
    expect(checkOffShaped(text, graph, content.ruleTerms)).toBe(true);
    expect(checkOffIntent(text, d.run(), graph, content.ruleTerms)).not.toBeNull();
  });

  test('the panel shows it already ticked, with an Undo and no tap; Undo unticks', async () => {
    const d = device();
    const m = mountPanel(d.store);
    await m.send('got the shallots');
    const el = cardEl(m.root)!;
    expect(el.dataset.state).toBe('applied');
    expect(button(el, 'Tick these')).toBeUndefined();
    expect(el.textContent).toContain('shallots');
    expect(el.textContent).toContain('(ticked)');
    expect(row(d.run(), 'shallot').ticked).toBe(true);
    expect(d.store.get().localPantry).toContainEqual(expect.objectContaining({ ingredientId: 'shallot', addedOn: TODAY, source: 'market' }));
    button(el, 'Undo')!.click();
    await flush();
    expect(row(d.run(), 'shallot').ticked).toBe(false);
    expect(d.store.get().localPantry.some((p) => p.ingredientId === 'shallot')).toBe(false);
    expect(cardEl(m.root)!.dataset.state).toBe('undone');
    expect(button(cardEl(m.root), 'Undo')).toBeUndefined();
  });

  test('a missing row\'s "Out of stock?" opens #/market at that row\'s stock control', async () => {
    const d = device();
    const m = mountPanel(d.store);
    await m.send('no shallots today');
    const el = cardEl(m.root)!;
    expect(row(d.run(), 'shallot').ticked).toBe(false); // missing rows are never ticked
    button(el, 'Out of stock?')!.click();
    expect(location.hash).toBe('#/market');
    const { takeStockAsk } = await import('../week/stock-ask');
    expect(takeStockAsk()).toBe('shallot');
  });

  test('Family Table → no card, no tick', async () => {
    const d = device();
    d.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    const r = await parts(d.store).engine.reply('got the shallots', ctx());
    expect(checkOff(r)).toBeUndefined();
    expect(row(d.run(), 'shallot').ticked).toBe(false);
    const m = mountPanel(d.store);
    m.pan.show({ items: [], cards: [], intents: [], actions: [], notice: null });
    expect(cardEl(m.root)).toBeNull();
    // Signed in, with the account's run already read: still nothing (the guard, not only the refused open).
    const acct = createStore(null);
    acct.update((s) => ({ ...s, account: { email: 'ft@example.com' }, accountRules: [], settings: { ...s.settings, familyTable: true } }));
    rememberRun(d.run(), 'ft@example.com');
    expect(checkOff(await parts(acct).engine.reply('got the shallots', ctx({ signedIn: true })))).toBeUndefined();
  });
});

describe('scripted check-off: the health side (Ruling 13, C30)', () => {
  test.each([
    'no fennel',
    "got the shallots, I'm allergic",
    "got the dal, I'm vegan",
    'got the onion, it made me ill',
  ])('%s → the health path ask, no card, no tick; not claimed by the grammar on the API either', async (text) => {
    const d = device();
    const r = await parts(d.store).engine.reply(text, ctx());
    expect(checkOff(r)).toBeUndefined();
    expect(r.intents).toEqual([]);
    expect(said(r).some((t) => t.startsWith('rule.'))).toBe(true);
    expect(d.run().items.every((i) => !i.ticked)).toBe(true);
    expect(checkOffIntent(text, d.run(), graph, content.ruleTerms)).toBeNull();
  });

  test('the client gates on checkOffShaped as the server does (Step 8 N1): "got the peanut butter" for a row the graph can\'t name', async () => {
    const store = createStore(null);
    store.update((s) => ({ ...s, account: { email: 'pb@example.com' }, accountRules: [] }));
    const run: MarketRunView = { id: 'run-pb', weekStart: MON, doneAt: null, items: [{ key: 'name:peanut butter', name: 'peanut butter', ingredientId: null, stall: 'general', forDishes: [PARIPPU], ticked: false }] };
    rememberRun(run, 'pb@example.com');
    // Core's checkOffIntent alone would claim it; the shape check (check-off.ts:113) sends it to health.
    expect(checkOffIntent('got the peanut butter', run, graph, content.ruleTerms)).not.toBeNull();
    const r = await parts(store).engine.reply('got the peanut butter', ctx({ signedIn: true }));
    expect(checkOff(r)).toBeUndefined();
    expect(r.intents).toEqual([]);
  });

  test('never while a rule card is open, or on an allergies intake answer', async () => {
    const d = device();
    const e = parts(d.store).engine;
    expect(checkOff(await e.reply('got the shallots', ctx({ intakeStep: 'allergies' })))).toBeUndefined();
    const ruleCard = (await e.reply("I'm allergic to sesame", ctx())).cards[0];
    expect(checkOff(await e.reply('got the shallots', ctx({ openCards: [ruleCard] })))).toBeUndefined();
  });
});

describe('a model-proposed card and consent (C31)', () => {
  const serverCard = (run: MarketRunView, source: 'grammar' | 'model'): CardView => ({
    origin: 'server', proposalId: 'P1', expiresAt: new Date(NOW.getTime() + UNDO_WINDOW_MS).toISOString(), card: buildCheckOffCard(run, ['shallot'], ['moong_dal'], source)!, issuedTurn: 1,
  });

  test('a model-proposed check_off card renders pending with "Tick these" / "Not now"; nothing ticks before the tap', async () => {
    const d = device();
    const confirmProposal = vi.fn(() => Promise.resolve({ ok: true, status: 200, data: { trail: { id: 'P1', origin: 'server', kind: 'check_off', summary: 's', undoUntil: new Date(NOW.getTime() + UNDO_WINDOW_MS).toISOString() }, parts: [] } }));
    const client = { confirmProposal } as unknown as ApiClient;
    const m = mountPanel(d.store, client);
    m.pan.show({ items: [], cards: [serverCard(d.run(), 'model')], intents: [], actions: [], notice: null });
    await flush();
    const el = cardEl(m.root)!;
    expect(el.dataset.state).toBe('pending');
    expect(button(el, 'Not now')).toBeDefined();
    expect(confirmProposal).not.toHaveBeenCalled();
    button(el, 'Tick these')!.click();
    await flush();
    expect(confirmProposal).toHaveBeenCalledTimes(1);
    expect(cardEl(m.root)!.dataset.state).toBe('applied');
    expect(button(cardEl(m.root), 'Undo')).toBeDefined();
  });

  test('the API\'s grammar card with its confirmed action is drawn done at once (Step 8 m6: no tap to 409 on)', async () => {
    const d = device();
    const m = mountPanel(d.store);
    const view = serverCard(d.run(), 'grammar') as Extract<CardView, { origin: 'server' }>;
    const trail = { id: 'P1', origin: 'server' as const, kind: 'check_off' as const, summary: 's', undoUntil: new Date(NOW.getTime() + UNDO_WINDOW_MS).toISOString() };
    m.pan.show({ items: [], cards: [view], intents: [], actions: [{ kind: 'confirmed', proposalId: 'P1', trail }], notice: null });
    await flush();
    expect(cardEl(m.root)!.dataset.state).toBe('applied');
    expect(button(cardEl(m.root), 'Tick these')).toBeUndefined();
  });

  test('without health_data consent: a grammar card ticks nothing and shows consent.health_first; a tap after consent ticks', async () => {
    const store = createStore(null);
    store.update((s) => ({ ...s, account: { email: 'cook@example.com' }, accountRules: [] }));
    const tmp = createStore(null);
    createWeekStore({ store: tmp }).savePlan(plan());
    const local = createWeekStore({ store: tmp }).run(MON, TODAY)!;
    rememberRun(local, 'cook@example.com');
    let consented = false;
    const tick = vi.fn((_id: string, key: string, ticked: boolean) => Promise.resolve(consented
      ? { ok: true, status: 200, data: { ...local, items: local.items.map((i) => (i.key === key ? { ...i, ticked } : i)) } }
      : { ok: false, status: 403, error: { code: 'consent_required', message: '', details: { purpose: 'health_data' } } }));
    const client = {
      tick, consents: () => Promise.resolve({ ok: true, status: 200, data: { consents: [], needsReconsent: [], notices: {} } }),
      currentRun: () => Promise.resolve({ ok: true, status: 200, data: { run: local } }),
    } as unknown as ApiClient;
    const m = mountPanel(store, client);
    await m.send('got the shallots');
    expect(tick).toHaveBeenCalledTimes(1); // tried once, refused: nothing ticked
    const healthFirst = content.pan.triggers['consent.health_first'].lines;
    expect([...m.root.querySelectorAll('.bubble.pan')].some((b) => healthFirst.includes(b.textContent))).toBe(true);
    const el = cardEl(m.root)!;
    expect(el.dataset.state).toBe('pending');
    consented = true;
    button(el, 'Tick these')!.click();
    await flush();
    expect(tick).toHaveBeenLastCalledWith(local.id, 'shallot', true, TODAY);
    expect(cardEl(m.root)!.dataset.state).toBe('applied');
  });
});

describe('Fix round 1 (m2): a partial tick is shown as partial', () => {
  test('signed in, the daily cap after the first tick: only that row reads "(ticked)"; Undo unticks only it', async () => {
    const store = createStore(null);
    store.update((s) => ({ ...s, account: { email: 'cap@example.com' }, accountRules: [] }));
    const tmp = createStore(null);
    createWeekStore({ store: tmp }).savePlan(plan());
    const local = createWeekStore({ store: tmp }).run(MON, TODAY)!;
    rememberRun(local, 'cap@example.com');
    let ticks = 0;
    const tick = vi.fn((_id: string, key: string, ticked: boolean) => {
      ticks++;
      if (ticked && ticks > 1) return Promise.resolve({ ok: false, status: 429, error: { code: 'write_cap', message: '', details: { scope: 'day' } } });
      return Promise.resolve({ ok: true, status: 200, data: { ...local, items: local.items.map((i) => (i.key === key ? { ...i, ticked } : i)) } });
    });
    const client = { tick, consents: () => Promise.resolve({ ok: true, status: 200, data: { consents: [], needsReconsent: [], notices: {} } }) } as unknown as ApiClient;
    const m = mountPanel(store, client);
    await m.send('got the shallots and the moong dal');
    const el = cardEl(m.root)!;
    expect(el.dataset.state).toBe('applied');
    expect(el.querySelector('[data-key="shallot"] .checkoff-state')!.textContent).toBe(' (ticked)');
    expect(el.querySelector('[data-key="moong_dal"] .checkoff-state')!.textContent).toBe(' (not ticked)');
    button(el, 'Undo')!.click();
    await flush();
    expect(tick.mock.calls.filter((c) => c[2] === false).map((c) => c[1])).toEqual(['shallot']);
  });
});
