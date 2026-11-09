import { afterEach, describe, expect, inject, it } from 'vitest';
import { expectNoA11yViolations, expectNoHorizontalScroll, offOrigin, openApp, type OpenedApp } from './helpers';

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe('app shell', () => {
  it('shows the kitchen at / with the right title and no console errors', async () => {
    app = await openApp('/');
    const { page } = app;
    expect(await page.locator('#view h1').textContent()).toBe('Kitchen');
    expect(await page.title()).toBe('Kitchen · Kitchen Quest');
    expect(app.consoleErrors).toEqual([]);
  });

  it('shows not-found with a link home that focuses the kitchen h1', async () => {
    app = await openApp('/#/nowhere');
    const { page } = app;
    expect(await page.locator('#view h1').textContent()).toBe('Not found');
    await page.getByRole('link', { name: 'Back to the kitchen' }).click();
    await page.waitForFunction(() => document.activeElement?.tagName === 'H1' && document.activeElement.textContent === 'Kitchen');
    expect(await page.title()).toBe('Kitchen · Kitchen Quest');
  });

  it('has no horizontal scroll at 400px', async () => {
    app = await openApp('/', { width: 400 });
    for (const hash of ['#/', '#/settings', '#/nowhere']) {
      await app.page.goto(new URL(`/${hash}`, inject('baseUrl')).toString());
      await app.page.reload();
      await app.page.locator('#view h1').waitFor();
      await expectNoHorizontalScroll(app.page);
    }
  });

  it('makes no off-origin requests and loads the self-hosted fonts', async () => {
    app = await openApp('/');
    // Fonts load on first use; placeholder screens only render headings, so ask for the body face.
    await app.page.evaluate(() => document.fonts.load('16px "Atkinson Hyperlegible"'));
    expect(offOrigin(app.requests, inject('baseUrl'))).toEqual([]);
    expect(await app.page.evaluate(() => document.fonts.check('16px "Atkinson Hyperlegible"'))).toBe(true);
  });

  it('persists the settings toggle across reload', async () => {
    app = await openApp('/#/settings');
    const { page } = app;
    const box = page.getByLabel('Show calories');
    expect(await box.isChecked()).toBe(false);
    await box.check();
    await page.reload();
    expect(await page.getByLabel('Show calories').isChecked()).toBe(true);
  });

  it('applies the reduce-motion setting to the page', async () => {
    app = await openApp('/#/settings');
    await app.page.getByLabel('Reduce motion').selectOption('on');
    expect(await app.page.evaluate(() => document.documentElement.dataset.motion)).toBe('reduced');
  });

  it('has no serious accessibility violations', async () => {
    app = await openApp('/');
    await expectNoA11yViolations(app.page, '/');
    await app.page.goto(new URL('/#/settings', inject('baseUrl')).toString());
    await app.page.locator('#view h1').filter({ hasText: 'Settings' }).waitFor();
    await expectNoA11yViolations(app.page, '#/settings');
  });
});
