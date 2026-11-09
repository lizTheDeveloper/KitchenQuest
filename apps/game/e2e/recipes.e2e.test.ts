import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { expectNoA11yViolations, expectNoHorizontalScroll, openApp, type OpenedApp } from './helpers';

const DISCLAIMER = "Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels.";
const PARIPPU = '/#/recipe/india/kerala/parippu';
const coconutSevere = { id: 'r1', target: { kind: 'ingredient' as const, ids: ['coconut'] }, type: 'avoid' as const, severity: 'anaphylactic' as const };
const badId = { id: 'r1', target: { kind: 'ingredient' as const, ids: ['not_an_id'] }, type: 'avoid' as const, severity: 'allergy' as const };

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

const chip = (app: OpenedApp) => app.page.locator('.recipe-card .recipe-status .chip');

describe('recipe shelf and cards', () => {
  it('the shelf lists 3 recipes, each with a chip, and says no rules are on file', async () => {
    app = await openApp('/#/recipes', { width: 400 });
    const { page } = app;
    await page.locator('h1', { hasText: 'Recipe shelf' }).waitFor();
    const items = page.locator('.shelf-item');
    expect(await items.count()).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(await items.nth(i).locator('.chip').count()).toBe(1);
      expect(await items.nth(i).locator('a').getAttribute('href')).toMatch(/^#\/recipe\//);
    }
    expect(await page.textContent('body')).toContain("You haven't told the Bureau about any allergies or diet rules yet.");
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page, 'shelf');
    expect(app.consoleErrors).toEqual([]);
  });

  it('a severe coconut rule blocks parippu, with the disclaimer and a disabled Cook it', async () => {
    app = await openApp(PARIPPU, { seed: { v: 1, localRules: [coconutSevere] }, width: 400 });
    const { page } = app;
    await page.locator('.recipe-card').waitFor();
    expect((await chip(app).textContent())!.toLowerCase()).toContain('blocked');
    const body = (await page.textContent('body'))!;
    expect(body).toContain(DISCLAIMER);
    expect(body).toContain('cross-contact');
    expect(body).toContain('Checked against your 1 rule.');
    expect(await page.getByRole('button', { name: 'Cook it' }).isDisabled()).toBe(true);
    expect(body).toContain("This dish isn't cookable with your rules. It stays on your map.");
    expect(await page.locator('.finding', { hasText: 'grated coconut' }).textContent()).toContain(' → ');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page, 'blocked card');
    expect(app.consoleErrors).toEqual([]);
  });

  it('without rules Cook it is enabled and routes to cook mode', async () => {
    app = await openApp(PARIPPU);
    const { page } = app;
    await page.locator('.recipe-card').waitFor();
    expect(await chip(app).getAttribute('data-status')).toBe('ok');
    expect(await page.textContent('body')).toContain("You haven't told the Bureau about any allergies or diet rules yet.");
    expect(await page.textContent('body')).toContain('Draft — awaiting review by cooks from this tradition');
    const cook = page.getByRole('button', { name: 'Cook it' });
    expect(await cook.isEnabled()).toBe(true);
    await cook.click();
    await page.waitForFunction(() => location.hash === '#/cook/india/kerala/parippu');
    await expectNoA11yViolations(page, 'cook placeholder');
  });

  it('hides calories by default and shows them after Show calories in settings', async () => {
    app = await openApp(PARIPPU);
    const { page } = app;
    await page.locator('.nutrition caption', { hasText: 'Per serving' }).waitFor();
    expect(await page.textContent('body')).not.toContain('kcal');
    await page.goto(new URL('/#/settings', page.url()).toString());
    await page.getByLabel('Show calories').check();
    await page.goto(new URL(PARIPPU, page.url()).toString());
    await page.locator('.nutrition tr[data-nutrient="energy_kcal"]').waitFor();
    expect(await page.textContent('.nutrition')).toContain('kcal');
  });

  it('rules core rejects: the card says it could not check, and shows ❓ not ✅', async () => {
    app = await openApp(PARIPPU, { seed: { v: 1, localRules: [badId] } });
    const { page } = app;
    await page.locator('.recipe-card').waitFor();
    expect(await page.textContent('body')).toContain("Couldn't check this dish against your rules. Treat it as unchecked.");
    expect(await chip(app).getAttribute('data-status')).toBe('unverified');
    expect(await chip(app).textContent()).toContain('❓');
    expect(await page.textContent('body')).toContain(DISCLAIMER);
    expect(await page.getByRole('button', { name: 'Cook it' }).isEnabled()).toBe(true);
    await expectNoA11yViolations(page, 'unverified card');
  });

  it('unreadable saved data: every shelf entry is ❓, never ✅', async () => {
    app = await openApp('/#/recipes', { seed: { v: 2 } as never }); // a version this build can't read
    const { page } = app;
    await page.locator('.shelf-item').first().waitFor();
    const statuses = await page.locator('.shelf-item .chip').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')));
    expect(statuses).toEqual(['unverified', 'unverified', 'unverified']);
    expect(await page.textContent('#view')).not.toContain('✅');
    expect(await page.textContent('body')).toContain("Couldn't check these dishes against your rules.");
    await page.locator('.shelf-item a').first().click();
    await page.locator('.recipe-card').waitFor();
    expect(await chip(app).getAttribute('data-status')).toBe('unverified');
  });

  it('an unknown recipe slug shows not-found', async () => {
    app = await openApp('/#/recipe/nope/nope');
    const { page } = app;
    await page.locator('h1', { hasText: 'Not found' }).waitFor();
    expect(await page.title()).toBe('Not found · Kitchen Quest');
    expect(app.consoleErrors).toEqual([]);
  });

  it('the build ships no .wasm file', () => {
    const dist = fileURLToPath(new URL('../dist', import.meta.url));
    const files = readdirSync(dist, { recursive: true }).map(String);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => f.endsWith('.wasm'))).toEqual([]);
  });
});
