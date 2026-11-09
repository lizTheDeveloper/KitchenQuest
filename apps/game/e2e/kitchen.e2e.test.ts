import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { expectNoA11yViolations, expectNoHorizontalScroll, openApp, type OpenedApp } from './helpers';

const pan = parse(readFileSync(fileURLToPath(new URL('../../../content/dialogue/pan.yaml', import.meta.url)), 'utf8')) as {
  triggers: Record<string, { lines: string[] }>;
};
const lines = (id: string) => pan.triggers[id]!.lines;
const fill = (line: string, vars: Record<string, string>) => line.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? `{${k}}`);
const timeOfDay = ['greet.morning', 'greet.afternoon', 'greet.evening', 'greet.late_night']
  .flatMap((id) => lines(id).map((l) => fill(l, { name: 'apprentice' })));

const pad = (n: number) => String(n).padStart(2, '0');
const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

const greetingText = (page: OpenedApp['page']) => page.locator('#view .dialogue .dialogue-text .typed-full');

describe('home kitchen', () => {
  it('greets a first-time player with greet.first_ever, then a time-of-day line after a reload', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.locator('#view h1', { hasText: 'Your kitchen' }).waitFor();
    expect(await page.title()).toBe('Your kitchen · Kitchen Quest');
    await greetingText(page).waitFor();
    expect(lines('greet.first_ever')).toContain(await greetingText(page).textContent());
    // The same line is in the panel.
    expect(lines('greet.first_ever')).toContain(await page.locator('#pan-panel .bubble.pan .bubble-text').last().textContent());

    await page.reload();
    await greetingText(page).waitFor();
    const again = (await greetingText(page).textContent())!;
    expect(lines('greet.first_ever')).not.toContain(again);
    expect(timeOfDay).toContain(again);
    expect(app.consoleErrors).toEqual([]);
  });

  it('greets only once per page load', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await greetingText(page).waitFor();
    await page.getByRole('button', { name: 'Recipe shelf' }).click();
    await page.waitForFunction(() => location.hash === '#/recipes');
    await page.goBack();
    await page.locator('#view h1', { hasText: 'Your kitchen' }).waitFor();
    expect(await page.locator('#view .dialogue').count()).toBe(0);
    expect(await page.locator('#pan-panel .bubble.pan').count()).toBe(1);
  });

  it('shows a rusty technique on the knife roll as an invitation', async () => {
    app = await openApp('/', {
      reducedMotion: true,
      seed: {
        firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
        toolkit: { techniques: { tempering: { tier: 'yours', firstAt: daysAgo(300), lastUsedAt: daysAgo(200), recipes: ['india/kerala/parippu', 'mexico/oaxaca/frijoles'] } } },
      },
    });
    const { page } = app;
    await page.getByRole('button', { name: 'Knife roll' }).click();
    const dialog = page.getByRole('dialog', { name: 'Your knife roll' });
    await dialog.waitFor();
    const row = dialog.locator('[data-technique="tempering"]');
    const text = (await row.textContent())!;
    expect(text).toContain('Tempering');
    expect(text).toContain('Yours');
    expect(text).toContain('Rusty');
    const invites = lines('toolkit.rusty_invite').map((l) => fill(l, { technique: 'Tempering' }));
    expect(invites).toContain(await row.locator('.rusty-invite').textContent());
    expect(await dialog.textContent()).not.toMatch(/\d|%/);
    await expectNoA11yViolations(page, 'knife roll');
    await page.keyboard.press('Escape');
    expect(await page.getByRole('dialog', { name: 'Your knife roll' }).count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Knife roll');
  });

  it('an empty knife roll shows a Bureau footnote', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.getByRole('button', { name: 'Knife roll' }).click();
    const empty = page.locator('.knife-roll .toolkit-empty');
    await empty.waitFor();
    expect((await empty.textContent())!.startsWith('*')).toBe(true);
    expect(await page.locator('.knife-roll').textContent()).not.toMatch(/\d|%/);
  });

  it('Recipe shelf and the world map buttons go where they say', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.getByRole('button', { name: 'Recipe shelf' }).click();
    await page.waitForFunction(() => location.hash === '#/recipes');
    await page.goBack();
    await page.getByRole('button', { name: 'Go out to the world map' }).click();
    await page.waitForFunction(() => location.hash === '#/map');
  });

  it('"Talk to the Pan" opens the panel', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.getByRole('button', { name: 'Talk to the Pan' }).click();
    expect(await page.locator('#pan-panel').isVisible()).toBe(true);
  });

  it('still works with Phaser blocked: h1, backdrop image and every action', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.route('**/assets/phaser-*.js', (r) => r.abort());
    await page.reload();
    await page.locator('#view h1', { hasText: 'Your kitchen' }).waitFor();
    await page.locator('#view img.kitchen-backdrop-img').waitFor();
    for (const name of ['Talk to the Pan', 'Knife roll', 'Recipe shelf', 'Go out to the world map']) {
      expect(await page.getByRole('button', { name }).isVisible(), name).toBe(true);
    }
    expect(await page.locator('#stage canvas').count()).toBe(0);
  });

  it('with Phaser loaded, the canvas sits in the aria-hidden stage and takes no focus', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    const canvas = page.locator('#stage[aria-hidden="true"] canvas');
    await canvas.waitFor();
    expect(await canvas.getAttribute('tabindex')).toBe('-1');
    expect(await page.evaluate(() => (window as unknown as { __kqTweens?: () => number }).__kqTweens?.())).toBe(0);
    // Leaving the kitchen hides the stage.
    await page.getByRole('button', { name: 'Recipe shelf' }).click();
    await page.waitForFunction(() => (document.getElementById('stage') as HTMLElement).hidden);
    expect(app.consoleErrors).toEqual([]);
  });

  it('with full motion the Pan is animated on the canvas', async () => {
    app = await openApp('/');
    const { page } = app;
    await page.locator('#stage canvas').waitFor();
    await page.waitForFunction(() => ((window as unknown as { __kqTweens?: () => number }).__kqTweens?.() ?? 0) > 0);
  });

  it('with reduced motion the greeting is complete within 100 ms of appearing', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.locator('#view .dialogue').waitFor();
    await page.waitForTimeout(100);
    const typing = await page.locator('#view .dialogue .is-typing').count();
    expect(typing).toBe(0);
    expect(await page.locator('#view .dialogue .typed-visible').count()).toBe(0);
    expect(lines('greet.first_ever')).toContain(await greetingText(page).textContent());
  });

  it('has no serious a11y violations', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await greetingText(page).waitFor();
    await expectNoA11yViolations(page, 'kitchen');
  });

  it('has no horizontal scroll at 400px, canvas included', async () => {
    app = await openApp('/', { reducedMotion: true, width: 400 });
    const { page } = app;
    await page.locator('#stage canvas').waitFor();
    await expectNoHorizontalScroll(page);
  });
});
