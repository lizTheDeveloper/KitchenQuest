import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { readFileSync } from 'node:fs';
import type { ProgressView } from '@kitchenquest/core/engine';
import { openApp, PAN_READY, type OpenedApp } from './helpers';
import { NOW, PARIPPU, WEEK, fakeApi, newFake } from './loop-fake';

// M4 Step 12: free forever (§16, never rule 1). A signed-in player whose AI chat is capped
// (`/api/mentor/turn` answers scripted + rate_limited) still files an allergy, logs a meal and gets
// the dish blocked, and nothing on any screen sells.

/** step-12.md's sells pattern. */
const SELLS = /\b(guild|upgrade|subscri\w*|premium)\b|\$\s?\d/i;

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const BOTH_CONSENTS = {
  consents: ['health_data', 'ai_health'].map((purpose) => ({ purpose, noticeVersion: purpose === 'health_data' ? 'v3' : 'v1', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true })),
  needsReconsent: [], notices: {},
};
const panBubbles = (page: Page) => page.locator('#pan-panel .bubble.pan');
async function tell(page: Page, text: string) {
  const before = await panBubbles(page).count();
  await page.locator('#pan-text').fill(text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#pan-panel .bubble.pan').length > n, before);
}
const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

describe('free forever (§16)', () => {
  it('capped (scripted + rate_limited): an allergy is stamped, a meal is logged, the parippu card is blocked, nothing sells', async () => {
    const rules: { id: string; target: { kind: string; ids: string[] }; type: string; severity: string }[] = [];
    const meals: unknown[] = [];
    let turns = 0;
    app = await openApp('/#/settings', {
      reducedMotion: true,
      seed: PAN_READY,
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, BOTH_CONSENTS)));
        await page.route((u) => u.pathname === '/api/rules', (r) => {
          if (r.request().method() !== 'POST') return r.fulfill(json(200, { rules }));
          const body = r.request().postDataJSON() as { rule: Omit<(typeof rules)[number], 'id'> };
          const rule = { ...body.rule, id: `s${rules.length + 1}` };
          rules.push(rule);
          return r.fulfill(json(201, { rule }));
        });
        await page.route((u) => u.pathname === '/api/meals', (r) => {
          if (r.request().method() !== 'POST') return r.fulfill(json(200, { meals: [] }));
          const { meal } = r.request().postDataJSON() as { meal: object };
          const saved = { ...meal, id: `m${meals.length + 1}` };
          meals.push(saved);
          return r.fulfill(json(201, { meal: saved }));
        });
        await page.route((u) => u.pathname === '/api/mentor/turn', (r) => {
          turns++;
          return r.fulfill(json(200, { conversationId: null, route: 'scripted', parts: [], cards: [], actions: [], notice: 'rate_limited', toolTurn: false }));
        });
      },
    });
    const { page } = app;
    await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as { account?: unknown }).account ?? null)).not.toBeNull();
    await page.locator('#pan-button').click();

    await tell(page, "I'm allergic to coconut");
    const ruleCard = page.locator('#pan-panel .pan-card').filter({ hasText: 'C-O-C-O-N-U-T' });
    await ruleCard.waitFor();
    await ruleCard.getByRole('button', { name: 'Stamp it ✔' }).click();
    await expect.poll(() => rules.length).toBe(1);
    expect(rules[0]).toMatchObject({ target: { ids: ['coconut'] }, type: 'avoid' });

    await tell(page, 'had toast for breakfast');
    const mealCard = page.locator('#pan-panel .pan-card').filter({ hasText: /toast/i });
    await mealCard.waitFor();
    await mealCard.getByRole('button', { name: 'Log it' }).click();
    await expect.poll(() => meals.length).toBe(1);
    expect(meals[0]).toMatchObject({ slot: 'breakfast', item: { kind: 'free', description: expect.stringMatching(/toast/i) } });

    expect(turns).toBeGreaterThanOrEqual(2); // both went to the server, which said "capped": the script answered
    const panelText = await bodyText(page);
    expect(panelText).not.toMatch(SELLS);

    await page.keyboard.press('Escape');
    await page.evaluate(() => { location.hash = '#/recipe/india/kerala/parippu'; });
    await page.locator('.recipe-card .recipe-status .chip[data-status="blocked"]').waitFor();
    expect(await bodyText(page)).not.toMatch(SELLS);
    for (const hash of ['#/', '#/rules', '#/settings', '#/recipes']) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForFunction((h) => location.hash === h, hash);
      await page.waitForTimeout(150);
      expect(await bodyText(page), hash).not.toMatch(SELLS);
    }
    expect(app.consoleErrors).toEqual([]);
  });

  it('M5: capped, AI off, no entitlements: the plan, the market, the rescue, a quest, cook → log, the book and its export, and delete', async () => {
    const view: ProgressView = { xp: 0, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {} };
    const pantry = [
      { id: 'sp', name: 'spinach', ingredientId: 'spinach', addedOn: '2026-11-12', source: 'market' },
      { id: 'rice', name: 'cooked rice', ingredientId: 'cooked_rice' },
      { id: 'oil', name: 'sunflower oil', ingredientId: 'neutral_oil' },
    ];
    const fake = newFake();
    const settings = { showCalories: false, reducedMotion: 'system' as const, familyTable: false, iosNoteDismissed: false, aiMentor: false, rescueNudges: true };
    app = await openApp('/#/plan', {
      reducedMotion: true, seed: { ...PAN_READY, settings },
      beforeGoto: async (page) => {
        await page.clock.install({ time: NOW });
        await page.clock.resume();
        await fakeApi(page, fake, { view, pantry, turn: 'capped' });
      },
    });
    const { page } = app;
    const go = async (hash: string) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForFunction((h) => location.hash === h, hash); };
    const noSale = async (where: string) => { await page.waitForTimeout(150); expect(await bodyText(page), where).not.toMatch(SELLS); };
    await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as { account?: unknown }).account ?? null)).not.toBeNull();

    // The plan, on Form 7-W (Ruling 27: the form plans whatever the chat allowance says).
    await page.reload();
    await page.locator('#plan-add-1').waitFor();
    await page.locator('#plan-add-1').selectOption(PARIPPU);
    await page.locator('#plan-add-btn-1').click();
    await page.locator(`.plan-item[data-slug="${PARIPPU}"]`).waitFor();
    await page.locator('.plan-save').click();
    await expect.poll(() => fake.plan?.items.map((i) => i.slug) ?? []).toEqual([PARIPPU]);
    expect(fake.plan?.weekStart).toBe(WEEK);
    await noSale('#/plan');

    // The market run: a tick, then the shop done.
    await go('#/market');
    const first = page.locator('.market-tick').first();
    await first.waitFor();
    const key = await first.getAttribute('data-key');
    await first.click();
    await page.locator(`.market-tick[data-key="${key}"]:checked`).waitFor();
    await page.getByRole('button', { name: "That's the shop done" }).click();
    await expect.poll(() => fake.events.filter((e) => e.kind === 'market_run').length).toBe(1);
    await noSale('#/market');

    // The rescue, in the kitchen.
    await go('#/kitchen');
    await page.locator('.rescue').waitFor();
    expect(await page.locator('.rescue').textContent()).toContain('spinach');
    await noSale('#/kitchen');

    // A quest, to cook mode; cook → log.
    await go('#/visit/leela');
    for (let i = 0; i < 160 && (await page.getByRole('dialog', { name: /Parippu/ }).count()) === 0; i++) {
      const panel = page.locator('.quest-panel');
      if (await panel.count()) {
        const t = (await panel.textContent()) ?? '';
        const name = /Mustard seeds/.test(t) ? /Mustard seeds/ : t.includes('Fetch') ? "I've got it" : "I've practised it";
        await panel.getByRole('button', { name }).first().click();
        continue;
      }
      if (await page.locator('.dialogue .dialogue-next').count()) { await page.locator('.dialogue .dialogue-next').click(); continue; }
      await page.waitForTimeout(50);
    }
    await page.getByRole('dialog', { name: /Parippu/ }).getByRole('button', { name: /Cook it/ }).click();
    await page.locator('.cook-progress').waitFor();
    for (let i = 0; i < 12 && (await page.getByRole('button', { name: /^Done/ }).count()) === 0; i++) await page.getByRole('button', { name: /Next step/ }).click();
    await page.getByRole('button', { name: /^Done/ }).click();
    await page.getByRole('dialog', { name: /Certificate of a Dish Cooked/ }).getByRole('button', { name: 'Continue' }).click();
    // Cooked for Someone and a margin note, for free (fix round 1, Minor 5).
    const who = page.locator('.bureau-slip[data-kind="cooked_for"]');
    await who.getByRole('button', { name: 'Just me' }).click();
    await who.getByRole('button', { name: 'Stamp it ✔' }).click();
    await page.locator('.note-text').fill('added lime');
    await page.getByRole('button', { name: 'Read it back' }).click();
    await page.locator('.bureau-slip[data-kind="margin_note"]').getByRole('button', { name: 'Write it in ✔' }).click();
    await expect.poll(() => fake.notes.length).toBe(1);
    expect(fake.requests.some((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/shared-table')).toBe(true);
    await page.locator('.bureau-slip[data-kind="meal"]').getByRole('button', { name: 'Log it' }).click();
    await expect.poll(() => fake.meals.length).toBe(1);
    // Progress posts are paced (Step 9: about one request a second), so the log's event can take a moment.
    await expect.poll(() => fake.events.filter((e) => e.kind === 'meal_logged').length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => fake.events.some((e) => e.kind === 'quest_done'), { timeout: 20_000 }).toBe(true);
    await noSale('after cook');

    // The book, and its export.
    await go(`#/book/${PARIPPU}`);
    await page.locator('.book-techniques').waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download my book' }).click()]);
    const html = readFileSync(await download.path(), 'utf8');
    expect(html).toContain('Parippu');
    expect(html).not.toMatch(SELLS);
    await noSale('#/book');

    // Delete: everything on this device goes, for free.
    await go('#/settings');
    await page.getByRole('button', { name: 'Delete Kitchen Quest data on this device' }).click();
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Delete everything' }).click()]);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as { localWeek?: { plans: unknown[] } })).not.toMatchObject({ localWeek: { plans: [{}] } });
    expect(app.consoleErrors).toEqual([]);
  });
});
