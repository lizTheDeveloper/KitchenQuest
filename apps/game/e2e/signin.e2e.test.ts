import type { Page, Request, Route } from 'playwright';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { expectNoA11yViolations, offOrigin, openApp, type OpenedApp } from './helpers';

const NEUTRAL = 'If that address can sign in, a link is on its way. It works once, for 15 minutes.';
const PARIPPU = '/#/recipe/india/kerala/parippu';
const coconutSevere = { id: 'a1', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };
const unknownId = { id: 'a2', target: { kind: 'ingredient', ids: ['no_such_ingredient'] }, type: 'avoid', severity: 'allergy' };

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const m2error = (status: number, code: string, details?: unknown) =>
  json(status, { error: { code, message: 'x', ...(details === undefined ? {} : { details }) } });
/** M2's rate-limit answer carries retry-after (seconds). */
const rateLimited = () => ({ ...m2error(429, 'rate_limited'), headers: { 'retry-after': '60' } });

/** Records POST /api/auth/verify and answers from `answers` in order (the last one repeats). */
function verifyMock(answers: ((route: Route) => Promise<void>)[]) {
  const seen: Request[] = [];
  return {
    seen,
    async install(page: Page) {
      await page.route('**/api/auth/verify', async (route) => {
        seen.push(route.request());
        const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
        await answer(route);
      });
    },
  };
}
const reply = (status: number, body: unknown) => (route: Route) => route.fulfill(json(status, body));
const SIGNED_IN = { user: { id: 'u1', email: 'cook@example.com' } };

const chipStatus = (page: Page) => page.locator('.recipe-card .recipe-status .chip').getAttribute('data-status');

describe('/auth/verify', () => {
  it('waits for a click, strips the token, never leaks it, and sends exactly one request', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const mock = verifyMock([async (route) => { await held; await route.fulfill(json(200, SIGNED_IN)); }]);
    app = await openApp('/auth/verify?token=T0K3N', { beforeGoto: (page) => mock.install(page) });
    const { page, response } = app;
    const base = inject('baseUrl');

    expect(response!.headers()['referrer-policy']).toBe('no-referrer');
    expect(response!.headers()['cache-control']).toBe('no-store');
    expect(response!.headers()['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(response!.headers()['x-frame-options']).toBe('DENY');
    const meta = page.locator('head > meta[name="referrer"]').first();
    expect(await meta.getAttribute('content')).toBe('no-referrer');
    expect(await page.evaluate(() => document.head.firstElementChild?.getAttribute('name'))).toBe('referrer');
    await page.getByRole('heading', { level: 1, name: 'Sign in to Kitchen Quest' }).waitFor();
    expect(page.url()).not.toContain('T0K3N');
    expect(await page.textContent('body')).toContain('Tap the button to finish signing in on this device.');

    // No auto-submit: not on load, not on a timer, not on Enter.
    await page.waitForTimeout(2000);
    await page.locator('body').press('Enter');
    await page.waitForTimeout(500);
    expect(mock.seen).toHaveLength(0);

    const button = page.locator('#verify');
    await button.click();
    await page.waitForFunction(() => (document.getElementById('verify') as HTMLButtonElement).disabled);
    await button.dblclick({ force: true });
    // Even with the button forced back on, a second request is never sent while one is pending.
    await page.evaluate(() => { const b = document.getElementById('verify') as HTMLButtonElement; b.disabled = false; b.click(); b.click(); });
    await page.waitForTimeout(300);
    expect(mock.seen).toHaveLength(1);
    const req = mock.seen[0];
    expect(req.method()).toBe('POST');
    expect(req.headers()['content-type']).toBe('application/json');
    expect(JSON.parse(req.postData()!)).toEqual({ token: 'T0K3N' });
    release();

    await page.getByText('Signed in as cook@example.com.').waitFor();
    expect(await page.getByRole('link', { name: 'Into the kitchen' }).getAttribute('href')).toBe('/#/kitchen');
    expect(mock.seen).toHaveLength(1);

    // The token is nowhere: not in storage, not in the DOM, not in a Referer.
    const kept = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, d: document.documentElement.outerHTML }));
    expect(kept).not.toContain('T0K3N');
    expect(req.headers().referer ?? '').not.toContain('T0K3N');

    expect(offOrigin(app.requests, base)).toEqual([]);
    const scripts = await page.evaluate(() => [...document.scripts].map((s) => s.src));
    expect(scripts).toHaveLength(1);
    expect(scripts[0].startsWith(base)).toBe(true);
    await expectNoA11yViolations(page, 'verify page');
    expect(app.consoleErrors).toEqual([]);
  });

  it('a new account must confirm age: the button stays off until the box is ticked', async () => {
    const mock = verifyMock([
      (route) => route.fulfill(m2error(400, 'bad_request', { code: 'age_confirmation_required' })),
      reply(200, SIGNED_IN),
    ]);
    app = await openApp('/auth/verify?token=T0K3N', { beforeGoto: (page) => mock.install(page) });
    const { page } = app;
    await page.getByRole('button', { name: 'Sign me in' }).click();
    const box = page.getByLabel("I'm 16 or older");
    await box.waitFor();
    expect(await box.getAttribute('required')).not.toBeNull();
    const create = page.getByRole('button', { name: 'Create my account' });
    expect(await create.isDisabled()).toBe(true);
    await box.check();
    expect(await create.isEnabled()).toBe(true);
    await expectNoA11yViolations(page, 'age gate');
    await create.click();
    await page.getByText('Signed in as cook@example.com.').waitFor();
    expect(mock.seen).toHaveLength(2);
    expect(JSON.parse(mock.seen[1].postData()!)).toEqual({ token: 'T0K3N', ageConfirmed: true });
  });

  it('an expired or used link says so and points to Settings', async () => {
    const mock = verifyMock([(route) => route.fulfill(m2error(401, 'unauthorized'))]);
    app = await openApp('/auth/verify?token=T0K3N', { beforeGoto: (page) => mock.install(page) });
    const { page } = app;
    await page.getByRole('button', { name: 'Sign me in' }).click();
    await page.getByText('This link has expired or has already been used.').waitFor();
    expect(await page.locator('a[href="/#/settings"]').count()).toBe(1);
  });

  it('busy or unreachable: says so and lets the player try again', async () => {
    const mock = verifyMock([
      (route) => route.fulfill(rateLimited()),
      (route) => route.fulfill(m2error(500, 'internal')),
      (route) => route.abort('internetdisconnected'),
      reply(200, { unexpected: true }),
      reply(200, SIGNED_IN),
    ]);
    app = await openApp('/auth/verify?token=T0K3N', { beforeGoto: (page) => mock.install(page) });
    const { page } = app;
    const button = page.getByRole('button', { name: 'Sign me in' });
    const BUSY = "The Bureau couldn't finish that just now. Try again in a moment.";
    const OFFLINE = "Couldn't reach the Bureau. Check your connection and try again.";
    // 429, 500, no network, and a 200 that isn't a sign-in answer.
    for (const text of [BUSY, BUSY, OFFLINE, BUSY]) {
      await button.click();
      await page.getByText(text).waitFor();
      await page.waitForFunction(() => !(document.getElementById('verify') as HTMLButtonElement).disabled);
      expect(await button.isEnabled()).toBe(true);
    }
    await button.click();
    await page.getByText('Signed in as cook@example.com.').waitFor();
    expect(mock.seen.map((r) => JSON.parse(r.postData()!) as unknown)).toEqual(Array(5).fill({ token: 'T0K3N' }));
  });

  it('refuses to work inside a frame, even if the anti-framing headers were stripped', async () => {
    const mock = verifyMock([reply(200, SIGNED_IN)]);
    app = await openApp('/#/settings', {
      beforeGoto: async (page) => {
        await mock.install(page);
        // A proxy that drops the headers: only the page's own check is left.
        await page.route('**/auth/verify?**', async (route) => {
          const res = await route.fetch();
          const headers = { ...res.headers() };
          delete headers['x-frame-options'];
          delete headers['content-security-policy'];
          await route.fulfill({ response: res, headers });
        });
      },
    });
    const { page } = app;
    await page.evaluate(() => {
      const f = document.createElement('iframe');
      f.title = 'framed';
      f.src = '/auth/verify?token=T0K3N';
      document.body.append(f);
    });
    const frame = page.frameLocator('iframe[title="framed"]');
    await frame.getByText('This page has to be opened on its own').waitFor();
    expect(await frame.locator('#verify').count()).toBe(0);
    expect(mock.seen).toHaveLength(0);
  });

  it('a link without a token says it is incomplete and sends nothing', async () => {
    const mock = verifyMock([reply(200, SIGNED_IN)]);
    app = await openApp('/auth/verify', { beforeGoto: (page) => mock.install(page) });
    const { page } = app;
    await page.getByText('This sign-in link is incomplete.').waitFor();
    expect(await page.locator('a[href="/#/settings"]').count()).toBe(1);
    expect(await page.locator('#verify').count()).toBe(0);
    expect(mock.seen).toHaveLength(0);
  });

  it('with the service worker in control, the page still comes from the network and is never cached', async () => {
    const mock = verifyMock([reply(200, SIGNED_IN)]);
    app = await openApp('/', { serviceWorkers: 'allow', beforeGoto: (page) => mock.install(page) });
    const { page } = app;
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    for (let i = 0; i < 5 && !(await page.evaluate(() => navigator.serviceWorker.controller !== null)); i++) await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    const res = await page.goto(new URL('/auth/verify?token=T0K3N', page.url()).toString());
    expect(res!.fromServiceWorker()).toBe(false);
    expect(res!.headers()['referrer-policy']).toBe('no-referrer');
    await page.getByRole('button', { name: 'Sign me in' }).click();
    await page.getByText('Signed in as cook@example.com.').waitFor();
    // Only main.ts registers the worker, at /sw.js with scope /.
    const regs = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => [r.scope, r.active?.scriptURL]));
    expect(regs).toEqual([[new URL('/', page.url()).toString(), new URL('/sw.js', page.url()).toString()]]);
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname);
      return urls;
    });
    expect(cached.filter((u) => u.startsWith('/auth') || u.startsWith('/api'))).toEqual([]);
  });

  it('the main app never sends a token it finds in the address', async () => {
    const mock = verifyMock([reply(200, SIGNED_IN)]);
    app = await openApp('/#/kitchen?token=X', { beforeGoto: (page) => mock.install(page) });
    await app.page.locator('h1').first().waitFor();
    await app.page.waitForTimeout(1000);
    expect(mock.seen).toHaveLength(0);
    expect(app.requests.filter((u) => u.includes('/api/auth/verify'))).toEqual([]);
  });
});

describe('Settings → Account', () => {
  it('the sign-in request shows the same words for sent and rate-limited', async () => {
    const bodies: unknown[] = [];
    const answers = [json(202, { ok: true }), rateLimited()];
    app = await openApp('/#/settings', {
      beforeGoto: (page) => page.route('**/api/auth/request', async (route) => {
        bodies.push(JSON.parse(route.request().postData()!));
        await route.fulfill(answers[bodies.length - 1]);
      }),
    });
    const { page } = app;
    await page.getByLabel('Email').fill('cook@example.com');
    await page.getByRole('button', { name: 'Send me a sign-in link' }).click();
    await page.getByText(NEUTRAL).waitFor();
    const first = await page.locator('#account-status').textContent();
    await page.getByRole('button', { name: 'Send me a sign-in link' }).click();
    await expect.poll(() => bodies.length).toBe(2);
    await page.getByText(NEUTRAL).waitFor();
    expect(await page.locator('#account-status').textContent()).toBe(first);
    expect(bodies).toEqual([{ email: 'cook@example.com' }, { email: 'cook@example.com' }]);
    await expectNoA11yViolations(page, 'account section');
    expect(app.consoleErrors).toEqual([]);
  });

  it('cached account rules are not trusted when the server fails to send them (500): ❓, never ✅', async () => {
    let rulesAnswer = json(200, { rules: [] });
    app = await openApp(PARIPPU, {
      beforeGoto: async (page) => {
        await page.route('**/api/me', (route) => route.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route('**/api/rules', (route) => route.fulfill(rulesAnswer));
      },
    });
    const { page } = app;
    await expect.poll(() => chipStatus(page)).toBe('ok');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}').accountRules as unknown)).toEqual([]);

    rulesAnswer = m2error(500, 'internal');
    await page.reload();
    await page.getByText("Couldn't check this dish against your rules. Treat it as unchecked.").waitFor();
    expect(await chipStatus(page)).toBe('unverified');
  });

  it('signed in, account rules decide the card; bad account rules are ❓; signing out puts it back', async () => {
    let rules: unknown[] = [coconutSevere];
    let loggedOut = 0;
    app = await openApp(PARIPPU, {
      beforeGoto: async (page) => {
        await page.route('**/api/me', (route) => route.fulfill(loggedOut ? m2error(401, 'unauthorized') : json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route('**/api/rules', (route) => route.fulfill(json(200, { rules })));
        await page.route('**/api/auth/logout', async (route) => { loggedOut++; await route.fulfill({ status: 204 }); });
      },
    });
    const { page } = app;
    await expect.poll(() => chipStatus(page)).toBe('blocked');

    rules = [unknownId];
    await page.reload();
    await page.getByText("Couldn't check this dish against your rules. Treat it as unchecked.").waitFor();
    expect(await chipStatus(page)).toBe('unverified');

    await page.goto(new URL('/#/settings', page.url()).toString());
    await page.getByText('Signed in as cook@example.com').waitFor();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Send me a sign-in link' }).waitFor();
    expect(loggedOut).toBe(1);
    const stored = await page.evaluate(() => localStorage.getItem('kq.player.v1') ?? '');
    expect(stored).not.toContain('cook@example.com');
    expect(stored).not.toContain('no_such_ingredient');

    await page.goto(new URL(PARIPPU, page.url()).toString());
    await expect.poll(() => chipStatus(page)).toBe('ok');
  });
});
