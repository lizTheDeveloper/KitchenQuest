import { afterEach, describe, expect, it } from 'vitest';
import { expectNoA11yViolations, openFixture, type OpenedApp } from './helpers';

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe('status chips', () => {
  it('all four read as text and pass axe and 4.5:1 contrast', async () => {
    app = await openFixture('/e2e/fixtures/components.html');
    const { page } = app;
    expect(await page.locator('.chip').allTextContents()).toEqual(['✅ OK', '🔁 Swap', '⛔ Blocked', "❓ Can't verify"]);
    const ratios = await page.evaluate(() => {
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      return [...document.querySelectorAll('.chip')].map((el) => {
        const cs = getComputedStyle(el);
        const a = lum(parse(cs.color)), b = lum(parse(cs.backgroundColor));
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    });
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);
    await expectNoA11yViolations(page, 'chips');
  });
});

describe('Bureau form', () => {
  it('focuses the heading, traps focus, makes the page inert, and Escape declines', async () => {
    app = await openFixture('/e2e/fixtures/components.html');
    const { page } = app;
    await page.click('#open');
    const dialog = page.getByRole('dialog', { name: 'Declaration of an Allergy' });
    await dialog.waitFor();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('bureau-form-title');
    expect(await page.evaluate(() => (document.getElementById('screen') as HTMLElement).inert)).toBe(true);
    await expectNoA11yViolations(page, 'bureau form');
    const labels: string[] = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      labels.push(await page.evaluate(() => document.activeElement?.textContent ?? ''));
    }
    // only the dialog's two buttons ever hold focus
    expect(new Set(labels)).toEqual(new Set(['Stamp it ✔', 'Not quite']));
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press('Escape');
    await page.locator('#result:has-text("decline")').waitFor();
    expect(await page.evaluate(() => (document.getElementById('screen') as HTMLElement).inert)).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('open');
  });

  it('confirms only on an explicit click', async () => {
    app = await openFixture('/e2e/fixtures/components.html');
    const { page } = app;
    await page.click('#open');
    await page.getByRole('button', { name: 'Stamp it ✔' }).click();
    await page.locator('#result:has-text("confirm")').waitFor();
  });
});

describe('shell error handling', () => {
  it('shows an in-character error screen when a screen throws, sync or async, and recovers', async () => {
    app = await openFixture('/e2e/fixtures/throwing.html#/map');
    const { page } = app;
    await page.locator('#view h1:has-text("Something went off the boil")').waitFor();
    expect(await page.locator('#view hr').count()).toBe(0);
    await page.evaluate(() => { location.hash = '#/recipes'; });
    await page.locator('#view h1:has-text("Something went off the boil")').waitFor();
    await page.getByRole('link', { name: 'Back to the kitchen' }).click();
    await page.locator('#view h1:has-text("Kitchen")').waitFor();
  });
});
