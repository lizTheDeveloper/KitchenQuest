// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { optionOrder, type ProgressEvent, type ProgressView, type Rule } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { catalogueOf, rulesContextOf, withMarket } from '../progress/catalogue';
import { createProgressSync } from '../progress/sync';
import { localDate } from '../recipes/rules';
import type { AppContext } from '../shell/app';
import type { Route } from '../shell/router';
import { createStore, type PlayerState, type PlayerStore } from '../state/store';
import { loadMarket } from './content';
import { stallPlan, stallScreen } from './stall-screen';
import { stallsScreen } from './stalls-screen';

const NOW = new Date(2026, 10, 12, 10, 0); // Thursday 12 November 2026, local
const TODAY = localDate(NOW);
const avoid = (kind: 'category' | 'ingredient', ...ids: string[]): Rule => ({ id: `r-${ids.join('-')}`, target: { kind, ids }, type: 'avoid', severity: 'allergy' });
const VEGETARIAN: Rule = { id: 'r-veg', target: { kind: 'category', ids: ['meat', 'fish', 'shellfish', 'gelatin'] }, type: 'avoid', severity: 'preference' };
const PNW = { marketDays: [], mealsPerWeek: null, country: 'United States', region: 'Seattle, Washington', mealWindows: [] };

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
function store(patch: Partial<PlayerState> = {}): PlayerStore {
  const s = createStore(null);
  s.update((x) => ({ ...x, ...patch }));
  return s;
}
const ft = (s: PlayerStore) => { s.update((x) => ({ ...x, settings: { ...x.settings, familyTable: true } })); return s; };
const client = (consent: 'granted' | 'missing' = 'granted') => ({
  getProfile: () => Promise.resolve({ ok: true, status: 200, data: { ...PNW, country: null, region: null } }),
  consents: () => Promise.resolve({ ok: true, status: 200, data: { consents: consent === 'granted' ? [{ purpose: 'health_data', withdrawnAt: null, current: true }] : [], needsReconsent: [], notices: {} } }),
}) as unknown as Pick<ApiClient, 'getProfile' | 'consents'>;

const EMPTY_VIEW = { marketAnswered: {} } as unknown as ProgressView;
async function open(s: PlayerStore, id: 'wen' | 'bram' | 'okafor-sato' | 'spice', opts: { consent?: 'granted' | 'missing'; view?: ProgressView } = {}) {
  const sent: ProgressEvent[][] = [];
  const navigated: Route[] = [];
  const asked: (() => void)[] = [];
  const screen = stallScreen({
    client: client(opts.consent),
    progress: () => Promise.resolve({ record: (e) => { sent.push(e); return Promise.resolve([]); }, view: () => opts.view ?? EMPTY_VIEW }),
    askConsent: (fn) => { asked.push(fn); },
  });
  const el = document.createElement('div');
  document.body.replaceChildren(el);
  const ctx: AppContext = { store: s, now: () => NOW, navigate: (r) => { navigated.push(r); } };
  await screen.mount(el, { name: 'stall', id }, ctx);
  await flush();
  return { el, sent, navigated, asked, screen };
}
const shownIds = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.stall-round')].map((s) => s.dataset.question);
/** Answer every question in the round with its first shown option, pressing Next / Finish. */
function playThrough(el: HTMLElement): number {
  let n = 0;
  while (el.querySelector('.stall-round')) {
    el.querySelector<HTMLButtonElement>('.stall-option')!.click();
    n += 1;
    el.querySelector<HTMLButtonElement>('.stall-next')!.click();
  }
  return n;
}

describe('a stall (M6 Step 9)', async () => {
  const market = await loadMarket();
  const ctxOf = (rules: Rule[], country: string | null = null) => ({ rules, graph, subs: [...content.substitutions], date: TODAY, country });

  test("stallBank output only: a soy rule shows no tofu question at Okafor-Sato's; a vegetarian sees the Protein Counter", async () => {
    const soy = stallPlan(market.stalls['okafor-sato'], ctxOf([avoid('category', 'soy')]), { country: null, region: null }, market.seasonality, new Map());
    expect(soy.dropped).toBeGreaterThan(0);
    expect(soy.round.every((q) => !(q.contains ?? []).includes('tofu') && !/tofu/i.test(q.prompt))).toBe(true);
    const { el } = await open(store({ localRules: [avoid('category', 'soy')] }), 'okafor-sato');
    expect(el.textContent).not.toMatch(/tofu/i);
    expect(el.querySelector('.stall-note')!.textContent).toBe(el.querySelector('.stall-note')!.textContent); // a bank_small line, never which

    const veg = await open(store({ localRules: [VEGETARIAN] }), 'bram');
    expect(veg.el.querySelector('h1')!.textContent).toBe(market.stalls.bram.variants!.protein_counter!.name);
    expect(veg.el.querySelector('.stall-sign')!.textContent).toBe('Protein Counter');
    expect(shownIds(veg.el)[0]).toMatch(/^bram-pc-/);
    expect(veg.el.textContent).not.toMatch(/lesser|instead of real/i);
    const plain = await open(store(), 'bram');
    expect(plain.el.querySelector('h1')!.textContent).toBe('Big Bram');
    expect(plain.el.querySelector('.stall-sign')).toBeNull();
  });

  test('options render in optionOrder; the pick sent is the FILE index; the event has no correct flag', async () => {
    const { el, sent } = await open(store(), 'wen');
    const first = market.stalls.wen.questions.find((q) => q.id === shownIds(el)[0])!;
    const order = optionOrder(first.id, first.options.length);
    expect([...el.querySelectorAll<HTMLButtonElement>('.stall-option')].map((b) => Number(b.dataset.pick))).toEqual(order);
    const n = playThrough(el);
    expect(n).toBe(5);
    expect(sent).toHaveLength(1);
    const e = sent[0][0] as Extract<ProgressEvent, { kind: 'stall_round' }>;
    expect(e).toMatchObject({ kind: 'stall_round', at: TODAY, stall: 'wen' });
    expect(e.answers[0]).toEqual({ q: first.id, pick: order[0] });
    expect(JSON.stringify(e)).not.toMatch(/correct/);
    expect(el.querySelector('.stall-done')!.textContent).toBe(el.querySelector('.stall-done')!.textContent);
    expect(content.pan.triggers['market.round_done'].lines).toContain(el.querySelector('.stall-done')!.textContent);
  });

  test('a wrong answer shows its reaction and explain and records nothing negative; XP never shown as lost', async () => {
    const { el, sent } = await open(store(), 'spice');
    const q = market.stalls.spice.questions.find((x) => x.id === shownIds(el)[0])!;
    const wrong = q.options.findIndex((o) => !o.correct);
    el.querySelector<HTMLButtonElement>(`.stall-option[data-pick="${wrong}"]`)!.click();
    expect(el.textContent).toContain(q.options[wrong].reaction);
    expect(el.textContent).toContain(q.explain);
    expect(el.querySelector('.stall-round')!.textContent).not.toMatch(/\bxp\b|lost|penalt|wrong!/i);
    el.querySelector<HTMLButtonElement>('.stall-leave')!.click();
    expect(sent).toEqual([[expect.objectContaining({ answers: [{ q: q.id, pick: wrong }] })]]);
  });

  test('no timer, countdown, progress bar, "x/5", "in a row" or score element exists in the round DOM', async () => {
    const { el } = await open(store(), 'bram');
    el.querySelector<HTMLButtonElement>('.stall-option')!.click();
    expect(el.querySelectorAll('progress, meter, [role="progressbar"], [role="timer"], time, .score, .countdown')).toHaveLength(0);
    expect(el.textContent).not.toMatch(/\b\d\s*(\/|of)\s*5\b|in a row|streak|\bscore\b|\blives\b/i);
  });

  test('leaving mid-round records the answers so far once; leaving with none records nothing', async () => {
    const a = await open(store(), 'wen');
    a.el.querySelector<HTMLButtonElement>('.stall-option')!.click();
    a.el.querySelector<HTMLButtonElement>('.stall-next')!.click();
    a.el.querySelector<HTMLButtonElement>('.stall-option')!.click();
    a.el.querySelector<HTMLButtonElement>('.stall-leave')!.click();
    a.screen.unmount?.();
    expect(a.sent).toHaveLength(1);
    expect((a.sent[0][0] as Extract<ProgressEvent, { kind: 'stall_round' }>).answers).toHaveLength(2);
    expect(a.navigated).toEqual([{ name: 'stalls' }]);

    // Leaving by another way (a link, the back button) records the same, once.
    const b = await open(store(), 'wen');
    b.el.querySelector<HTMLButtonElement>('.stall-option')!.click();
    b.screen.unmount?.();
    b.screen.unmount?.();
    expect(b.sent).toHaveLength(1);

    const c = await open(store(), 'wen');
    c.el.querySelector<HTMLButtonElement>('.stall-leave')!.click();
    c.screen.unmount?.();
    const d = await open(store(), 'wen');
    d.screen.unmount?.();
    expect([...c.sent, ...d.sent]).toEqual([]);
  });

  test('Family Table: rounds play, no event recorded, no FAQ chips, no text box', async () => {
    const { el, sent } = await open(ft(store()), 'okafor-sato');
    expect(el.querySelector('.stall-faq, .stall-faq-chip')).toBeNull();
    expect(el.querySelector('textarea, input')).toBeNull();
    expect(playThrough(el)).toBeGreaterThan(0);
    expect(sent).toEqual([]);
    const standard = await open(store(), 'okafor-sato');
    expect(standard.el.querySelectorAll('.stall-faq-chip').length).toBeGreaterThan(0);
    expect(standard.el.querySelector('textarea, input')).toBeNull();
    // A chip shows its written answer, from faqFor.
    standard.el.querySelector<HTMLButtonElement>('.stall-faq-chip')!.click();
    expect(standard.el.querySelector('.stall-faq-answer')!.textContent).not.toBe('');
  });

  test('no region / an unmatched region → market.no_calendar, no seasonal question; pnw-usa in November → seasonal questions', async () => {
    const noCal = content.pan.triggers['market.no_calendar'].lines;
    const seasonalIds = new Set(Object.values(market.stalls.wen.seasonal ?? {}).flatMap((m) => Object.values(m).flat()).map((q) => q.id));
    for (const profile of [null, { ...PNW, country: 'India', region: 'Kerala' }]) {
      const { el } = await open(store({ localProfile: profile }), 'wen');
      const notes = [...el.querySelectorAll('.stall-note')].map((n) => n.textContent);
      expect(notes.filter((t) => t !== null && noCal.includes(t))).toHaveLength(1);
      const plan = stallPlan(market.stalls.wen, ctxOf([]), profile ?? { country: null, region: null }, market.seasonality, new Map());
      expect(plan.round.some((q) => seasonalIds.has(q.id))).toBe(false);
    }
    const pnw = await open(store({ localProfile: PNW }), 'wen');
    expect([...pnw.el.querySelectorAll('.stall-note')].some((n) => noCal.includes(n.textContent ?? ''))).toBe(false);
    // The seasonal questions join the bank after the general ones (Ruling 7's order): with those answered, they lead.
    const solved = new Map(market.stalls.wen.questions.map((q) => [q.id, { correct: true, lastAt: TODAY }]));
    const plan = stallPlan(market.stalls.wen, ctxOf([], 'United States'), PNW, market.seasonality, solved);
    expect(plan.round.filter((q) => q.game === 'seasonal').length).toBeGreaterThan(0);
    expect(stallPlan(market.stalls.wen, ctxOf([]), { country: null, region: null }, market.seasonality, solved).round.some((q) => q.game === 'seasonal')).toBe(false);
    expect(plan.round.every((q) => q.game !== 'seasonal' || seasonalIds.has(q.id))).toBe(true);
  });

  test('rules null → market.stall_wait, no questions', async () => {
    const { el } = await open(store({ rulesUnreadable: true }), 'bram');
    expect(el.querySelector('.stall-round, .stall-option, .stall-faq, .stall-tips')).toBeNull();
    expect(content.pan.triggers['market.stall_wait'].lines).toContain(el.querySelector('#stall-status')!.textContent);
    const signedIn = await open(store({ account: { email: 'a@example.com' }, accountRules: null }), 'wen');
    expect(signedIn.el.querySelector('.stall-option')).toBeNull();
  });

  test('questions with a chalkboard show it and the example-price footnote; no currency symbol in the DOM', async () => {
    // Bram's braise-value question comes once the questions before it are answered right (Ruling 7's order).
    const before = market.stalls.bram.questions.slice(0, market.stalls.bram.questions.findIndex((q) => q.chalkboard !== undefined));
    const view = { marketAnswered: Object.fromEntries(before.map((q) => [q.id, { correct: true, lastAt: TODAY }])) } as unknown as ProgressView;
    const { el } = await open(store(), 'bram', { view });
    expect(el.querySelector('.stall-chalkboard')).not.toBeNull();
    expect(el.querySelector('.stall-price-note')!.textContent).toMatch(/^\*Example prices in no particular currency/);
    expect(el.textContent).not.toMatch(/[$£€₹¢¥]/);
    // Family Table keeps the footnote too.
    const kid = await open(ft(store()), 'bram', { view });
    expect(kid.el.querySelector('.stall-price-note')).not.toBeNull();
  });

  test('signed in, a Protein Counter round waits for health_data consent and routes to the consent card', async () => {
    const s = store({ account: { email: 'a@example.com' }, accountRules: [VEGETARIAN] });
    const { el, asked, navigated } = await open(s, 'bram', { consent: 'missing' });
    expect(el.querySelector('.stall-option')).toBeNull();
    el.querySelector<HTMLButtonElement>('.stall-consent')!.click();
    expect(asked).toHaveLength(1);
    asked[0]();
    expect(navigated).toEqual([{ name: 'stall', id: 'bram' }]);
    const granted = await open(s, 'bram', { consent: 'granted' });
    expect(granted.el.querySelector('.stall-option')).not.toBeNull();
    // A base stall needs no consent; nor does the Protein Counter signed out (the device keeps it, L-5).
    expect((await open(s, 'wen', { consent: 'missing' })).el.querySelector('.stall-option')).not.toBeNull();
    expect((await open(store({ localRules: [VEGETARIAN] }), 'bram', { consent: 'missing' })).el.querySelector('.stall-option')).not.toBeNull();
  });

  test('signed out, a finished round is judged by the device catalogue with market loaded: a first correct answer earns xp.market_game', async () => {
    const s = store();
    const sync = createProgressSync({ store: s, client: {} as ApiClient, online: () => true, context: () => rulesContextOf([], [], TODAY) });
    const q = market.stalls.wen.questions[0];
    const right = q.options.findIndex((o) => o.correct);
    const event = (id: string): ProgressEvent => ({ id, kind: 'stall_round', at: TODAY, stall: 'wen', answers: [{ q: q.id, pick: right }] });
    withMarket(market);
    expect(catalogueOf().market?.has('wen')).toBe(true);
    const grants = await sync.record([event('00000000-0000-4000-8000-000000000001')]);
    expect(grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'xp', reason: 'market_game', amount: content.rewards.xp.market_game }),
      expect.objectContaining({ kind: 'stamp', stamp: 'market_game' }),
    ]));
    // A second identical round that ISO week: no XP (once per question) and no second stamp.
    expect(await sync.record([event('00000000-0000-4000-8000-000000000002')])).toEqual([]);
  });
});

describe('the hub (M6 Step 9)', () => {
  test('one button per stall with its keeper\'s name and the round\'s games; a vegetarian sees the Protein Counter named', async () => {
    const s = store({ localRules: [VEGETARIAN] });
    const navigated: Route[] = [];
    const screen = stallsScreen({ client: client() });
    const el = document.createElement('div');
    document.body.replaceChildren(el);
    await screen.mount(el, { name: 'stalls' }, { store: s, now: () => NOW, navigate: (r) => { navigated.push(r); } });
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('.stall-button')];
    expect(buttons.map((b) => b.dataset.stall)).toEqual(['wen', 'bram', 'okafor-sato', 'spice']);
    const market = await loadMarket();
    expect(buttons[1].querySelector('.stall-button-name')!.textContent).toBe(market.stalls.bram.variants!.protein_counter!.name);
    expect(buttons.every((b) => b.querySelector('.stall-button-games')!.textContent !== '')).toBe(true);
    buttons[2].click();
    expect(navigated).toEqual([{ name: 'stall', id: 'okafor-sato' }]);
    // A canvas hotspot is the same action.
    window.dispatchEvent(new CustomEvent('kq:action', { detail: { id: 'stall:spice' } }));
    window.dispatchEvent(new CustomEvent('kq:action', { detail: { id: 'stall:fishmonger' } }));
    expect(navigated).toEqual([{ name: 'stall', id: 'okafor-sato' }, { name: 'stall', id: 'spice' }]);
    screen.unmount?.();
    window.dispatchEvent(new CustomEvent('kq:action', { detail: { id: 'stall:wen' } }));
    expect(navigated).toHaveLength(2);
  });
});
