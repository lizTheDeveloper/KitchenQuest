// M6 Step 10: market day, end to end (mocked /api/**). Signed out with the AI off: plan parippu → #/market amounts →
// Out of stock? shallots → take onion → cook parippu shows "swapped at the market"; "got the moong dal" → the card is
// already ticked with an Undo (no tap); Undo → row unticked; "no fennel" → the health ask, nothing ticked. Signed in with
// the AI on: a mocked model-proposed check_off card ticks only after its tap. Errands: Marisol's black_bean errand plays an
// Okafor-Sato bean question and a wrong answer still completes it; Leela's shallot errand shows no question.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildCheckOffCard, UNDO_WINDOW_MS, type MarketRunView, type ProgressEvent } from '@kitchenquest/core/engine';
import { STORE_KEY, type PlayerState } from '../src/state/store';
import { expectNoA11yViolations, expectNoHorizontalScroll, openApp, PAN_READY, type OpenedApp } from './helpers';

const yaml = <T>(rel: string): T => parse(readFileSync(fileURLToPath(new URL(`../../../content/${rel}`, import.meta.url)), 'utf8')) as T;
const pan = yaml<{ triggers: Record<string, { lines: string[] }> }>('dialogue/pan.yaml');
const okafor = yaml<{ questions: { id: string; contains?: string[]; options: { correct?: boolean }[] }[] }>('market/okafor-sato.yaml');
const PARIPPU = 'india/kerala/parippu';
const pad = (n: number) => String(n).padStart(2, '0');
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monday = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return local(d); })();
const SETTINGS = (aiMentor: boolean) => ({ showCalories: false, reducedMotion: 'system' as const, familyTable: false, iosNoteDismissed: false, aiMentor, rescueNudges: false });
const SEED: Partial<PlayerState> = {
  ...PAN_READY, firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), settings: SETTINGS(false),
  localWeek: { plans: [{ weekStart: monday, items: [{ day: 6, kind: 'dish', slug: PARIPPU, servings: 3 }], hard: false, slot: 'unanswered' }], runs: [] },
};
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const stored = (page: Page): Promise<PlayerState> => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}') as PlayerState, STORE_KEY);
const go = async (page: Page, hash: string) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction((h) => location.hash === h, hash);
};
const tell = async (page: Page, text: string) => {
  const before = await page.locator('#pan-panel .bubble.pan').count();
  await page.locator('#pan-text').fill(text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#pan-panel .bubble.pan').length > n, before);
};
const runRow = async (page: Page, key: string) => (await stored(page)).localWeek.runs[0]?.items.find((i) => i.key === key);

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe('market day (M6 Step 10)', () => {
  it('signed out, AI off: amounts → stall swap → cook label → spoken check-off ticks at once, Undo, and "no fennel" stays a health ask', async () => {
    app = await openApp('/#/market', { reducedMotion: true, width: 400, seed: SEED });
    const { page } = app;
    await page.locator('.market-row[data-key="moong_dal"]').waitFor();
    expect(await page.locator('.market-row[data-key="moong_dal"] .market-amount').textContent()).toBe('100 g');
    await expectNoHorizontalScroll(page);

    // Out of stock? → the keeper's offer, core's swap only → take onion.
    const shallot = page.locator('.market-row[data-key="shallot"]');
    await shallot.getByRole('button', { name: /Out of stock\? shallots/ }).click();
    await shallot.locator('.stock-swap[data-to="onion"]').waitFor();
    expect(await shallot.locator('.stock-swap').count()).toBe(1);
    await expectNoA11yViolations(page, 'stock offer');
    await shallot.locator('.stock-swap[data-to="onion"]').click();
    await page.locator('.market-row[data-key="stock:onion"]').waitFor();
    expect(await page.locator('.market-row[data-key="stock:onion"] .market-for').textContent()).toBe('stall swap for Parippu Curry');
    expect(await shallot.locator('.stock-undo').count()).toBe(1);
    expect((await stored(page)).localPantry.some((p) => p.ingredientId === 'onion' && p.source === 'market')).toBe(true);
    await expectNoA11yViolations(page, 'after the swap');

    // Cook mode for parippu: the label and the check with the swap.
    await go(page, `#/cook/${PARIPPU}`);
    await page.locator('.stock-label').waitFor();
    expect(await page.locator('.stock-label').textContent()).toBe('swapped at the market: onion for shallots');
    expect(await page.locator('.cook-refusal').count()).toBe(0);

    // The spoken check-off, AI off: the grammar card is already applied (no tap), with an Undo.
    await go(page, '#/market');
    await page.locator('.market-row[data-key="moong_dal"]').waitFor();
    await page.locator('#pan-button').click();
    await tell(page, 'got the moong dal');
    const card = page.locator('.pan-checkoff-card');
    await card.waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.pan-checkoff-card')?.dataset.state === 'applied');
    expect(await card.getByRole('button', { name: 'Tick these' }).count()).toBe(0);
    expect(await card.getByRole('button', { name: 'Undo' }).count()).toBe(1);
    expect((await runRow(page, 'moong_dal'))?.ticked).toBe(true);
    await expectNoA11yViolations(page, 'check-off card');
    await card.getByRole('button', { name: 'Undo' }).click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.pan-checkoff-card')?.dataset.state === 'undone');
    expect((await runRow(page, 'moong_dal'))?.ticked).toBe(false);

    // A bare "no fennel" is a health statement (Ruling 13): the ask, no card, nothing ticked.
    const cards = await page.locator('.pan-checkoff-card').count();
    await tell(page, 'no fennel');
    const last = (await page.locator('#pan-panel .bubble.pan .bubble-text').last().textContent()) ?? '';
    expect(Object.entries(pan.triggers).some(([id, t]) => id.startsWith('rule.') && t.lines.some((l) => l.split('{')[0].length > 5 && last.startsWith(l.split('{')[0])))).toBe(true);
    expect(await page.locator('.pan-checkoff-card').count()).toBe(cards);
    expect((await stored(page)).localWeek.runs[0].items.filter((i) => i.ticked).map((i) => i.key)).toEqual(['stock:onion']);
    expect(app.consoleErrors).toEqual([]);
  });

  it('signed in, AI on: a model-proposed check_off card ticks nothing before its tap', async () => {
    const run: MarketRunView = {
      id: 'run1', weekStart: monday, doneAt: null,
      items: [{ key: 'moong_dal', name: 'split moong dal', ingredientId: 'moong_dal', stall: 'okafor-sato', forDishes: [PARIPPU], ticked: false }],
    };
    const card = buildCheckOffCard(run, ['moong_dal'], [], 'model')!;
    const calls: string[] = [];
    const consents = { consents: ['health_data', 'ai_health'].map((purpose) => ({ purpose, noticeVersion: 'v', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true })), needsReconsent: [], notices: {} };
    const view = { xp: 0, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered: {} };
    app = await openApp('/', {
      reducedMotion: true,
      seed: { ...PAN_READY, firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), settings: SETTINGS(true) },
      beforeGoto: (page) => page.route((u) => u.pathname.startsWith('/api/'), async (route: Route) => {
        const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        calls.push(`${route.request().method()} ${path}`);
        if (path === '/me') return route.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] }));
        if (path === '/me/consents') return route.fulfill(json(200, consents));
        if (path === '/profile') return route.fulfill(json(200, { marketDays: [], mealsPerWeek: null, country: null, region: null, mealWindows: [] }));
        if (path === '/rules') return route.fulfill(json(200, { rules: [] }));
        if (path === '/pantry') return route.fulfill(json(200, { items: [] }));
        if (path === '/progress') return route.fulfill(json(200, { view }));
        if (path === '/plans/current') return route.fulfill(json(200, { plan: null, weekStart: monday, checks: [] }));
        if (path === '/market-runs/current') return route.fulfill(json(200, { run }));
        if (path === '/mentor/turn') {
          return route.fulfill(json(200, {
            conversationId: 'c1', route: 'ai', notice: null, toolTurn: true, actions: [],
            parts: card.readback.map((line) => ({ kind: 'line', line })),
            cards: [{ proposalId: 'P2', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), card }],
          }));
        }
        if (path === '/mentor/proposals/P2/confirm') {
          run.items[0].ticked = true;
          return route.fulfill(json(200, {
            trail: { id: 'P2', origin: 'server', kind: 'check_off', summary: card.summary, undoUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString() },
            parts: [{ kind: 'line', line: { trigger: 'market.ticked_pantry', vars: { items: 'split moong dal' } } }],
          }));
        }
        return route.fulfill(json(404, { error: { code: 'not_found', message: `no mock for ${path}` } }));
      }),
    });
    const { page } = app;
    await page.locator('#pan-button').click();
    await tell(page, 'I grabbed some of that dal thing');
    const el = page.locator('.pan-checkoff-card');
    await el.waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.pan-checkoff-card')?.dataset.state === 'pending');
    expect(await el.getByRole('button', { name: 'Not now' }).count()).toBe(1);
    expect(calls.filter((c) => c.includes('/confirm') || c.includes('/ticks'))).toEqual([]);
    expect(run.items[0].ticked).toBe(false);
    await el.getByRole('button', { name: 'Tick these' }).click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.pan-checkoff-card')?.dataset.state === 'applied');
    expect(calls.filter((c) => c.includes('/confirm'))).toEqual(['POST /mentor/proposals/P2/confirm']);
    expect(run.items[0].ticked).toBe(true);
  });

  /** Click through dialogue lines and answer quest panels with `answer` until `until` holds. */
  async function playUntil(page: Page, answer: (panel: string) => string, until: () => Promise<boolean>) {
    for (let i = 0; i < 160; i += 1) {
      if (await until()) return;
      const panel = page.locator('.quest-panel');
      if (await panel.count()) {
        await panel.getByRole('button', { name: answer((await panel.textContent()) ?? ''), exact: true }).click();
        continue;
      }
      const next = page.locator('.dialogue .dialogue-next');
      if (await next.count()) { await next.click(); continue; }
      await page.waitForTimeout(50);
    }
    throw new Error('the quest never got there');
  }
  const questSteps = async (page: Page, quest: string) => (await stored(page)).progress.events.filter((e: ProgressEvent) => e.kind === 'quest_step' && e.quest === quest).length;

  it("errands: Marisol's black_bean errand plays an Okafor-Sato bean question, a wrong answer still completes it; Leela's shallot errand shows none", async () => {
    const at = local(new Date());
    const ev = (n: number, kind: string, extra: object) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, kind, at, ...extra });
    const leelaDone = [1, 2, 3, 4, 5, 6].map((s) => ev(s, 'quest_step', { quest: 'leela-tempering', step: s }));
    const events = [...leelaDone, ev(7, 'quest_done', { quest: 'leela-tempering' }), ev(8, 'quest_step', { quest: 'marisol-salt-question', step: 1 }), ev(9, 'quest_step', { quest: 'marisol-salt-question', step: 2 })];
    app = await openApp('/#/visit/marisol', {
      reducedMotion: true, width: 400,
      seed: { ...PAN_READY, firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), settings: SETTINGS(false), progress: { events: events as ProgressEvent[], grants: [], base: null, pendingUpload: [] } },
    });
    const { page } = app;
    let questionSeen = '';
    await playUntil(page, (panel) => {
      if (panel.includes('Fetch')) return "I've got it";
      if (panel.includes('Finish the round')) return 'Finish the round';
      return 'Not yet';
    }, async () => {
      const q = page.locator('.quest-errand-question');
      if (await q.count() && !questionSeen) {
        questionSeen = (await q.textContent()) ?? '';
        await expectNoA11yViolations(page, 'errand question');
        // Pick a wrong option on purpose: the errand passes whatever is answered.
        const qid = await q.locator('.stall-round').getAttribute('data-question');
        const question = okafor.questions.find((x) => x.id === qid)!;
        expect(question.contains ?? []).toContain('bean');
        const wrong = question.options.findIndex((o) => o.correct !== true);
        await q.locator(`.stall-option[data-pick="${wrong}"]`).click();
        await q.locator('.stall-option[data-picked="true"]:not([data-right])').waitFor();
      }
      return (await questSteps(page, 'marisol-salt-question')) >= 3;
    });
    expect(questionSeen).toMatch(/Okafor-Sato/);
    const s = await stored(page);
    const rounds = s.progress.events.filter((e) => e.kind === 'stall_round');
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ stall: 'okafor-sato' });
    expect((rounds[0] as { answers: unknown[] }).answers).toHaveLength(1);
    await app.close();

    // Leela's shallot errand: Wen has no shallot question, so none is shown; it completes as in M5.
    app = await openApp('/#/visit/leela', { reducedMotion: true, seed: { ...PAN_READY, firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), settings: SETTINGS(false) } });
    const p2 = app.page;
    let shown = false;
    await playUntil(p2, (panel) => (panel.includes('Fetch') ? "I've got it" : 'Not yet'), async () => {
      if (await p2.locator('.quest-errand-question').count()) shown = true;
      return (await questSteps(p2, 'leela-tempering')) >= 2;
    });
    expect(shown).toBe(false);
    expect((await stored(p2)).progress.events.some((e) => e.kind === 'stall_round')).toBe(false);
  });
});
