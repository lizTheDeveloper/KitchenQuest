// M6 Step 11: a market week, end to end (mocked /api/**; 400 px and 1280 px; canvas on and off). Today is Saturday
// 14 November 2026 and the profile is the US Pacific Northwest; the plan holds parippu on Sunday. The hub → Wen's
// seasonal round (one right, one wrong, leave: one stall_round, XP once, the stamp line once) → the same round again
// (nothing more that ISO week, no word of a loss) → #/market (amounts, out of stock on shallots, take onion, tick two,
// the shop done) → the Pan's check-off (the grammar card ticks at once with an Undo, C31; "no fennel" is the health
// ask, C30; a model-proposed card ticks only on its tap) → cook parippu with the swap label → a coconut rule (parippu
// ⛔, Cook disabled, its unticked rows gone, progress unchanged) and a soy rule (no tofu question) → the region moves
// to Kerala (no seasonal round, `market.no_calendar` once, no Pacific Northwest anywhere) → a vegetarian rule (the
// Protein Counter, no meat). Run twice: AI off and signed out on the device, then AI on and signed in with mocked
// turns. Also: regional honesty over seven profiles, and nothing gates the list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  buildCheckOffCard, UNDO_WINDOW_MS, type ListItem, type MarketRunView, type ProgressEvent, type ProgressView, type RewardGrant,
} from '@kitchenquest/core/engine';
import { STORE_KEY, type LocalProfile, type PlayerState } from '../src/state/store';
import { expectNoHorizontalScroll, openApp, PAN_READY, type OpenedApp } from './helpers';

const yaml = <T>(rel: string): T => parse(readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8')) as T;
interface Q { id: string; contains?: string[]; countries?: string[]; options: { text: string; correct?: boolean }[] }
interface Stall { name: string; questions: Q[]; seasonal?: Record<string, Record<string, Q[]>>; variants?: { protein_counter: { name: string; questions: Q[] } } }
const pan = yaml<{ triggers: Record<string, { lines: string[] }> }>('content/dialogue/pan.yaml');
const stalls = Object.fromEntries(['wen', 'bram', 'okafor-sato', 'spice'].map((s) => [s, yaml<Stall>(`content/market/${s}.yaml`)])) as Record<string, Stall>;
const seasonTable = yaml<Record<string, { name: string; categories: { label: string }[] }>>('data/seasonality.yaml');
const allQuestions = (s: Stall): Q[] => [...s.questions, ...(s.variants?.protein_counter.questions ?? []), ...Object.values(s.seasonal ?? {}).flatMap((m) => Object.values(m).flat())];
const question = (id: string): Q => Object.values(stalls).flatMap(allQuestions).find((q) => q.id === id)!;
const rightPick = (id: string) => question(id).options.findIndex((o) => o.correct === true);
const wrongPick = (id: string) => question(id).options.findIndex((o) => o.correct !== true);
/** `stamp_earned.market_game` with `{stall}` filled: does `text` say it for `stall`? */
const stampLine = (text: string, stall: string) => pan.triggers['stamp_earned.market_game'].lines.some((l) => l.replace('{stall}', stall) === text);
const lineOf = (trigger: string) => pan.triggers[trigger].lines;
/** Words of loss a replayed round may never show (§6, never rule 6; Review Focus 2). */
const LOSS = /\b(lost|lose|losing|loses|deduct\w*|minus|taken back|take back|forfeit\w*|try harder|failed|you failed)\b|-\s?\d+\s*XP/i;
/** Every Pacific Northwest season word: the region's name and its category labels (no other region exists). */
const PNW_WORDS = [seasonTable['pnw-usa'].name, 'Pacific Northwest', ...seasonTable['pnw-usa'].categories.map((c) => c.label)];
const MEAT_WORDS = /\b(beef|chicken|pork|lamb|mutton|veal|bacon|ham|brisket|chuck|steak|mince|thighs?)\b/i;

const PARIPPU = 'india/kerala/parippu';
/** Saturday 14 November 2026, mid-morning, local time. With no market day the plan week is Monday 9 … Sunday 15. */
const NOW = new Date(2026, 10, 14, 10, 0, 0);
const MONDAY = '2026-11-09';
const TODAY = '2026-11-14';
/** The Pacific Northwest, as a player writes it ("Washington" alone is ambiguous with DC: core gives null, Step 2 I2). */
const PNW: LocalProfile = { marketDays: [], mealsPerWeek: null, country: 'United States', region: 'Washington State', mealWindows: [] };
const KERALA: LocalProfile = { ...PNW, country: 'India', region: 'Kerala' };
const SETTINGS = (aiMentor: boolean) => ({ showCalories: false, reducedMotion: 'system' as const, familyTable: false, iosNoteDismissed: false, aiMentor, rescueNudges: false });
const COCONUT = { target: { kind: 'ingredient' as const, ids: ['coconut'] }, type: 'avoid' as const, severity: 'anaphylactic' as const };
const SOY = { target: { kind: 'ingredient' as const, ids: ['soy'] }, type: 'avoid' as const, severity: 'allergy' as const };
const VEGETARIAN = { target: { kind: 'category' as const, ids: ['meat', 'fish', 'shellfish', 'gelatin'] }, type: 'avoid' as const, severity: 'preference' as const };

/**
 * Every Wen base question, answered right in October: so the bank's unanswered questions, Wen's November seasonal ones
 * for the player's region, come first (core `nextRound`), and "the seasonal round appears" on the first visit.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WEN_PAST: ProgressEvent[] = [{ id: uuid(901), kind: 'stall_round', at: '2026-10-19', stall: 'wen', answers: stalls.wen.questions.map((q) => ({ q: q.id, pick: rightPick(q.id) })) }];
const SEED = (aiMentor: boolean, extra: Partial<PlayerState> = {}): Partial<PlayerState> => ({
  ...PAN_READY, firstOpenedAt: NOW.toISOString(), lastOpenedAt: NOW.toISOString(), settings: SETTINGS(aiMentor), localProfile: PNW,
  localWeek: { plans: [{ weekStart: MONDAY, items: [{ day: 6, kind: 'dish', slug: PARIPPU, servings: 3 }], hard: false, slot: 'unanswered' }], runs: [] },
  progress: { events: WEN_PAST, grants: [], base: null, pendingUpload: [] },
  ...extra,
});

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const stored = (page: Page): Promise<PlayerState> => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}') as PlayerState, STORE_KEY);
const patch = (page: Page, p: Partial<PlayerState>) => page.evaluate(({ k, p }) => {
  const s = JSON.parse(localStorage.getItem(k)!) as PlayerState;
  localStorage.setItem(k, JSON.stringify({ ...s, ...p }));
}, { k: STORE_KEY, p });
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
const toasts = (page: Page) => page.locator('.progress-toast').allTextContents();
const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

/** The player's progress as the screens read it: the guest partition signed out, the account's own signed in. */
interface Where { events(p: Page): Promise<ProgressEvent[]>; grants(p: Page): Promise<RewardGrant[]> }
const DEVICE: Where = {
  events: async (p) => (await stored(p)).progress.events,
  grants: async (p) => (await stored(p)).progress.grants,
};

/** Open a stall and wait for its first question (or the screen's settled state). */
async function openStall(page: Page, id: string) {
  await go(page, '#/stalls');
  await page.locator(`.stall-button[data-stall="${id}"]`).click();
  await page.waitForFunction((h) => location.hash === h, `#/stall/${id}`);
  await page.locator('.stall-option, .stall-round-slot p, .stall-consent').first().waitFor();
}
const currentQ = (page: Page) => page.locator('.stall-round').getAttribute('data-question');
async function pick(page: Page, which: 'right' | 'wrong') {
  const q = (await currentQ(page))!;
  await page.locator(`.stall-option[data-pick="${which === 'right' ? rightPick(q) : wrongPick(q)}"]`).click();
  await page.locator('.stall-feedback:not([hidden])').waitFor();
  return q;
}
/** Every question id a full round shows, answered with `answer(id)`; ends on the round's done line. */
async function playThrough(page: Page, answer: (id: string) => 'right' | 'wrong'): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < 12 && (await page.locator('.stall-round').count()) > 0; i++) {
    const id = (await currentQ(page))!;
    seen.push(id);
    await pick(page, answer(id));
    await page.locator('.stall-next').click();
  }
  await page.locator('.stall-done').waitFor();
  return seen;
}

/** Steps 2–3: Wen's seasonal round; one right, one wrong, leave; then again the same week. */
async function wenRounds(page: Page, where: Where) {
  await openStall(page, 'wen');
  expect(await page.locator('.stall-game').first().textContent()).toBe('Seasonal or well-travelled?');
  expect(await currentQ(page)).toMatch(/^wen-pnw-11-/);
  const before = (await where.grants(page)).length;
  const q1 = await pick(page, 'right');
  await page.locator('.stall-next').click();
  const q2 = await pick(page, 'wrong');
  expect(q2).toMatch(/^wen-pnw-11-/);
  await page.getByRole('button', { name: 'Leave the stall' }).click();
  await page.waitForFunction(() => location.hash === '#/stalls');
  // The Pan's leave line on the hub; leaving costs nothing.
  const said = (await page.locator('.week-note').textContent()) ?? '';
  expect(lineOf('market.leave_round')).toContain(said);
  await expect.poll(async () => (await where.events(page)).filter((e) => e.kind === 'stall_round' && e.at === TODAY).length).toBe(1);
  const round = (await where.events(page)).find((e) => e.kind === 'stall_round' && e.at === TODAY) as Extract<ProgressEvent, { kind: 'stall_round' }>;
  expect(round.answers).toEqual([{ q: q1, pick: rightPick(q1) }, { q: q2, pick: wrongPick(q2) }]);
  await expect.poll(async () => (await where.grants(page)).length - before).toBe(2);
  const earned = (await where.grants(page)).slice(before);
  expect(earned.map((g) => (g.kind === 'xp' ? `xp ${g.amount} ${g.reason}` : g.kind === 'stamp' ? `stamp ${g.stamp}` : g.kind))).toEqual(['xp 5 market_game', 'stamp market_game']);
  await expect.poll(async () => (await toasts(page)).filter((t) => stampLine(t, 'Old Wen')).length).toBe(1);

  // Step 3: the same round again, that ISO week. Questions already solved are answered right, the rest wrong:
  // nothing new is earned, no second stamp, and no line speaks of a loss.
  await openStall(page, 'wen');
  const solved = new Set([...stalls.wen.questions.map((q) => q.id), q1]);
  const seen = await playThrough(page, (id) => (solved.has(id) ? 'right' : 'wrong'));
  expect(seen).toContain(q2);
  expect(await bodyText(page)).not.toMatch(LOSS);
  await expect.poll(async () => (await where.events(page)).filter((e) => e.kind === 'stall_round' && e.at === TODAY).length).toBe(2);
  expect((await where.grants(page)).length - before).toBe(2);
  await page.evaluate(() => new Promise((r) => { requestAnimationFrame(() => { r(null); }); }));
  expect((await toasts(page)).filter((t) => stampLine(t, 'Old Wen'))).toHaveLength(1);
  expect((await toasts(page)).join(' ')).not.toMatch(LOSS);
}

/**
 * Step 4 (the list): amounts, out of stock on shallots → onion, two rows ticked. "That's the shop done" waits until after
 * Step 7's rule (a done run is a record and is never recomputed, so a rule could not take rows off it).
 */
async function theList(page: Page) {
  await go(page, '#/market');
  await page.locator('.market-row[data-key="moong_dal"]').waitFor();
  expect(await page.locator('.market-row[data-key="moong_dal"] .market-amount').textContent()).toBe('100 g');
  expect(await page.locator('.market-amount').count()).toBeGreaterThan(3);
  const shallot = page.locator('.market-row[data-key="shallot"]');
  await shallot.getByRole('button', { name: /Out of stock\? shallots/ }).click();
  await shallot.locator('.stock-swap[data-to="onion"]').click();
  await page.locator('.market-row[data-key="stock:onion"]').waitFor();
  expect(await page.locator('.market-row[data-key="stock:onion"] .market-for').textContent()).toBe('stall swap for Parippu Curry');
  for (const key of ['garlic', 'mustard_seed']) {
    await page.locator(`.market-tick[data-key="${key}"]`).click();
    await page.locator(`.market-tick[data-key="${key}"]:checked`).waitFor();
  }
  await expectNoHorizontalScroll(page);
}
async function shopDone(page: Page) {
  await go(page, '#/market');
  await page.getByRole('button', { name: "That's the shop done" }).click();
  await page.locator('.market-done').waitFor({ state: 'detached' });
}

/** Step 5 (AI off): the grammar card already applied; "no fennel" is the health ask. */
async function checkOffByGrammar(page: Page, ticked: (p: Page, key: string) => Promise<boolean | undefined>) {
  await page.locator('#pan-button').click();
  await tell(page, 'got the moong dal');
  const card = page.locator('.pan-checkoff-card').last();
  await card.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.pan-checkoff-card')].at(-1)?.dataset.state === 'applied');
  expect(await card.getByRole('button', { name: 'Tick these' }).count(), 'no tap needed (C31)').toBe(0);
  expect(await card.getByRole('button', { name: 'Undo' }).count()).toBe(1);
  await expect.poll(() => ticked(page, 'moong_dal')).toBe(true);
  const cards = await page.locator('.pan-checkoff-card').count();
  await tell(page, 'no fennel');
  const last = (await page.locator('#pan-panel .bubble.pan .bubble-text').last().textContent()) ?? '';
  expect(Object.entries(pan.triggers).some(([id, t]) => id.startsWith('rule.') && t.lines.some((l) => l.split('{')[0].length > 5 && last.startsWith(l.split('{')[0]))), last).toBe(true);
  expect(await page.locator('.pan-checkoff-card').count(), 'no card for a bare "no X" (C30)').toBe(cards);
  await page.keyboard.press('Escape');
}

/** Step 6: cook parippu, with the market's swap label. */
async function cookLabel(page: Page) {
  await go(page, `#/cook/${PARIPPU}`);
  await page.locator('.stock-label').waitFor();
  expect(await page.locator('.stock-label').textContent()).toBe('swapped at the market: onion for shallots');
  expect(await page.locator('.cook-refusal').count()).toBe(0);
}

/** Step 7: a coconut rule, then a soy rule. `addRule` files the rule the player's way. */
async function rulesChange(page: Page, where: Where, addRule: (rule: object) => Promise<void>, view: () => Promise<ProgressView | null>) {
  const grants = await where.grants(page);
  const events = (await where.events(page)).length;
  const before = await view();
  await addRule(COCONUT);
  await go(page, '#/plan');
  await page.locator(`.plan-item[data-slug="${PARIPPU}"][data-status="blocked"]`).waitFor();
  expect(await page.locator(`.plan-item[data-slug="${PARIPPU}"] .plan-cook`).isDisabled()).toBe(true);
  await go(page, `#/cook/${PARIPPU}`);
  await page.locator('.cook-refusal').waitFor();
  await go(page, '#/market');
  await page.locator('.market-row').first().waitFor();
  // Parippu's unticked rows are gone (M5 C20); its ticked rows and the stall-swap row stay, as bought.
  const rows = await page.locator('.market-row').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key));
  // Its out-of-stock shallots row goes with them (C23); the onion taken in its place stays.
  expect(rows.sort()).toEqual(['garlic', 'moong_dal', 'mustard_seed', 'stock:onion'].sort());
  // Nothing earned is taken back.
  expect(await where.grants(page)).toEqual(grants);
  expect((await where.events(page)).length).toBe(events);
  const after = await view();
  if (before !== null && after !== null) {
    expect(after.xp).toBe(before.xp);
    expect(after.level).toBe(before.level);
    expect(after.stamps).toBe(before.stamps);
  }
  // That's the shop done (it earns the run's own XP and stamp); the list is a record from here on.
  await shopDone(page);
  expect((await where.grants(page)).slice(0, grants.length)).toEqual(grants);

  // A soy rule: no tofu question at Okafor-Sato's, round after round.
  await addRule(SOY);
  await openStall(page, 'okafor-sato');
  const seen = await playThrough(page, () => 'right');
  expect(seen.length).toBeGreaterThan(0);
  for (const id of seen) expect(question(id).contains ?? [], id).not.toContain('tofu');
  expect(await page.locator('#view').textContent()).not.toMatch(/\btofu\b/i);
}

/** Step 8: the region moves to Kerala, India (no table): no seasonal round, no_calendar once, no PNW words anywhere. */
async function moveToKerala(page: Page, setRegion: () => Promise<void>) {
  await setRegion();
  await openStall(page, 'wen');
  const ids: string[] = [];
  for (let i = 0; i < 6 && (await page.locator('.stall-round').count()) > 0; i++) {
    ids.push((await currentQ(page))!);
    await pick(page, 'right');
    if (i === 0) {
      const notes = await page.locator('.stall-note').allTextContents();
      expect(notes.filter((n) => lineOf('market.no_calendar').includes(n)), notes.join(' | ')).toHaveLength(1);
    }
    await page.locator('.stall-next').click();
  }
  expect(ids.some((id) => id.startsWith('wen-pnw-')), ids.join(',')).toBe(false);
  for (const hash of ['#/stalls', '#/market', '#/plan', '#/stall/wen']) {
    await go(page, hash);
    await page.locator('#view h1').first().waitFor();
    await page.waitForTimeout(150);
    const text = await bodyText(page);
    for (const w of PNW_WORDS) expect(text, `${hash}: ${w}`).not.toContain(w);
    expect(await page.locator('.season-note').count(), `${hash}: season notes`).toBe(0);
  }
}

/** Step 9: a vegetarian rule: Bram runs the Protein Counter; no meat question or tip. */
async function proteinCounter(page: Page, addRule: (rule: object) => Promise<void>) {
  await addRule(VEGETARIAN);
  await openStall(page, 'bram');
  await page.locator('#view h1', { hasText: stalls.bram.variants!.protein_counter.name }).waitFor();
  expect(await page.locator('.stall-sign').textContent()).toBe('Protein Counter');
  const tips = (await page.locator('.stall-tip').allTextContents()).join(' ');
  expect(tips).not.toMatch(MEAT_WORDS);
  for (let i = 0; i < 6 && (await page.locator('.stall-round').count()) > 0; i++) {
    const id = (await currentQ(page))!;
    expect(id).toMatch(/^bram-pc-/);
    expect(await page.locator('.stall-round').textContent(), id).not.toMatch(MEAT_WORDS);
    await pick(page, 'right');
    expect(await page.locator('.stall-feedback').textContent(), id).not.toMatch(MEAT_WORDS);
    await page.locator('.stall-next').click();
  }
}

const CANVAS = [{ width: 400, canvas: false }, { width: 1280, canvas: true }] as const;
const noCanvas = (on: boolean) => async (page: Page) => { if (!on) await page.route('**/assets/phaser-*.js', (r) => r.abort()); };
const canvasErrors = (errors: string[], canvas: boolean) => errors.filter((e) => canvas || e !== 'Failed to load resource: net::ERR_FAILED');

describe('a market week (M6 Step 11)', () => {
  for (const { width, canvas } of CANVAS) {
    it(`signed out, AI off (${width} px, canvas ${canvas ? 'on' : 'off'}): the whole week, check-off by the scripted grammar`, async () => {
      app = await openApp('/#/stalls', {
        reducedMotion: true, width, seed: SEED(false),
        beforeGoto: async (page) => { await page.clock.install({ time: NOW }); await page.clock.resume(); await noCanvas(canvas)(page); },
      });
      const { page } = app;
      if (canvas) await page.waitForFunction(() => (window as unknown as { __kqScene?: string | null }).__kqScene === 'Market');
      else expect(await page.locator('#stage canvas').count()).toBe(0);
      await wenRounds(page, DEVICE);
      await theList(page);
      const tickedOnDevice = async (p: Page, key: string) => (await stored(p)).localWeek.runs[0]?.items.find((i) => i.key === key)?.ticked;
      await checkOffByGrammar(page, tickedOnDevice);
      await cookLabel(page);
      const addRule = async (rule: object) => {
        const s = await stored(page);
        await patch(page, { localRules: [...s.localRules, { ...rule, id: `r${s.localRules.length + 1}` } as PlayerState['localRules'][number]] });
        await page.reload();
      };
      await rulesChange(page, DEVICE, addRule, async () => null);
      await moveToKerala(page, async () => { await patch(page, { localProfile: KERALA }); await page.reload(); });
      await proteinCounter(page, addRule);
      expect(canvasErrors(app.consoleErrors, canvas)).toEqual([]);
    });
  }
});
