import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { STORE_KEY } from '../src/state/store';
import { expectNoA11yViolations, expectNoHorizontalScroll, openApp, type OpenedApp } from './helpers';

const pan = parse(readFileSync(fileURLToPath(new URL('../../../content/dialogue/pan.yaml', import.meta.url)), 'utf8')) as {
  triggers: Record<string, { lines: string[] }>;
};
const IOS_LINES = pan.triggers['intake.ios_install'].lines;
const PARIPPU_TITLE = /^title: (.+)$/m.exec(readFileSync(fileURLToPath(new URL('../../../recipes/india/kerala/parippu.cook', import.meta.url)), 'utf8'))![1];
const PIN_NAMES = [
  'Visit Doña Marisol — Oaxaca, Mexico',
  'Visit Ammachi Leela — Kochi, Kerala, India',
  'Visit Haruka — Osaka, Japan',
];
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const NOT_STANDALONE = `Object.defineProperty(navigator, 'standalone', { configurable: true, value: false });`;
const STANDALONE = `(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => q.includes('display-mode: standalone')
    ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }
    : real(q);
})();`;

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

type Page = OpenedApp['page'];

/** Wait for the worker to be active, then reload until it controls the page. */
async function waitForControl(page: Page): Promise<void> {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  for (let i = 0; i < 5; i++) {
    if (await page.evaluate(() => navigator.serviceWorker.controller !== null)) return;
    await page.reload();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  }
  throw new Error('the service worker never took control');
}

async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => { location.hash = h; }, hash);
}

const cacheKeys = (page: Page) => page.evaluate(() => caches.keys());

describe('installable PWA', () => {
  it('serves a manifest with three PNG icons', async () => {
    const base = inject('baseUrl');
    const res = await fetch(new URL('/manifest.webmanifest', base));
    expect(res.status).toBe(200);
    const m = await res.json() as { id: string; name: string; short_name: string; start_url: string; scope: string; display: string; background_color: string; theme_color: string; icons: { src: string; sizes: string; type: string; purpose?: string }[] };
    expect(m).toMatchObject({
      id: '/', name: 'Kitchen Quest', short_name: 'Kitchen Quest', start_url: '/#/kitchen', scope: '/', display: 'standalone',
      background_color: '#1e1b1d', theme_color: '#1e1b1d',
    });
    expect(m.icons).toHaveLength(3);
    expect(m.icons.filter((i) => i.purpose === 'maskable')).toHaveLength(1);
    for (const icon of [...m.icons.map((i) => i.src), '/icons/apple-touch-icon.png']) {
      const r = await fetch(new URL(icon, base));
      expect(r.status, icon).toBe(200);
      expect(r.headers.get('content-type'), icon).toMatch(/^image\/png/);
    }
  });

  it('runs offline from the precache and never caches /api or /auth', async () => {
    app = await openApp('/', { serviceWorkers: 'allow' });
    const { page, context } = app;
    await waitForControl(page);
    // Online, the app reaches the API through the worker's scope; nothing about it may be kept.
    await context.route('**/api/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"u1","email":"a@b.test"}' }));
    expect(await page.evaluate(async () => (await (await fetch('/api/me')).json() as { email: string }).email)).toBe('a@b.test');
    expect(await page.evaluate(async () => (await fetch('/auth/verify?token=abc')).status)).toBeGreaterThan(0);

    await context.setOffline(true);
    const errorsBefore = app.consoleErrors.length;
    await page.reload();
    await page.locator('h1', { hasText: 'Your kitchen' }).waitFor();

    await go(page, '#/recipe/india/kerala/parippu');
    await page.getByRole('heading', { level: 1, name: PARIPPU_TITLE }).waitFor();

    await go(page, '#/cook/india/kerala/parippu');
    await page.locator('.cook-progress', { hasText: 'Step 1 of 7' }).waitFor();

    await go(page, '#/map');
    for (const name of PIN_NAMES) await page.getByRole('button', { name }).waitFor();

    for (const family of ['Pixelify Sans', 'Atkinson Hyperlegible', 'VT323']) {
      const ok = await page.evaluate(async (f) => {
        await document.fonts.load(`16px "${f}"`);
        return document.fonts.check(`16px "${f}"`) && [...document.fonts].some((x) => x.family.includes(f) && x.status === 'loaded');
      }, family);
      expect(ok, family).toBe(true);
    }

    const kq = (await cacheKeys(page)).filter((k) => k.startsWith('kq-shell-'));
    expect(kq).toHaveLength(1);
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const k of await caches.keys()) urls.push(...(await (await caches.open(k)).keys()).map((r) => r.url));
      return urls;
    });
    expect(cached.length).toBeGreaterThan(10);
    expect(cached.filter((u) => /\/(api|auth)(\/|$|\?)/.test(new URL(u).pathname))).toEqual([]);
    expect(cached.some((u) => /\/sw\.js$/.test(u))).toBe(false);
    expect(cached.some((u) => u.endsWith('.woff2'))).toBe(true);
    // A .woff stays only when its .woff2 was small enough to be inlined into the CSS.
    const stem = (u: string) => u.replace(/-[A-Za-z0-9_-]{8}\.woff2?$/, '');
    const woff2 = new Set(cached.filter((u) => u.endsWith('.woff2')).map(stem));
    expect(cached.filter((u) => u.endsWith('.woff') && woff2.has(stem(u)))).toEqual([]);
    expect(cached.filter((u) => u.endsWith('.woff')).length).toBeLessThan(cached.filter((u) => u.endsWith('.woff2')).length);

    expect(app.consoleErrors.slice(errorsBefore)).toEqual([]);
  });

  it('a new worker deletes old caches when it activates', async () => {
    app = await openApp('/', { serviceWorkers: 'allow' });
    const { page } = app;
    await waitForControl(page);
    await page.evaluate(async () => {
      await caches.open('kq-shell-old');
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    });
    expect(await cacheKeys(page)).toContain('kq-shell-old');
    // The app registers the worker again on load; it installs fresh and clears stale caches on activate.
    await page.reload();
    await waitForControl(page);
    await page.reload();
    await waitForControl(page);
    const keys = await cacheKeys(page);
    expect(keys).not.toContain('kq-shell-old');
    expect(keys.filter((k) => k.startsWith('kq-shell-'))).toHaveLength(1);
  });

  it('a new deploy waits for every tab to close, and says so', async () => {
    app = await openApp('/', { serviceWorkers: 'allow' });
    const { page } = app;
    await waitForControl(page);
    const before = await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL);
    // A "new deploy": the registration gets a new worker script, which installs and then waits.
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js?edition=2', { scope: '/' }); });
    const note = page.locator('#sw-update-note');
    await note.waitFor();
    expect(await note.textContent()).toContain("A new edition of the Bureau's handbook is ready. It'll be used next time you open Kitchen Quest.");
    expect(await note.evaluate((e) => e.closest('main') !== null)).toBe(true);
    await expectNoA11yViolations(page, 'update note');
    // No skipWaiting: the page keeps its worker.
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.waiting !== null)).toBe(true);
    expect(await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL)).toBe(before);
    // The note outlives route changes: the next screen render must not wipe it.
    for (const [hash, title] of [['#/settings', 'Settings'], ['#/recipes', 'Recipe shelf'], ['#/kitchen', 'Your kitchen']]) {
      await go(page, hash);
      await page.waitForFunction((t) => document.title.startsWith(`${t} ·`) && document.querySelector('#view h1') !== null, title);
      expect(await note.count(), `after ${hash}`).toBe(1);
    }
    await note.getByRole('button', { name: 'Got it' }).click();
    expect(await note.count()).toBe(0);
  });

  it('"Delete everything" also deletes the offline copy and unregisters the worker', async () => {
    app = await openApp('/', {
      serviceWorkers: 'allow',
      initScript: `(() => {
        const real = ServiceWorkerRegistration.prototype.unregister;
        ServiceWorkerRegistration.prototype.unregister = function () {
          sessionStorage.setItem('test.unregistered', String(Number(sessionStorage.getItem('test.unregistered') ?? 0) + 1));
          return real.call(this);
        };
      })();`,
    });
    const { page } = app;
    await waitForControl(page);
    await page.evaluate(async () => { await caches.open('kq-offline-marker'); await caches.open('not-ours'); });
    // kq-offline-marker is not a kq-shell-* cache, so only "Delete everything" can remove it.
    expect(await cacheKeys(page)).toContain('kq-offline-marker');

    await go(page, '#/settings');
    await page.getByRole('button', { name: 'Delete Kitchen Quest data on this device' }).click();
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Delete everything' }).click()]);
    await page.locator('h1', { hasText: 'Your kitchen' }).waitFor();

    expect(await page.evaluate(() => Number(sessionStorage.getItem('test.unregistered') ?? 0))).toBeGreaterThanOrEqual(1);
    const after = await cacheKeys(page);
    expect(after).not.toContain('kq-offline-marker');
    expect(after).toContain('not-ours');
  });

  it('"Delete everything" with two tabs open: neither tab brings back the worker, the offline copy or the data', async () => {
    app = await openApp('/', { serviceWorkers: 'allow' });
    const { page, context } = app;
    await waitForControl(page);
    const other = await context.newPage();
    await other.goto(page.url());
    await other.locator('#view h1').waitFor();
    expect(await other.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await page.evaluate(async () => { await caches.open('kq-offline-marker'); });

    await go(page, '#/settings');
    await page.getByLabel('Show calories').check(); // something to delete
    await page.getByRole('button', { name: 'Delete Kitchen Quest data on this device' }).click();
    const otherReloaded = other.waitForEvent('load');
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Delete everything' }).click()]);
    await otherReloaded;
    await page.locator('h1', { hasText: 'Your kitchen' }).waitFor();
    await other.locator('#view h1').waitFor();
    // Give a re-registration (the bug) time to happen.
    await page.waitForTimeout(1500);

    for (const [name, p] of [['deleting tab', page], ['other tab', other]] as const) {
      expect(await p.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), name).toBe(0);
      expect(await p.evaluate(() => navigator.serviceWorker.controller), name).toBeNull();
    }
    expect((await cacheKeys(page)).filter((k) => k.startsWith('kq-'))).toEqual([]);
    const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}') as { settings?: { showCalories: boolean } }, STORE_KEY);
    expect(saved.settings?.showCalories ?? false).toBe(false);
    // The skip is for that one load only: the next start registers the worker again.
    await page.reload();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(1);
  });

  it('on an iPhone, explains Add to Home Screen until "Got it"', async () => {
    app = await openApp('/#/kitchen', { userAgent: IPHONE, initScript: NOT_STANDALONE, width: 400 });
    const { page } = app;
    const note = page.locator('.ios-note');
    await note.first().waitFor();
    expect(IOS_LINES).toContain((await note.first().locator('.ios-note-line').textContent())?.trim());
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page, 'kitchen with iOS note');

    await go(page, '#/settings');
    await page.getByRole('heading', { name: 'Install' }).waitFor();
    await note.first().waitFor();
    expect(IOS_LINES).toContain((await note.first().locator('.ios-note-line').textContent())?.trim());
    await expectNoA11yViolations(page, 'settings with iOS note');
    await note.first().getByRole('button', { name: 'Got it' }).click();
    expect(await note.count()).toBe(0);
    expect(await page.locator('#install-section').textContent()).toContain("On an iPhone or iPad, tap Share, then 'Add to Home Screen'.");
    expect(await page.evaluate((k) => (JSON.parse(localStorage.getItem(k)!) as { settings: { iosNoteDismissed: boolean } }).settings.iosNoteDismissed, STORE_KEY)).toBe(true);

    await go(page, '#/kitchen');
    await page.reload();
    await page.locator('h1', { hasText: 'Your kitchen' }).waitFor();
    expect(await note.count()).toBe(0);
    expect(app.consoleErrors).toEqual([]);
  });

  it('Settings → Install offers the browser prompt only when the browser offered one, and never on its own', async () => {
    app = await openApp('/#/settings');
    const { page } = app;
    await page.getByRole('heading', { name: 'Install' }).waitFor();
    expect(await page.getByRole('button', { name: 'Install Kitchen Quest' }).count()).toBe(0);
    expect(await page.locator('.ios-note').count()).toBe(0);

    await page.evaluate(() => {
      const w = window as unknown as { __prompted: number };
      w.__prompted = 0;
      const ev = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt(): Promise<void>; userChoice: Promise<unknown> };
      ev.prompt = () => { w.__prompted++; return Promise.resolve(); };
      ev.userChoice = Promise.resolve({ outcome: 'dismissed' });
      window.dispatchEvent(ev);
      (w as unknown as { __defaultPrevented: boolean }).__defaultPrevented = ev.defaultPrevented;
    });
    expect(await page.evaluate(() => (window as unknown as { __defaultPrevented: boolean }).__defaultPrevented)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __prompted: number }).__prompted)).toBe(0);
    const btn = page.getByRole('button', { name: 'Install Kitchen Quest' });
    await btn.waitFor();
    await btn.click();
    expect(await page.evaluate(() => (window as unknown as { __prompted: number }).__prompted)).toBe(1);
    expect(app.consoleErrors).toEqual([]);
  });

  it('Settings says "Installed." when running from the home screen', async () => {
    app = await openApp('/#/settings', { initScript: STANDALONE });
    const { page } = app;
    await page.getByRole('heading', { name: 'Install' }).waitFor();
    expect(await page.locator('#install-section').textContent()).toContain('Installed.');
    expect(await page.getByRole('button', { name: 'Install Kitchen Quest' }).count()).toBe(0);
  });
});
