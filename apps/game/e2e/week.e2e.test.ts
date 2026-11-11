import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Request } from 'playwright';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { UNDO_WINDOW_MS } from '@kitchenquest/core/engine';
import type { PlayerState } from '../src/state/store';
import { expectNoA11yViolations, expectNoHorizontalScroll, openApp, PAN_READY, type OpenedApp } from './helpers';

const pan = parse(readFileSync(fileURLToPath(new URL('../../../content/dialogue/pan.yaml', import.meta.url)), 'utf8')) as { triggers: Record<string, { lines: string[] }> };
const lines = (id: string) => pan.triggers[id].lines;

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const stored = (page: Page): Promise<PlayerState> => page.evaluate(() => JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as PlayerState);
const go = async (page: Page, hash: string) => { await page.evaluate((h) => { location.hash = h; }, hash); };
const tell = async (page: Page, text: string) => {
  const before = await page.locator('#pan-panel .bubble.pan').count();
  await page.locator('#pan-text').fill(text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#pan-panel .bubble.pan').length > n, before);
};
const localDay = (page: Page, offset = 0) => page.evaluate((o) => {
  const d = new Date(Date.now() + o * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}, offset);

describe('the week (M5 Step 10)', () => {
  it('AI off + signed out: plan by telling the Pan → list → tick → cook a frame from a rescue', async () => {
    app = await openApp('/#/settings', { reducedMotion: true, seed: PAN_READY });
    const { page } = app;
    await page.locator('#pan-button').click();
    await tell(page, 'plan my week: parippu on Sunday');
    const card = page.locator('#pan-panel .pan-card[data-kind="plan"]');
    await card.waitFor();
    expect(await card.textContent()).toContain('7-W');
    expect(await card.locator('.plan-item .chip').getAttribute('data-status')).toBe('ok');
    await card.getByRole('button', { name: 'Plan it ✔' }).click();
    await page.locator('#pan-panel .trail-entry').waitFor();
    expect(await page.locator('#pan-panel .trail-text').textContent()).toMatch(/^🗓 Planned: /);
    const s1 = await stored(page);
    expect(s1.localWeek.plans).toHaveLength(1);
    expect(s1.localWeek.plans[0].items).toEqual([expect.objectContaining({ kind: 'dish', slug: 'india/kerala/parippu' })]);
    // "dal" is never a guess (C1).
    await tell(page, 'dal on Sunday');
    const said = await page.locator('#pan-panel .bubble.pan .bubble-text').last().textContent();
    expect(lines('plan.dish_unknown').map((l) => l.replace('{dish}', 'dal'))).toContain(said);
    await page.keyboard.press('Escape');

    // The plan screen: the same week, from the device.
    await go(page, '#/plan');
    await page.locator('.plan-item[data-slug="india/kerala/parippu"]').waitFor();
    await expectNoA11yViolations(page, 'plan screen');

    // The market list: grouped by stall, ticking puts the item in the pantry with today's date.
    await go(page, '#/market');
    const box = page.locator('.market-tick').first();
    await box.waitFor();
    await expectNoA11yViolations(page, 'market list');
    await box.check();
    await expect.poll(async () => (await stored(page)).localPantry.filter((p) => p.source === 'market').length).toBe(1);
    const today = await localDay(page);
    expect((await stored(page)).localPantry[0]).toMatchObject({ addedOn: today, source: 'market' });
    await page.getByRole('button', { name: "That's the shop done" }).click();
    await expect.poll(() => page.locator('.week-note').textContent()).toMatch(/\S/);
    expect(lines('market.run_done')).toContain(await page.locator('.week-note').textContent());
    expect((await stored(page)).localWeek.runs[0].doneAt).not.toBeNull();

    // Use-It-Up: spinach bought two days ago, with rice and oil told to the Pan.
    const twoDaysAgo = await localDay(page, -2);
    await page.evaluate((d) => {
      const s = JSON.parse(localStorage.getItem('kq.player.v1')!) as PlayerState;
      s.localPantry = [
        ...s.localPantry,
        { id: 'sp', name: 'spinach', ingredientId: 'spinach', addedOn: d, source: 'market' },
        { id: 'rice', name: 'cooked rice', ingredientId: 'cooked_rice' },
        { id: 'oil', name: 'sunflower oil', ingredientId: 'neutral_oil' },
      ];
      localStorage.setItem('kq.player.v1', JSON.stringify(s));
    }, twoDaysAgo);
    await go(page, '#/kitchen');
    await page.reload();
    const rescue = page.locator('.rescue');
    await rescue.waitFor();
    expect(await rescue.textContent()).toContain('spinach');
    await expectNoA11yViolations(page, 'rescue offer');
    await rescue.getByRole('button', { name: 'Cook the frame' }).click();
    const cook = page.locator('.frame-cook');
    await cook.waitFor();
    await expectNoA11yViolations(page, 'frame slot picker');
    expect(await cook.isDisabled()).toBe(false);
    await cook.click();
    const next = page.getByRole('button', { name: /Next step|Done/ });
    for (let i = 0; i < 10 && (await page.getByRole('button', { name: 'Done ▶' }).count()) === 0; i++) await next.click();
    expect(await page.locator('.cook-text').textContent()).toBeTruthy();
    await page.getByRole('button', { name: 'Done ▶' }).click();
    await page.locator('#overlay-root [role="dialog"]').waitFor();
    // The nudge was answered: none again today.
    const s2 = await stored(page);
    expect(s2.rescue.guest).toMatchObject({ on: today, answered: true }); // M5 final m11: per partition
    expect(app.requests.filter((u) => new URL(u).pathname.startsWith('/api/') && new URL(u).pathname !== '/api/me')).toEqual([]);
    expect(app.consoleErrors).toEqual([]);
  });

  it('the week screens are readable at 320 px with no sideways scroll', async () => {
    app = await openApp('/#/plan', { reducedMotion: true, width: 320, seed: PAN_READY });
    const { page } = app;
    await page.locator('.plan-day').first().waitFor();
    await expectNoHorizontalScroll(page);
    await go(page, '#/market');
    await page.locator('.market-body').waitFor();
    await expectNoHorizontalScroll(page);
    await go(page, '#/frame/green-sauce');
    await page.locator('.frame-cook').waitFor();
    await expectNoHorizontalScroll(page);
    expect(await page.locator('.frame-cook').isDisabled()).toBe(true); // nothing I can check fits a required slot
    expect(await page.locator('.frame-nothing').first().textContent()).toContain('nothing I can check fits');
  });

  it('AI on (mocked): a plan card from /mentor/turn, confirmed by one tap that sends today', async () => {
    const card = {
      kind: 'plan', weekStart: '2026-11-09', items: [{ day: 6, kind: 'dish', slug: 'india/kerala/parippu', servings: 3 }], hard: false,
      checks: [{ slug: 'india/kerala/parippu', status: 'ok' }], unknown: [], dropped: [], offer: null, summary: 'Sunday: Parippu Curry.',
      added: [{ day: 6, kind: 'dish', slug: 'india/kerala/parippu', servings: 3 }], basis: '00000000',
      readback: [{ trigger: 'plan.readback', vars: { summary: 'Sunday: Parippu Curry' } }],
    };
    const confirms: Request[] = [];
    app = await openApp('/#/settings', {
      reducedMotion: true, seed: PAN_READY,
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
        await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, { consents: [], needsReconsent: [], notices: {} })));
        await page.route((u) => u.pathname === '/api/progress', (r) => r.fulfill(json(200, { view: null })));
        await page.route((u) => u.pathname === '/api/mentor/turn', (r) => r.fulfill(json(200, {
          conversationId: 'c1', route: 'deterministic', notice: null, toolTurn: false, actions: [],
          parts: [{ kind: 'line', line: card.readback[0] }, { kind: 'go', target: { to: 'market' }, line: { trigger: 'nav.offer', vars: { place: 'the market list' } } }],
          cards: [{ proposalId: 'P1', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), card }],
        })));
        await page.route((u) => u.pathname === '/api/mentor/proposals/P1/confirm', (r) => {
          confirms.push(r.request());
          return r.fulfill(json(200, {
            trail: { id: 'P1', origin: 'server', kind: 'plan', summary: card.summary, undoUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString() },
            parts: [{ kind: 'line', line: { trigger: 'plan.saved', vars: {} } }],
          }));
        });
      },
    });
    const { page } = app;
    await expect.poll(async () => (await stored(page)).account ?? null).not.toBeNull();
    await page.locator('#pan-button').click();
    await tell(page, 'plan my week: parippu on Sunday');
    const slip = page.locator('#pan-panel .pan-card[data-kind="plan"]');
    await slip.waitFor();
    // The chip is drawn, and nothing moved by itself.
    const chip = page.locator('#pan-panel .pan-go');
    await chip.waitFor();
    expect(await page.evaluate(() => location.hash)).toBe('#/settings');
    await slip.getByRole('button', { name: 'Plan it ✔' }).dblclick();
    await page.locator('#pan-panel .trail-entry').waitFor();
    expect(confirms).toHaveLength(1);
    expect(confirms[0].postDataJSON()).toEqual({ channel: 'tap', conversationId: 'c1', today: await localDay(page) });
    await chip.click();
    expect(await page.evaluate(() => location.hash)).toBe('#/market');
  });

  it('signed in, a plan write without health_data consent shows the consent card', async () => {
    app = await openApp('/#/plan', {
      reducedMotion: true, seed: PAN_READY,
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
        await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, { consents: [], needsReconsent: [], notices: { health_data: { version: 'v3', text: 'The health notice.' } } })));
        await page.route((u) => u.pathname === '/api/plans/current', (r) => r.fulfill(json(200, { plan: null, weekStart: '2026-11-09', checks: [] })));
        await page.route((u) => u.pathname.startsWith('/api/plans/2026'), (r) => r.fulfill(json(403, { error: { code: 'consent_required', message: '', details: { purpose: 'health_data' } } })));
      },
    });
    const { page } = app;
    await expect.poll(async () => (await stored(page)).account ?? null).not.toBeNull();
    await page.reload();
    await page.locator('.plan-save').waitFor();
    await page.locator('.plan-save').click();
    await page.locator('#pan-panel .pan-consent-item').waitFor();
    expect(new URL(page.url(), inject('baseUrl')).hash).toBe('#/plan');
  });

  it('Ruling 2: signed in with a week planned on this device, "Move it" puts it on the account and takes it off the device', async () => {
    const puts: unknown[] = [];
    app = await openApp('/#/settings', {
      reducedMotion: true,
      seed: { ...PAN_READY, localWeek: { plans: [{ weekStart: '2026-11-09', items: [{ day: 6, kind: 'dish', slug: 'india/kerala/parippu', servings: 3 }], hard: false, slot: 'unanswered' }], runs: [] } },
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
        await page.route((u) => u.pathname === '/api/plans/current', (r) => r.fulfill(json(200, { plan: null, weekStart: '2026-11-09', checks: [] })));
        await page.route((u) => u.pathname === '/api/plans/2026-11-09', (r) => {
          const body = r.request().postDataJSON() as { plan: unknown };
          puts.push(body);
          return r.fulfill(json(200, { plan: { ...(body.plan as object), id: 'row' }, checks: [] }));
        });
      },
    });
    const { page } = app;
    await expect.poll(async () => (await stored(page)).account ?? null).not.toBeNull();
    await go(page, '#/plan');
    const offer = page.locator('.week-move-offer');
    await offer.waitFor();
    // Nothing moves by itself.
    expect(puts).toEqual([]);
    await expectNoA11yViolations(page, 'move offer');
    await offer.getByRole('button', { name: 'Move it' }).click();
    await expect.poll(async () => (await stored(page)).localWeek.plans.length).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ confirmed: true, today: await localDay(page), plan: { weekStart: '2026-11-09', items: [{ day: 6, slug: 'india/kerala/parippu' }] } });
  });
});
