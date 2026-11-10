import { afterEach, describe, expect, inject, it } from 'vitest';
import { expectNoA11yViolations, expectNoHorizontalScroll, offOrigin, openApp, openFixture, type OpenedApp } from './helpers';

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe('app shell', () => {
  it('shows the kitchen at / with the right title and no console errors', async () => {
    app = await openApp('/');
    const { page } = app;
    expect(await page.locator('#view h1').textContent()).toBe('Your kitchen');
    expect(await page.title()).toBe('Your kitchen · Kitchen Quest');
    expect(app.consoleErrors).toEqual([]);
  });

  it('`vite dev` serves the game from source: the kitchen and the sign-in page load without errors', async () => {
    // The app's sprite manifest (step 8) once answered 500 in dev, so the app never started.
    app = await openFixture('/');
    const { page } = app;
    await page.locator('#view h1', { hasText: 'Your kitchen' }).waitFor();
    const verify = await page.goto(new URL('/auth/verify?token=T0K3N', inject('fixtureUrl')).toString());
    expect(verify!.headers()['x-frame-options']).toBe('DENY');
    await page.getByRole('button', { name: 'Sign me in' }).waitFor();
    // The referrer <meta> stays head's first child even after dev injects /@vite/client.
    expect(await page.evaluate(() => document.head.firstElementChild?.getAttribute('name'))).toBe('referrer');
    expect(app.consoleErrors).toEqual([]);
  });

  it('shows not-found with a link home that focuses the kitchen h1', async () => {
    app = await openApp('/#/nowhere');
    const { page } = app;
    expect(await page.locator('#view h1').textContent()).toBe('Not found');
    await page.getByRole('link', { name: 'Back to the kitchen' }).click();
    await page.waitForFunction(() => document.activeElement?.tagName === 'H1' && document.activeElement.textContent === 'Your kitchen');
    expect(await page.title()).toBe('Your kitchen · Kitchen Quest');
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
    const loaded = await app.page.evaluate(() =>
      [...document.fonts].some((f) => f.family.includes('Atkinson') && f.status === 'loaded'));
    expect(loaded).toBe(true);
    const base = inject('baseUrl');
    expect(app.requests.some((u) => u.startsWith(base) && /atkinson.*\.woff2$/.test(u))).toBe(true);
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

  it('ships a CSP with no third-party hosts that the browser enforces', async () => {
    app = await openApp('/');
    const csp = await app.page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/https?:/);
    const violated = await app.page.evaluate(() => new Promise<string>((resolve) => {
      document.addEventListener('securitypolicyviolation', (e) => resolve(e.violatedDirective), { once: true });
      const img = new Image();
      img.src = 'https://third-party.invalid/pixel.png';
    }));
    expect(violated).toBe('img-src');
  });

  it('deletes all kq.* data after a confirm, rescue copies included, and not before', async () => {
    app = await openApp('/#/settings');
    const { page } = app;
    await page.getByLabel('Show calories').check(); // writes kq.player.v1
    await page.evaluate(() => localStorage.setItem('kq.player.v1.corrupt', 'old'));
    await page.getByRole('button', { name: 'Delete Kitchen Quest data on this device' }).click();
    await page.getByRole('button', { name: 'Keep my data' }).click();
    expect(await page.evaluate(() => localStorage.length)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Delete Kitchen Quest data on this device' }).click();
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Delete everything' }).click()]);
    await page.locator('#view h1').waitFor();
    // The fresh kitchen greets a first-time player and records only that first visit.
    await page.locator('#view .dialogue').waitFor();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kq.')))).toEqual(['kq.player.v1']);
    const fresh = await page.evaluate(() => JSON.parse(localStorage.getItem('kq.player.v1')!) as { settings: { showCalories: boolean }; firstOpenedAt: string | null });
    expect(fresh.settings.showCalories).toBe(false);
    expect(fresh.firstOpenedAt).not.toBeNull();
  });
});
