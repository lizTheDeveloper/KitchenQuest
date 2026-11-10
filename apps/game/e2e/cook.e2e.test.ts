import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STORE_KEY } from '../src/state/store';
import { expectNoA11yViolations, expectNoHorizontalScroll, openApp, type OpenedApp } from './helpers';

const pan = parse(readFileSync(fileURLToPath(new URL('../../../content/dialogue/pan.yaml', import.meta.url)), 'utf8')) as {
  triggers: Record<string, { lines: string[] }>;
};
const lines = (id: string) => pan.triggers[id].lines;
/** Does `said` match one of the trigger's lines, with each {var} filled by anything? */
const isLine = (id: string, said: string | null) => lines(id).some((l) =>
  new RegExp('^' + l.split(/\{\w+\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$').test(said ?? ''));

const SLUG = 'india/kerala/parippu';
const DISCLAIMER = "Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels.";
const RULES_ERROR = "Couldn't check this dish against your rules. Treat it as unchecked.";
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const COOK = `/#/cook/${SLUG}`;
const coconutSevere = { id: 'r1', target: { kind: 'ingredient' as const, ids: ['coconut'] }, type: 'avoid' as const, severity: 'anaphylactic' as const };

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

const lastPan = (a: OpenedApp) => a.page.locator('#pan-panel .bubble.pan .bubble-text').last();
const progress = (a: OpenedApp) => a.page.locator('.cook-progress');
const stored = (a: OpenedApp) => a.page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), STORE_KEY);

/** Fake the page clock (set up before load, then frozen once the page is up) and reload under it. */
async function withClock(a: OpenedApp): Promise<void> {
  await a.page.clock.install({ time: new Date(2026, 10, 9, 12, 0, 0) });
  await a.page.reload();
  await progress(a).waitFor();
  await a.page.clock.pauseAt(new Date(2026, 10, 9, 12, 0, 5));
}

const WAKE_STUB = `(() => {
  window.__wake = { requests: [], releases: 0 };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
    request: async (type) => { window.__wake.requests.push(type);
      return { release: async () => { window.__wake.releases++; }, addEventListener() {} }; } } });
})();`;

describe('cook mode', () => {
  it('shows one big step at a time and moves with the arrow keys', async () => {
    app = await openApp(COOK, { reducedMotion: true, width: 400 });
    const { page } = app;
    await progress(app).waitFor();
    expect(await page.textContent('h1')).toContain('Parippu');
    expect(await progress(app).textContent()).toBe('Step 1 of 7');
    expect(await page.textContent('.cook-head')).toContain('Draft recipe');
    const size = await page.locator('.cook-text').evaluate((e) => ({ fs: parseFloat(getComputedStyle(e).fontSize), lh: parseFloat(getComputedStyle(e).lineHeight) / parseFloat(getComputedStyle(e).fontSize) }));
    expect(size.fs).toBeGreaterThanOrEqual(28);
    expect(size.lh).toBeGreaterThanOrEqual(1.5);
    expect(await page.locator('.cook-text strong').first().textContent()).toBe('split moong dal');
    expect(await page.locator('.cook-text .ingredient').first().textContent()).toContain('100 g');
    await page.keyboard.press('ArrowRight');
    expect(await progress(app).textContent()).toBe('Step 2 of 7');
    await page.keyboard.press('ArrowLeft');
    expect(await progress(app).textContent()).toBe('Step 1 of 7');
    expect(await page.getByRole('button', { name: /Previous/ }).isDisabled()).toBe(true);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page, 'cook step 1');
    expect(app.consoleErrors).toEqual([]);
  });

  it('timers run on absolute end times, survive step changes, and are announced once', async () => {
    app = await openApp(COOK, { reducedMotion: true });
    await withClock(app);
    const { page } = app;
    await page.keyboard.press('ArrowRight');
    expect(await progress(app).textContent()).toBe('Step 2 of 7');
    await page.locator('button.timer-start', { hasText: 'Start 20:00 timer' }).click();
    const tray = page.getByRole('group', { name: 'Running timers' });
    expect(await tray.textContent()).toContain('Step 2 · 20:00');
    expect(isLine('cook.timer_start', await lastPan(app).textContent())).toBe(true);
    await page.clock.runFor(60_000);
    expect(await tray.textContent()).toContain('Step 2 · 19:00');
    await page.keyboard.press('ArrowRight');
    expect(await progress(app).textContent()).toBe('Step 3 of 7');
    expect(await tray.textContent()).toContain('Step 2 · 19:00');
    expect(await page.getByRole('button', { name: 'Leave cook mode (stops 1 timer)' }).count()).toBe(1);
    await page.clock.runFor(19 * 60_000);
    await page.clock.runFor(100); // the announcer is cleared, then set 50 ms later
    expect(await page.locator('#announcer').textContent()).toBe('Timer finished: 20 minutes for step 2');
    const said = await lastPan(app).textContent();
    expect(lines('cook.timer_done').map((l) => l.replace('{step}', 'step 2'))).toContain(said);
    expect(await tray.textContent()).toContain('Step 2 · done');
    expect(await page.getByRole('button', { name: 'Leave cook mode' }).count()).toBe(1);
    // finished once: more time passing adds no bubbles
    const bubbles = await page.locator('#pan-panel .bubble.pan').count();
    await page.clock.runFor(60_000);
    expect(await page.locator('#pan-panel .bubble.pan').count()).toBe(bubbles);
    expect(app.consoleErrors).toEqual([]);
  });

  it('has no accessibility violations with a timer running', async () => {
    app = await openApp(COOK, { reducedMotion: true, width: 400 });
    const { page } = app;
    await progress(app).waitFor();
    await page.keyboard.press('ArrowRight');
    await page.locator('button.timer-start', { hasText: 'Start 20:00 timer' }).click();
    await page.getByRole('group', { name: 'Running timers' }).waitFor();
    await expectNoA11yViolations(page, 'cook with a timer running');
    await expectNoHorizontalScroll(page);
  });

  it('a long jump in time (sleeping phone) still finishes the timer', async () => {
    app = await openApp(COOK, { reducedMotion: true });
    await withClock(app);
    const { page } = app;
    await page.keyboard.press('ArrowRight');
    await page.locator('button.timer-start', { hasText: 'Start 20:00 timer' }).click();
    await page.clock.fastForward(2 * 3600_000);
    await page.clock.runFor(500);
    expect(await page.locator('#announcer').textContent()).toBe('Timer finished: 20 minutes for step 2');
  });

  it('keeps the screen awake, and releases it on leaving', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.addInitScript(WAKE_STUB);
    await page.goto(new URL(COOK, page.url()).toString());
    await page.reload();
    await progress(app).waitFor();
    await page.waitForFunction(() => (window as never as { __wake: { requests: string[] } }).__wake.requests.length === 1);
    expect(await page.evaluate(() => (window as never as { __wake: { requests: string[] } }).__wake.requests)).toEqual(['screen']);
    expect(await page.getByRole('button', { name: /Keep screen awake/ }).getAttribute('aria-pressed')).toBe('true');
    await page.getByRole('button', { name: 'Leave cook mode' }).click();
    await page.waitForFunction(() => (window as never as { __wake: { releases: number } }).__wake.releases === 1);
    expect(await page.evaluate(() => location.hash)).toBe(`#/recipe/${SLUG}`);
  });

  it('says so when the browser cannot keep the screen awake', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.addInitScript(`Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });`);
    await page.goto(new URL(COOK, page.url()).toString());
    await page.reload();
    await progress(app).waitFor();
    await page.locator('.wake-note').waitFor({ state: 'visible' });
    expect(await page.textContent('.wake-note')).toBe("This browser can't keep the screen awake. Tap the screen now and then.");
  });

  it('works with Phaser blocked: all 7 steps, the certificate, techniques recorded, then the kitchen', async () => {
    // Start away from the kitchen: the kitchen asks for Phaser, cook mode never does.
    app = await openApp('/#/settings', { reducedMotion: true });
    const { page } = app;
    const phaser: string[] = [];
    await page.route('**/assets/phaser-*.js', (r) => { phaser.push(r.request().url()); return r.abort(); });
    page.on('request', (r) => { if (/phaser/i.test(r.url())) phaser.push(r.url()); });
    await page.goto(new URL(COOK, page.url()).toString());
    await page.reload();
    await progress(app).waitFor();
    expect(await page.locator('canvas').count()).toBe(0);
    for (let i = 0; i < 6; i++) await page.getByRole('button', { name: /Next step/ }).click();
    expect(await progress(app).textContent()).toBe('Step 7 of 7');
    await page.getByRole('button', { name: /^Done/ }).click();
    const dialog = page.getByRole('dialog', { name: /Certificate of a Dish Cooked/ });
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain('COOKED');
    expect(await dialog.textContent()).toContain('Techniques tried: ');
    expect(await dialog.textContent()).toContain('On behalf of the home cooks of');
    expect(await dialog.textContent()).not.toContain('{place}');
    await expectNoA11yViolations(page, 'certificate');
    const s = await stored(app);
    expect(s.toolkit.techniques.tempering.tier).toBe('tried');
    expect(s.cookProgress).toBeNull();
    expect(lines('cook.done').some((l) => l.includes('{dish}'))).toBe(true);
    expect(phaser).toEqual([]);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await page.waitForFunction(() => location.hash === '#/kitchen');
    // The kitchen asks for Phaser (blocked here) and carries on without it.
    await page.locator('#view img.kitchen-backdrop-img').waitFor();
    expect(app.consoleErrors.filter((e) => !/phaser|ERR_FAILED/i.test(e))).toEqual([]);
  });

  it('resumes at the saved step after a reload', async () => {
    app = await openApp(COOK, { reducedMotion: true });
    const { page } = app;
    await progress(app).waitFor();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await progress(app).textContent()).toBe('Step 3 of 7');
    await page.reload();
    await progress(app).waitFor();
    expect(await progress(app).textContent()).toBe('Step 3 of 7');
  });

  it('refuses a blocked dish at the deep link, and again on resume', async () => {
    app = await openApp(COOK, { seed: { v: 1, localRules: [coconutSevere] } });
    const { page } = app;
    await page.locator('.cook-refusal').waitFor();
    expect(await page.textContent('#view')).toContain("isn't cookable");
    expect(await page.textContent('#view')).not.toContain('Step 1');
    expect(await page.getByRole('button', { name: /Next step/ }).count()).toBe(0);
    await app.close();

    app = await openApp(COOK, { seed: { v: 1, localRules: [coconutSevere], cookProgress: { slug: SLUG, step: 2 } } });
    await app.page.reload();
    await app.page.locator('.cook-refusal').waitFor();
    expect(await app.page.textContent('#view')).toContain("isn't cookable");
    expect(await app.page.textContent('#view')).not.toContain('Step 3');
    expect(await app.page.locator('.cook-refusal a').getAttribute('href')).toBe(`#/recipe/${SLUG}`);
  });

  it('an unknown dish is not found', async () => {
    app = await openApp('/#/cook/nope/nope');
    await app.page.locator('h1', { hasText: 'Not found' }).waitFor();
  });

  it('Family Table: the Pan still opens with its script and there is no text box', async () => {
    app = await openApp(COOK, { seed: { v: 1, settings: { showCalories: false, reducedMotion: 'system', familyTable: true, iosNoteDismissed: false } }, reducedMotion: true });
    const { page } = app;
    await progress(app).waitFor();
    const said = await lastPan(app).textContent();
    expect(isLine('cook.start', said)).toBe(true);
    expect(await page.locator('#pan-text').count()).toBe(0);
  });

  it('refuses mid-cook when another tab saves a blocking rule; focus moves to the refusal and it is announced', async () => {
    app = await openApp(COOK, { reducedMotion: true });
    const { page } = app;
    await progress(app).waitFor();
    await page.getByRole('button', { name: /Next step/ }).focus();
    await page.evaluate(({ key, rule }) => {
      const s = JSON.parse(localStorage.getItem(key) ?? '{"v":1}');
      s.localRules = [rule];
      localStorage.setItem(key, JSON.stringify(s));
      window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
    }, { key: STORE_KEY, rule: coconutSevere });
    await page.locator('.cook-refusal').waitFor();
    expect(await page.textContent('#view')).toContain("isn't cookable");
    expect(await page.getByRole('button', { name: /Next step/ }).count()).toBe(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.matches('.cook-refusal h1') ?? false)).toBe(true);
    await expect.poll(() => page.locator('#announcer').textContent()).toBe("This dish isn't cookable with your rules.");
    expect(app.consoleErrors).toEqual([]);
  });

  it('refuses mid-cook when midnight starts a rule phase', async () => {
    const phased = { ...coconutSevere, phase: { start: '2026-11-10' } };
    app = await openApp(COOK, { reducedMotion: true, seed: { v: 1, localRules: [phased] } });
    await withClock(app);
    const { page } = app;
    expect(await page.locator('.cook-refusal').count()).toBe(0);
    await page.clock.fastForward(13 * 3600_000); // 12:00 -> 01:00 next day
    await page.clock.runFor(61_000);
    await page.locator('.cook-refusal').waitFor();
    expect(await page.textContent('#view')).toContain("isn't cookable");
  });

  it('a deep link to a ❓ severe dish shows the status and the allergy disclaimer in cook mode', async () => {
    app = await openApp(COOK, { reducedMotion: true, seed: { v: 1, rulesUnreadable: true } });
    const { page } = app;
    await progress(app).waitFor();
    const strip = page.locator('.cook-head .safety-strip');
    expect(await strip.locator('.chip').getAttribute('data-status')).toBe('unverified');
    const text = (await strip.textContent())!;
    expect(text).toContain("Can't verify");
    expect(text).toContain(DISCLAIMER);
    expect(text).toContain(RULES_ERROR);
    await expectNoA11yViolations(page, 'cook with an unverified dish');
    expect(app.consoleErrors).toEqual([]);
  });

  it('mid-cook, a rules refresh that fails (500 on becoming visible) turns the strip from ✅ to ❓', async () => {
    let rulesAnswer = json(200, { rules: [] });
    app = await openApp(COOK, {
      reducedMotion: true,
      beforeGoto: async (page) => {
        await page.route('**/api/me', (route) => route.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route('**/api/rules', (route) => route.fulfill(rulesAnswer));
      },
    });
    const { page } = app;
    await progress(app).waitFor();
    const chip = page.locator('.cook-head .safety-strip .chip');
    await expect.poll(() => chip.getAttribute('data-status')).toBe('ok');
    expect(await page.locator('.cook-head .safety-strip').textContent()).not.toContain(DISCLAIMER);
    await page.keyboard.press('ArrowRight');
    rulesAnswer = json(500, { error: { code: 'internal', message: 'internal' } });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => chip.getAttribute('data-status')).toBe('unverified');
    const text = (await page.locator('.cook-head .safety-strip').textContent())!;
    expect(text).toContain(DISCLAIMER);
    expect(text).toContain(RULES_ERROR);
    // Still cookable, on the same step, with the steps redrawn.
    expect(await progress(app).textContent()).toBe('Step 2 of 7');
    expect(await page.getByRole('button', { name: /Next step/ }).count()).toBe(1);
  });

  it('the back button during the certificate removes it and the kitchen does not follow', async () => {
    app = await openApp(`/#/recipe/${SLUG}`, { reducedMotion: true, seed: { v: 1, cookProgress: { slug: SLUG, step: 6 } } });
    const { page } = app;
    await page.getByRole('button', { name: /Cook it/ }).click();
    await progress(app).waitFor();
    expect(await progress(app).textContent()).toBe('Step 7 of 7');
    await page.getByRole('button', { name: /^Done/ }).click();
    const dialog = page.getByRole('dialog', { name: /Certificate of a Dish Cooked/ });
    await dialog.waitFor();
    await page.goBack();
    await page.waitForFunction((slug) => location.hash === `#/recipe/${slug}`, SLUG);
    await dialog.waitFor({ state: 'detached' });
    expect(await page.locator('.overlay-backdrop').count()).toBe(0);
    expect(await page.evaluate(() => [...document.body.children].some((e) => (e as HTMLElement).inert))).toBe(false);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => location.hash)).toBe(`#/recipe/${SLUG}`);
    expect(app.consoleErrors).toEqual([]);
  });

  it('a ✅→❓ refresh mid-cook keeps focus on the timer button and announces the new status', async () => {
    let rulesAnswer = json(200, { rules: [] });
    app = await openApp(COOK, {
      reducedMotion: true,
      beforeGoto: async (page) => {
        await page.route('**/api/me', (route) => route.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route('**/api/rules', (route) => route.fulfill(rulesAnswer));
      },
    });
    const { page } = app;
    await progress(app).waitFor();
    const chip = page.locator('.cook-head .safety-strip .chip');
    await expect.poll(() => chip.getAttribute('data-status')).toBe('ok');
    await page.keyboard.press('ArrowRight');
    const timer = page.locator('button.timer-start', { hasText: 'Start 20:00 timer' });
    await timer.focus();
    const name = await timer.getAttribute('aria-label');
    rulesAnswer = json(500, { error: { code: 'internal', message: 'internal' } });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => chip.getAttribute('data-status')).toBe('unverified');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)).toBe(name);
    await expect.poll(() => page.locator('#announcer').textContent()).toBe("Safety check now: Can't verify.");
  });

  it('a new swap shown in the step keeps focus on the same timer button', async () => {
    app = await openApp(COOK, { reducedMotion: true, seed: { v: 1, cookProgress: { slug: SLUG, step: 4 } } });
    const { page } = app;
    await progress(app).waitFor();
    expect(await progress(app).textContent()).toBe('Step 5 of 7');
    const timer = page.locator('button.timer-start').first();
    await timer.focus();
    const name = await timer.getAttribute('aria-label');
    await page.evaluate(({ key, rule }) => {
      const s = JSON.parse(localStorage.getItem(key) ?? '{"v":1}');
      s.localRules = [rule];
      localStorage.setItem(key, JSON.stringify(s));
      window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
    }, { key: STORE_KEY, rule: { id: 'p1', target: { kind: 'ingredient', ids: ['coconut_oil'] }, type: 'avoid', severity: 'preference' } });
    await expect.poll(() => page.locator('.cook-text').textContent()).toMatch(/coconut oil.*\(.+\)/);
    expect(await page.locator('.cook-refusal').count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)).toBe(name);
  });
});

