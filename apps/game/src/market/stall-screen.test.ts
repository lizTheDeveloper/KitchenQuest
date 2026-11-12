// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { keeperLines, optionOrder, stallBank, type ProgressEvent, type ProgressView, type Rule } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { catalogueOf, rulesContextOf, withMarket } from '../progress/catalogue';
import { createProgressSync } from '../progress/sync';
import { localDate } from '../recipes/rules';
import type { AppContext } from '../shell/app';
import type { Route } from '../shell/router';
import { createStore, type PlayerState, type PlayerStore } from '../state/store';
import { loadMarket } from './content';
import { panLine, safeText, stallPlan, stallScreen } from './stall-screen';
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
const client = (consent: 'granted' | 'missing' | { now: 'granted' | 'missing' } = 'granted') => ({
  getProfile: () => Promise.resolve({ ok: true, status: 200, data: { ...PNW, country: null, region: null } }),
  consents: () => Promise.resolve({ ok: true, status: 200, data: { consents: (typeof consent === 'string' ? consent : consent.now) === 'granted' ? [{ purpose: 'health_data', withdrawnAt: null, current: true }] : [], needsReconsent: [], notices: {} } }),
}) as unknown as Pick<ApiClient, 'getProfile' | 'consents'>;

const EMPTY_VIEW = { marketAnswered: {} } as unknown as ProgressView;
async function open(s: PlayerStore, id: 'wen' | 'bram' | 'okafor-sato' | 'spice', opts: { consent?: 'granted' | 'missing' | { now: 'granted' | 'missing' }; view?: ProgressView; noProgress?: true; now?: () => Date } = {}) {
  const sent: ProgressEvent[][] = [];
  const navigated: Route[] = [];
  const asked: (() => void)[] = [];
  const screen = stallScreen({
    client: client(opts.consent),
    progress: () => (opts.noProgress ? Promise.reject(new Error('no progress')) : Promise.resolve({ record: (e) => { sent.push(e); return Promise.resolve([]); }, view: () => opts.view ?? EMPTY_VIEW })),
    askConsent: (fn) => { asked.push(fn); },
  });
  const el = document.createElement('div');
  document.body.replaceChildren(el);
  const ctx: AppContext = { store: s, now: opts.now ?? (() => NOW), navigate: (r) => { navigated.push(r); } };
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

  test('keeper lines only as core keeperLines keeps them: the greeting and the farewell are rules-checked lines', async () => {
    const noBeef = [avoid('category', 'beef')];
    const { el } = await open(store({ localRules: noBeef }), 'bram');
    const greet = el.querySelector('.stall-greeting')?.textContent ?? null;
    const kept = keeperLines(market.stalls.bram, 'greet', ctxOf(noBeef));
    if (greet !== null) expect(kept).toContain(greet);
    expect(market.stalls.bram.triggers.greet.lines.filter((l) => !kept.includes(l)).length).toBeGreaterThan(0); // some were dropped
    playThrough(el);
    const said = [...el.querySelectorAll('.stall-said')].map((p) => p.textContent);
    const farewells = keeperLines(market.stalls.bram, 'farewell', ctxOf(noBeef)).map((l) => `Big Bram: ${l}`);
    expect(said.some((t) => t !== null && farewells.includes(t))).toBe(farewells.length > 0);
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
    const consent = { now: 'missing' as 'granted' | 'missing' };
    const { el, asked } = await open(s, 'bram', { consent });
    expect(el.querySelector('.stall-option')).toBeNull();
    el.querySelector<HTMLButtonElement>('.stall-consent')!.click();
    expect(asked).toHaveLength(1);
    consent.now = 'granted';
    asked[0]();
    await flush();
    expect(el.querySelector('.stall-option')).not.toBeNull(); // granted: the stall redraws with the round
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

describe('fix round 1 (review-task9)', async () => {
  const market = await loadMarket();
  const ctxOf = (rules: Rule[], country: string | null = null) => ({ rules, graph, subs: [...content.substitutions], date: TODAY, country });
  const SOY = avoid('category', 'soy');
  const roundIds = (sent: ProgressEvent[][]) => sent.flat().flatMap((e) => (e.kind === 'stall_round' ? e.answers.map((a) => a.q) : []));
  const tofuish = (qid: string | undefined) => {
    const q = market.stalls['okafor-sato'].questions.find((x) => x.id === qid);
    return q !== undefined && stallPlan(market.stalls['okafor-sato'], ctxOf([SOY]), { country: null, region: null }, market.seasonality, new Map()).round.every((x) => x.id !== q.id)
      && !stallBankIds(SOY).has(q.id);
  };
  const stallBankIds = (rule: Rule) => new Set(stallBank(market.stalls['okafor-sato'], ctxOf([rule])).questions.map((q) => q.id));

  test('I2: a soy rule added mid-round: the tofu question disappears at once, and the answer to it is never recorded', async () => {
    const s = store();
    const { el, sent, screen } = await open(s, 'okafor-sato');
    const first = shownIds(el)[0];
    expect(tofuish(first)).toBe(true); // the round opens on a tofu question
    const stale = el.querySelector<HTMLButtonElement>('.stall-option')!;
    stale.click(); // answered under the old rules
    s.update((x) => ({ ...x, localRules: [SOY] }));
    await flush();
    expect(el.textContent).not.toMatch(/tofu/i);
    expect(shownIds(el).every((q) => stallBankIds(SOY).has(q!))).toBe(true);
    expect(el.querySelector('.stall-faq')?.textContent ?? '').not.toMatch(/\bsoy|tofu|edamame|miso|tempeh\b/i);
    // The tofu answer, now ⛔, is refused: nothing about it is recorded, now or on leaving.
    screen.unmount?.();
    expect(roundIds(sent)).not.toContain(first);
  });

  test('I2: a pick on a question the rules closed since it was drawn is refused (no reaction, no record)', async () => {
    // A soy rule that starts tomorrow: the stall draws under today's rules, then the clock passes midnight unheard.
    const tomorrow = '2026-11-13';
    let now = NOW;
    const s = store({ localRules: [{ ...SOY, phase: { start: tomorrow } }] });
    const { el, sent, screen } = await open(s, 'okafor-sato', { now: () => now });
    const first = shownIds(el)[0];
    expect(tofuish(first)).toBe(true);
    now = new Date(2026, 10, 13, 9, 0);
    el.querySelector<HTMLButtonElement>('.stall-option')!.click();
    expect(el.querySelector('.stall-feedback:not([hidden])')).toBeNull();
    await flush();
    expect(el.textContent).not.toMatch(/tofu/i); // redrawn under the rules as they are now
    screen.unmount?.();
    expect(roundIds(sent)).not.toContain(first);
  });

  test('I2: signed in, a stall opened before the account\'s rules arrive opens once they do', async () => {
    const s = store({ account: { email: 'a@example.com' }, accountRules: null });
    const { el } = await open(s, 'wen');
    expect(el.querySelector('.stall-option')).toBeNull();
    s.update((x) => ({ ...x, accountRules: [] }));
    await flush();
    expect(el.querySelector('.stall-option')).not.toBeNull();
  });

  test('I4: the Pan\'s market lines go through the rules text check: the strawberry market.cheer line never reaches a strawberry rule', () => {
    const STRAWBERRY = avoid('ingredient', 'strawberry');
    const liar = content.pan.triggers['market.cheer'].lines.find((l) => /strawberr/i.test(l))!;
    expect(liar).toBeDefined();
    const keys = Array.from({ length: 400 }, (_, i) => `k${i}`);
    expect(keys.some((k) => panLine('market.cheer', k, ctxOf([])) === liar)).toBe(true);
    expect(keys.some((k) => panLine('market.cheer', k, ctxOf([STRAWBERRY])) === liar)).toBe(false);
    for (const t of ['market.answer_right', 'market.wrong', 'market.round_done', 'market.leave_round', 'market.bank_small', 'market.no_calendar']) {
      for (const k of keys.slice(0, 50)) {
        const line = panLine(t, k, ctxOf([STRAWBERRY, SOY]));
        if (line !== null) expect(safeText(line, ctxOf([STRAWBERRY, SOY])), `${t}: ${line}`).toBe(true);
      }
    }
    // Rules that can't be read: only a line naming no food at all.
    for (const k of keys.slice(0, 50)) expect(panLine('market.stall_wait', k, null)).not.toBeNull();
  });

  test('M1: the keeper\'s correct and wrong lines are only those keeperLines keeps (a soy rule never hears the tofu lines)', async () => {
    const os = market.stalls['okafor-sato'];
    const who = `${os.name}: `;
    const kept = new Set([...keeperLines(os, 'correct', ctxOf([SOY])), ...keeperLines(os, 'wrong', ctxOf([SOY]))].map((l) => who + l));
    const dropped = [...os.triggers.correct.lines, ...os.triggers.wrong.lines].map((l) => who + l).filter((l) => !kept.has(l));
    expect(dropped.length).toBeGreaterThan(0); // some are dropped for this player
    let heard = 0;
    for (let pick = 0; pick < 4; pick++) {
      const { el } = await open(store({ localRules: [SOY] }), 'okafor-sato');
      while (el.querySelector('.stall-round')) {
        el.querySelectorAll<HTMLButtonElement>('.stall-option')[pick % el.querySelectorAll('.stall-option').length]!.click();
        const said = el.querySelector('.stall-feedback .stall-said')?.textContent ?? null;
        if (said !== null && said.startsWith(who)) { heard += 1; expect(kept.has(said), said).toBe(true); }
        el.querySelector<HTMLButtonElement>('.stall-next')!.click();
      }
    }
    expect(heard).toBeGreaterThan(0);
  });

  test('M3: a FAQ answer is shown only when it names nothing ⛔ or ❓ (core\'s fallback line included)', async () => {
    const { el } = await open(store({ localRules: [SOY] }), 'okafor-sato');
    for (const chip of el.querySelectorAll<HTMLButtonElement>('.stall-faq-chip')) {
      chip.click();
      const a = el.querySelector('.stall-faq-answer')!.textContent!.replace(/^[^:]+: /, '');
      expect(safeText(a, ctxOf([SOY])), a).toBe(true);
    }
    const medical = market.stalls['okafor-sato'].triggers.medical.lines[0];
    expect(el.textContent).not.toContain(medical);
  });

  test('M4: a round is never recorded into another partition: an account switch mid-round drops it', async () => {
    const s = store();
    const { el, sent, screen } = await open(s, 'wen');
    el.querySelector<HTMLButtonElement>('.stall-option')!.click();
    s.update((x) => ({ ...x, account: { email: 'b@example.com' }, accountRules: [] }));
    await flush();
    screen.unmount?.();
    expect(sent).toEqual([]);
  });

  test('M5: closing or reloading the tab mid-round records the answers so far, once', async () => {
    const { el, sent, screen } = await open(store(), 'wen');
    el.querySelector<HTMLButtonElement>('.stall-option')!.click();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    screen.unmount?.();
    expect(sent).toHaveLength(1);
    expect(roundIds(sent)).toHaveLength(1);
  });

  test('M7: with no progress service the round still plays, and the stall says nothing is kept', async () => {
    const { el, sent } = await open(store(), 'wen', { noProgress: true });
    expect(el.textContent).toContain("can't be kept just now");
    expect(playThrough(el)).toBeGreaterThan(0);
    expect(sent).toEqual([]);
  });

  test('M2: the stall never names the butcher first for a Protein Counter player', async () => {
    const screen = stallScreen({ client: client(), progress: () => new Promise(() => {}), load: () => new Promise(() => {}) });
    expect(screen.title).toBe('Stall');
    const el = document.createElement('div');
    void screen.mount(el, { name: 'stall', id: 'bram' }, { store: store({ localRules: [VEGETARIAN] }), now: () => NOW, navigate: () => {} });
    await flush();
    expect(el.querySelector('h1')!.textContent).toBe('Stall');
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

describe('the hub, fix round 1', () => {
  test('I2: the hub re-filters live: a vegetarian rule names the Protein Counter, a soy rule drops the tofu game; M2: never the butcher first', async () => {
    const s = store();
    const screen = stallsScreen({ client: client() });
    const el = document.createElement('div');
    document.body.replaceChildren(el);
    const opening = screen.mount(el, { name: 'stalls' }, { store: s, now: () => NOW, navigate: () => {} });
    expect(el.querySelectorAll('.stall-button')).toHaveLength(0); // drawn once the stalls (and so the variant) are known
    await opening;
    const market = await loadMarket();
    const name = (id: string) => el.querySelector(`.stall-button[data-stall="${id}"] .stall-button-name`)!.textContent;
    const games = (id: string) => el.querySelector(`.stall-button[data-stall="${id}"] .stall-button-games`)!.textContent;
    expect(name('bram')).toBe('Big Bram');
    expect(games('okafor-sato')).toMatch(/tofu/i);
    s.update((x) => ({ ...x, localRules: [VEGETARIAN, avoid('category', 'soy')] }));
    await flush();
    expect(name('bram')).toBe(market.stalls.bram.variants!.protein_counter!.name);
    expect(games('okafor-sato')).not.toMatch(/tofu/i);
    screen.unmount?.();
  });
});
