// M5 Step 12: the weekly loop, end to end (spec §12 "Playwright flows for … the weekly loop"), mocked /api/**, at
// 400 px and 1280 px. One run with the AI on (signed in, mocked turn responses) and one with the AI off and signed
// out (device storage), which then signs in and uploads with `upload: true` and shows no lower value (C14, C15).
//
// The week: market day Saturday, and frijoles de olla cooked last week (C27), so legumes, heat-control and patience
// are Tried and tempering is the technique on offer. Plan parippu on Sunday and two more → the weekly slot offers
// tempering → "Not this week" → the market list, three ticks, "That's the shop done" → Leela's quest to cook mode →
// "Just me", an "added lime" note, Log it, and the log undone (XP unchanged, no line of loss; the undo lives on the
// after-cook screen, so it comes before the book here) → the book shows parippu with the note and the date, and
// downloads → a coconut rule: the plan shows parippu ⛔ with Cook disabled, and level, stamps and trust are unchanged.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { ProgressEvent, ProgressView, RewardGrant } from '@kitchenquest/core/engine';
import { STORE_KEY, type PlayerState } from '../src/state/store';
import { expectNoA11yViolations, expectNoHorizontalScroll, openApp, type OpenedApp } from './helpers';
import { FRIJOLES, NOW, PARIPPU, WEEK, fakeApi, newFake } from './loop-fake';

const yaml = <T>(rel: string): T => parse(readFileSync(fileURLToPath(new URL(`../../../content/${rel}`, import.meta.url)), 'utf8')) as T;
const pan = yaml<{ triggers: Record<string, { lines: string[] }> }>('dialogue/pan.yaml');
const lines = (id: string) => pan.triggers[id].lines;
interface RiddleStep { type: 'riddle'; prompt: string; options: { text: string; correct: boolean }[] }
const leela = yaml<{ quest: { steps: ({ type: string } | RiddleStep)[] } }>('cooks/leela.yaml');
const riddle = leela.quest.steps.find((s): s is RiddleStep => s.type === 'riddle')!;

const LEELA_PIN = 'Visit Ammachi Leela — Kochi, Kerala, India';
const LAST_WEEK = '2026-11-10';
/** A line that speaks of a loss (Review Focus 2): none may follow an undo. */
const LOSS = /\b(lost|lose|loses|losing|loss|taken back|minus|deducted|penalt\w*|forfeit\w*)\b|-\s?\d+\s*XP/i;

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

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
/** Every grant the device holds, in every partition: what a meal-log undo must never take back. */
const deviceGrants = async (page: Page): Promise<RewardGrant[]> => {
  const s = await stored(page);
  return [...(s.progress?.grants ?? []), ...Object.values(s.accountProgress ?? {}).flatMap((p) => p.progress.grants)];
};
const xpOf = (gs: RewardGrant[]) => gs.filter((g) => g.kind === 'xp').reduce((n, g) => n + (g as Extract<RewardGrant, { kind: 'xp' }>).amount, 0);
const card = async (page: Page) => {
  const c = page.locator('.apprentice-card');
  await c.waitFor();
  return { level: await c.locator('.apprentice-level').textContent(), stamps: await c.locator('.apprentice-stamps').textContent() };
};

/** Frijoles de olla, cooked last week (C27): legumes, heat-control and patience are Tried. */
const priorCook: ProgressEvent = { id: randomUUID(), kind: 'cooked', at: LAST_WEEK, recipe: FRIJOLES, planned: false };
const priorGrant: RewardGrant = { id: `${priorCook.id}#0`, eventId: priorCook.id, isoDay: LAST_WEEK, kind: 'xp', amount: 30, reason: 'cook' } as RewardGrant;
const tried = (lastUsedAt: string) => ({ tier: 'tried' as const, firstAt: lastUsedAt, lastUsedAt, recipes: [FRIJOLES] });
/** The account's own view of last week's cook (the signed-in run's GET /progress). */
const ACCOUNT_VIEW: ProgressView = {
  xp: 30, level: 1, stamps: 0, trust: {},
  toolkit: { techniques: { legumes: tried(LAST_WEEK), 'heat-control': tried(LAST_WEEK), patience: tried(LAST_WEEK) } },
  questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: { [FRIJOLES]: [LAST_WEEK] }, framesCookedOn: {},
};
const settings = (aiMentor: boolean) => ({ showCalories: false, reducedMotion: 'system' as const, familyTable: false, iosNoteDismissed: false, aiMentor, rescueNudges: false });
const BASE: Partial<PlayerState> = {
  intake: { step: 'done' }, aiDisclosureSeen: true, firstOpenedAt: NOW.toISOString(), lastOpenedAt: NOW.toISOString(),
};

/** Click through dialogue and answer quest panels until `until` holds. */
async function playUntil(page: Page, answer: (panel: string) => string, until: () => Promise<boolean>) {
  for (let i = 0; i < 160; i += 1) {
    if (await until()) return;
    const panel = page.locator('.quest-panel');
    if (await panel.count()) {
      const text = (await panel.textContent()) ?? '';
      await panel.getByRole('button', { name: answer(text), exact: true }).click();
      continue;
    }
    const next = page.locator('.dialogue .dialogue-next');
    if (await next.count()) { await next.click(); continue; }
    await page.waitForTimeout(50);
  }
  throw new Error('the quest never got there');
}

/** Leela's quest from the map to the end of cook mode; the certificate's Continue leads to the after-cook questions. */
async function cookLeelasQuest(page: Page) {
  await go(page, '#/map');
  await page.getByRole('button', { name: LEELA_PIN }).click();
  await page.getByRole('button', { name: 'Stamp it ✔' }).click();
  await page.waitForFunction(() => location.hash === '#/visit/leela');
  await playUntil(page, (panel) => {
    if (panel.includes(riddle.prompt)) return riddle.options.find((o) => o.correct)!.text;
    if (panel.includes('Fetch')) return "I've got it";
    return "I've practised it";
  }, async () => (await page.getByRole('dialog', { name: /Parippu/ }).count()) > 0);
  await page.getByRole('dialog', { name: /Parippu/ }).getByRole('button', { name: /Cook it/ }).click();
  await page.waitForFunction((s) => location.hash === `#/cook/${s}`, PARIPPU);
  await page.locator('.cook-progress').waitFor();
  for (let i = 0; i < 12 && (await page.getByRole('button', { name: /^Done/ }).count()) === 0; i++) await page.getByRole('button', { name: /Next step/ }).click();
  await page.getByRole('button', { name: /^Done/ }).click();
  await page.getByRole('dialog', { name: /Certificate of a Dish Cooked/ }).getByRole('button', { name: 'Continue' }).click();
}

/** Plan by telling the Pan, tap the plan card; then the plan screen's weekly slot offers tempering; "Not this week". */
async function planTheWeek(page: Page, said: string) {
  await page.locator('#pan-button').click();
  await tell(page, said);
  const slip = page.locator('#pan-panel .pan-card[data-kind="plan"]');
  await slip.waitFor();
  expect(await slip.locator(`.plan-item[data-slug="${PARIPPU}"] .chip`).getAttribute('data-status')).toBe('ok');
  expect(await slip.locator('.plan-item').count()).toBe(3);
  await slip.getByRole('button', { name: 'Plan it ✔' }).click();
  await page.locator('#pan-panel .trail-entry').waitFor();
  await page.keyboard.press('Escape');

  await go(page, '#/plan');
  await page.locator(`.plan-item[data-slug="${PARIPPU}"]`).waitFor();
  const slot = page.locator('.plan-slot');
  await slot.waitFor();
  expect(await slot.textContent()).toMatch(/tempering/i);
  await expectNoA11yViolations(page, 'plan screen with the weekly slot');
  await expectNoHorizontalScroll(page);
  await slot.getByRole('button', { name: 'Not this week' }).click();
  await page.locator('.plan-slot').waitFor({ state: 'detached' });
  expect(lines('one_more.declined')).toContain(await page.locator('#plan-status').textContent());
}

/** The market list: tick three items, then "That's the shop done". */
async function shop(page: Page) {
  await go(page, '#/market');
  await page.locator('.market-tick').first().waitFor();
  await expectNoHorizontalScroll(page);
  const keys = (await page.locator('.market-tick').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')!))).slice(0, 3);
  for (const key of keys) {
    await page.locator(`.market-tick[data-key="${key}"]`).click();
    await page.locator(`.market-tick[data-key="${key}"]:checked`).waitFor();
  }
  await page.getByRole('button', { name: "That's the shop done" }).click();
  await expect.poll(async () => lines('market.run_done').includes((await page.locator('.week-note').textContent()) ?? '')).toBe(true);
}

/** After the cooking, signed in: "Just me", an "added lime" note, Log it, then the log undone. */
async function afterCookSignedIn(page: Page) {
  const who = page.locator('.bureau-slip[data-kind="cooked_for"]');
  await who.waitFor();
  await who.getByRole('button', { name: 'Just me' }).click();
  await who.getByRole('button', { name: 'Stamp it ✔' }).click();
  await expect.poll(async () => (await page.locator('.after-cook-line').allTextContents()).some((t) => lines('cooked_for.alone').includes(t))).toBe(true);

  await page.locator('.note-form').waitFor();
  await page.locator('.note-text').fill('added lime');
  await page.getByRole('button', { name: 'Read it back' }).click();
  await page.locator('.bureau-slip[data-kind="margin_note"]').getByRole('button', { name: 'Write it in ✔' }).click();

  const log = page.locator('.bureau-slip[data-kind="meal"]');
  await log.waitFor();
  await log.getByRole('button', { name: 'Log it' }).click();
  await page.locator('.after-cook-step', { hasText: 'Log it?' }).getByRole('button', { name: /Undo/ }).waitFor();
  await expectNoA11yViolations(page, 'after cook, logged');
  const before = await deviceGrants(page);
  expect(xpOf(before)).toBeGreaterThan(30);
  await page.locator('.after-cook-step', { hasText: 'Log it?' }).getByRole('button', { name: /Undo/ }).click();
  await page.locator('.after-cook-step', { hasText: 'Log it?' }).getByRole('button', { name: /Undo/ }).waitFor({ state: 'detached' });
  await page.waitForTimeout(300);
  // Nothing earned is taken back: every grant held before the undo is still held, and XP is no lower.
  const after = await deviceGrants(page);
  expect(after.map((g) => g.id)).toEqual(expect.arrayContaining(before.map((g) => g.id)));
  expect(xpOf(after)).toBeGreaterThanOrEqual(xpOf(before));
  for (const t of await page.locator('.after-cook').allInnerTexts()) expect(t).not.toMatch(LOSS);
}

/** A coconut rule from the rules screen's form: the plan shows parippu ⛔ with Cook disabled. */
async function addCoconutRule(page: Page) {
  await go(page, '#/rules');
  await page.getByRole('button', { name: 'Add a rule' }).click();
  await page.locator('#rule-search').fill('cocon');
  await page.locator('.rule-form-option', { hasText: /^coconut$/ }).first().click();
  await page.getByRole('button', { name: 'Fill in Form 27-B' }).click();
  await page.locator('.rules-card .pan-card').getByRole('button', { name: 'Stamp it ✔' }).click();
  await go(page, '#/plan');
  const row = page.locator(`.plan-item[data-slug="${PARIPPU}"]`);
  await row.waitFor();
  await expect.poll(() => row.getAttribute('data-status')).toBe('blocked');
  expect(await row.locator('.chip').getAttribute('data-status')).toBe('blocked');
  expect(await row.getByRole('button', { name: /^Cook/ }).isDisabled()).toBe(true);
}

/** The book: parippu with its date (and the note, signed in); the download holds the same, and no script or link. */
async function readTheBook(page: Page, note: boolean) {
  await go(page, '#/book');
  await page.locator(`.book-index-item[data-slug="${PARIPPU}"]`).waitFor();
  await page.locator(`.book-index-item[data-slug="${PARIPPU}"] a`).click();
  await page.locator('.book-techniques').waitFor();
  const text = (await page.locator('#view').textContent())!;
  expect(text).toMatch(/14 November 2026|2026-11-14|November 14/);
  if (note) expect(await page.locator('.book-note-text').allTextContents()).toEqual([expect.stringContaining('lime')]);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download my book' }).click()]);
  const html = readFileSync((await download.path())!, 'utf8');
  expect(html).not.toMatch(/<script|https?:\/\//i);
  expect(html).toContain('Parippu');
  if (note) expect(html).toContain('lime');
}

describe('the weekly loop (M5 Step 12)', () => {
  for (const width of [1280, 400]) {
    it(`AI on, signed in (${width} px): plan by the Pan, the slot, the market, Leela's quest, after-cook, the book, a rule`, async () => {
      const fake = newFake();
      app = await openApp('/#/kitchen', {
        reducedMotion: true, width, seed: { ...BASE, settings: settings(true) },
        beforeGoto: async (page) => {
          await page.clock.install({ time: NOW });
          await page.clock.resume();
          await fakeApi(page, fake, { view: ACCOUNT_VIEW });
        },
      });
      const { page } = app;
      await expect.poll(async () => (await stored(page)).account ?? null).not.toBeNull();
      const start = await card(page);

      await planTheWeek(page, 'Plan my week: parippu on Sunday, pick two more');
      expect(fake.plan?.slot).toBe('declined');
      expect(fake.plan?.items.map((i) => i.slug)).toEqual([PARIPPU, 'japan/osaka/onigiri', FRIJOLES]);
      await shop(page);
      expect(fake.requests.filter((r) => /\/ticks$/.test(new URL(r.url()).pathname))).toHaveLength(3);
      expect(fake.events.filter((e) => e.kind === 'market_run')).toHaveLength(1);

      await cookLeelasQuest(page);
      await afterCookSignedIn(page);
      // The undo is DELETE /meals/:id: no meal log is left, so any meal_logged event already sent went with it (Step 5 I1).
      expect(fake.meals).toEqual([]);
      expect(fake.requests.filter((r) => r.method() === 'DELETE' && new URL(r.url()).pathname.startsWith('/api/meals/'))).toHaveLength(1);
      await page.getByRole('button', { name: 'Back to the kitchen' }).click();
      await page.waitForFunction(() => location.hash === '#/kitchen');
      const cooked = await card(page);
      expect(cooked).not.toEqual(start);

      await readTheBook(page, true);
      const held = await deviceGrants(page);
      await addCoconutRule(page);
      expect(fake.rules).toHaveLength(1);
      await go(page, '#/kitchen');
      expect(await card(page)).toEqual(cooked);
      // A rule that blocks a cooked dish takes back nothing: every grant (XP, stamps, trust, level) is still held.
      expect((await deviceGrants(page)).map((g) => g.id)).toEqual(expect.arrayContaining(held.map((g) => g.id)));
      expect(held.some((g) => g.kind === 'trust')).toBe(true);
      expect((await stored(page)).accountProgress).toBeDefined();
      expect(fake.uploads.every((u) => !u)).toBe(true); // live events, never an upload
      expect(app.consoleErrors).toEqual([]);
    });

    it(`AI off, signed out (${width} px): the same week on the device; then sign in, upload, and nothing shown drops`, async () => {
      let signedIn = false;
      const fake = newFake();
      const seed: Partial<PlayerState> = {
        ...BASE, settings: settings(false),
        localProfile: { marketDays: [6], mealsPerWeek: null, country: null, region: null, mealWindows: [] },
        progress: { events: [priorCook], grants: [priorGrant], base: null, pendingUpload: [priorCook.id] },
      };
      app = await openApp('/#/kitchen', {
        reducedMotion: true, width, seed,
        beforeGoto: async (page) => {
          await page.clock.install({ time: NOW });
          await page.clock.resume();
          await fakeApi(page, fake, { view: ACCOUNT_VIEW });
          await page.route((u) => u.pathname.startsWith('/api/'), (route) => (signedIn ? route.fallback() : route.fulfill(json(401, { error: { code: 'unauthorized', message: 'Sign in required' } }))));
        },
      });
      const { page } = app;
      const start = await card(page);

      // The scripted grammar is closed (Step 8 rulings 5a/N6): "pick two more" is not one of its clauses, so the AI-off
      // run says "pick two". Widening it changes eval-hashed decision code (Ruling N8) and needs an eval run.
      await planTheWeek(page, 'Plan my week: parippu on Sunday, pick two');
      expect((await stored(page)).localWeek.plans[0]).toMatchObject({ weekStart: WEEK, slot: 'declined' });
      await shop(page);
      expect((await stored(page)).localPantry.filter((p) => p.source === 'market')).toHaveLength(3);

      await cookLeelasQuest(page);
      // Signed out: nowhere to keep the account-only answers; each says so, with nothing to press but "Back".
      await page.locator('.after-cook').waitFor();
      const after = (await page.locator('.after-cook').textContent())!;
      expect(lines('log.needs_account').some((l) => after.includes(l))).toBe(true);
      expect(await page.locator('.after-cook .bureau-slip, .after-cook textarea, .after-cook input').count()).toBe(0);
      await page.getByRole('button', { name: 'Back to the kitchen' }).click();
      await page.waitForFunction(() => location.hash === '#/kitchen');
      const cooked = await card(page);
      expect(cooked).not.toEqual(start);

      await readTheBook(page, false);
      const held = await deviceGrants(page);
      await addCoconutRule(page);
      await go(page, '#/kitchen');
      expect(await card(page)).toEqual(cooked);
      expect((await deviceGrants(page)).map((g) => g.id)).toEqual(expect.arrayContaining(held.map((g) => g.id)));
      expect(held.some((g) => g.kind === 'trust')).toBe(true);
      const device = await stored(page);
      const ids = device.progress.events.map((e) => e.id);
      expect(ids).toContain(priorCook.id);
      expect(fake.requests.map((r) => new URL(r.url()).pathname).filter((p) => p !== '/api/me')).toEqual([]);

      // Sign in. Nothing goes up by itself (C1 ruling); the tap uploads every device event with upload: true (C14),
      // the seeded last-week cook included, and the card shows the field-wise max (C15): nothing drops.
      signedIn = true;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      const offer = page.getByRole('region', { name: "Add this device's progress to your account?" });
      await offer.waitFor();
      expect(fake.events).toEqual([]);
      await offer.getByRole('button', { name: 'Add it to my account' }).click();
      await page.waitForFunction((k) => (JSON.parse(localStorage.getItem(k)!) as PlayerState).progress.pendingUpload.length === 0, STORE_KEY);
      expect(fake.uploads.length).toBeGreaterThan(0);
      expect(fake.uploads.every((u) => u)).toBe(true);
      expect(fake.events.map((e) => e.id)).toEqual(expect.arrayContaining(ids));
      await offer.waitFor({ state: 'detached' });
      await page.locator('.apprentice-stamps', { hasText: cooked.stamps! }).waitFor();
      expect(await card(page)).toEqual(cooked);
      expect(app.consoleErrors).toEqual([]);
    });
  }
});
