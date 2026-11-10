import { afterEach, describe, expect, it } from 'vitest';
import { openApp, type OpenedApp } from './helpers';
import { LEELA_PIN } from './screens';

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

type Page = OpenedApp['page'];
interface Hooks { __kqTweens?: () => number; __kqScene?: string | null; __kqGreet?: { shown?: number; done?: number } }

/**
 * Runs before the app on every load: notes when the kitchen greeting's box first appears, and when its text
 * is complete (nothing left typing).
 */
const GREETING_WATCH = `(() => {
  const w = window; w.__kqGreet = {};
  new MutationObserver(() => {
    const box = document.querySelector('#view .dialogue');
    if (!box) return;
    const t = performance.now();
    w.__kqGreet.shown ??= t;
    if (w.__kqGreet.done === undefined && box.querySelector('.typed-full') && !box.querySelector('.is-typing, .typed-visible')) w.__kqGreet.done = t;
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();`;

/** Time from the greeting box appearing to its text being complete. */
async function greetingTypingMs(page: Page): Promise<number> {
  await page.locator('#view .dialogue .typed-full').waitFor();
  await page.waitForFunction(() => (window as unknown as Hooks).__kqGreet?.done !== undefined, null, { timeout: 15_000 });
  const g = await page.evaluate(() => (window as unknown as Hooks).__kqGreet!);
  return g.done! - g.shown!;
}

/** Let the page run a few animation frames. */
const frames = (page: Page, n: number) => page.evaluate((count) => new Promise<void>((done) => {
  let left = count;
  const tick = () => { left -= 1; if (left <= 0) done(); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), n);

/** The reduced-motion checks, from a fresh load of the kitchen. */
async function expectStill(page: Page): Promise<void> {
  expect(await greetingTypingMs(page), 'greeting complete within 100 ms').toBeLessThanOrEqual(100);

  await page.waitForFunction(() => (window as unknown as Hooks).__kqScene === 'Kitchen');
  await frames(page, 10);
  expect(await page.evaluate(() => (window as unknown as Hooks).__kqTweens?.() ?? 0), 'Kitchen scene tweens').toBe(0);

  expect(await stampAnimations(page), 'animations while stamping the permit').toBe(0);
  await frames(page, 5);
  expect(await page.evaluate(() => document.getAnimations().length), 'animations a few frames after arriving').toBe(0);
}

/**
 * Map → permit → stamp. Samples `document.getAnimations()` on every animation frame from the click until
 * the visit has opened, and returns the most seen at once (the stamp plays before the permit closes).
 */
async function stampAnimations(page: Page): Promise<number> {
  await page.getByRole('button', { name: 'Go out to the world map' }).click();
  await page.getByRole('button', { name: LEELA_PIN }).click();
  await page.getByRole('dialog', { name: 'Travel Permit' }).waitFor();
  await page.evaluate(() => {
    const w = window as unknown as { __kqAnim: { max: number; done: boolean } };
    w.__kqAnim = { max: 0, done: false };
    const tick = () => {
      w.__kqAnim.max = Math.max(w.__kqAnim.max, document.getAnimations().length);
      if (location.hash === '#/visit/leela') { w.__kqAnim.done = true; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.getByRole('button', { name: 'Stamp it ✔' }).click();
  await page.waitForFunction(() => (window as unknown as { __kqAnim: { done: boolean } }).__kqAnim.done);
  return page.evaluate(() => (window as unknown as { __kqAnim: { max: number } }).__kqAnim.max);
}

describe('reduced motion', () => {
  it('with prefers-reduced-motion: the greeting is instant, no tweens, no animations after stamping', async () => {
    app = await openApp('/', { initScript: GREETING_WATCH });
    await app.page.emulateMedia({ reducedMotion: 'reduce' });
    await app.page.reload();
    await expectStill(app.page);
    expect(app.consoleErrors).toEqual([]);
  });

  it('with Settings "Reduce motion: On" and no media query: the same', async () => {
    app = await openApp('/#/settings', { initScript: GREETING_WATCH, reducedMotion: false });
    const { page } = app;
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
    await page.getByLabel('Reduce motion').selectOption({ label: 'On' });
    await page.goto(new URL('/#/kitchen', page.url()).toString());
    await page.reload();
    await expectStill(page);
    expect(app.consoleErrors).toEqual([]);
  });

  it('control: with motion allowed, the greeting types in (so the 100 ms check means something)', async () => {
    app = await openApp('/', { initScript: GREETING_WATCH, reducedMotion: false });
    expect(await greetingTypingMs(app.page)).toBeGreaterThan(100);
  });

  it('control: with motion allowed, the stamp animates (so the 0-animations check means something)', async () => {
    app = await openApp('/', { reducedMotion: false });
    await app.page.locator('#view h1', { hasText: 'Your kitchen' }).waitFor();
    expect(await stampAnimations(app.page)).toBeGreaterThan(0);
  });
});
