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

interface Hooks {
  __kqTweens?: () => number;
  __kqScene?: string | null;
  __kqPlayer?: () => { x: number; y: number } | null;
  __kqPhaser?: () => { keyboardQueue: number; touchCapture: boolean } | null;
}

async function waitForKitchenScene(page: OpenedApp['page']): Promise<void> {
  await page.waitForFunction(() => (window as unknown as Hooks).__kqScene === 'Kitchen');
}
/** Let the game run a few animation frames. */
async function frames(page: OpenedApp['page'], n: number): Promise<void> {
  await page.evaluate((count) => new Promise<void>((done) => {
    let left = count;
    const tick = () => { left -= 1; if (left <= 0) done(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), n);
}

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
    for (const sel of ['.rusty-invite', '.fresh-rusty']) {
      const color = await row.locator(sel).evaluate((e) => getComputedStyle(e).color);
      expect(color, sel).not.toBe('rgb(200, 66, 58)'); // --chili
    }
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
    expect(app.consoleErrors).toEqual([]);
  });

  it('with reduced motion the running Kitchen scene has no tweens', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await waitForKitchenScene(page);
    await frames(page, 10);
    expect(await page.evaluate(() => (window as unknown as Hooks).__kqTweens!())).toBe(0);
  });

  it('with motion allowed the running Kitchen scene animates the Pan (so the tween hook is live)', async () => {
    app = await openApp('/');
    const { page } = app;
    await waitForKitchenScene(page);
    await frames(page, 10);
    expect(await page.evaluate(() => (window as unknown as Hooks).__kqTweens!())).toBeGreaterThan(0);
  });

  it('leaving the kitchen destroys the game: no canvas, no live Phaser keyboard, typing is untouched', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await waitForKitchenScene(page);
    expect(await page.evaluate(() => (window as unknown as Hooks).__kqPhaser!())).not.toBeNull();
    await page.getByRole('button', { name: 'Recipe shelf' }).click();
    await page.waitForFunction(() => location.hash === '#/recipes');
    await page.waitForFunction(() => document.querySelector('#stage canvas') === null);
    expect(await page.evaluate(() => (window as unknown as Hooks).__kqPhaser!())).toBeNull();
    expect(await page.evaluate(() => (window as unknown as Hooks).__kqScene ?? null)).toBeNull();
    await page.locator('#pan-button').click();
    await page.locator('#pan-text').pressSequentially('wasd and arrows');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
    expect(await page.locator('#pan-text').inputValue()).toBe('wasd and arrows');
    expect(await page.evaluate(() => (window as unknown as Hooks).__kqPhaser!())).toBeNull();
    // And it comes back when the player returns.
    await page.goto(new URL('/#/kitchen', page.url()).toString());
    await waitForKitchenScene(page);
    expect(await page.locator('#stage canvas').count()).toBe(1);
    expect(app.consoleErrors).toEqual([]);
  });

  it('arrow keys move the player, but not while typing in the Pan\'s text box', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await waitForKitchenScene(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const x0 = await page.evaluate(() => (window as unknown as Hooks).__kqPlayer!()!.x);
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowRight');
    const x1 = await page.evaluate(() => (window as unknown as Hooks).__kqPlayer!()!.x);
    expect(x1).toBeGreaterThan(x0);

    await page.getByRole('button', { name: 'Talk to the Pan' }).click();
    await page.locator('#pan-text').focus();
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowRight');
    expect(await page.evaluate(() => (window as unknown as Hooks).__kqPlayer!()!.x)).toBe(x1);
  });

  it('touch and mouse on the canvas do not block the page (no preventDefault)', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await waitForKitchenScene(page);
    const touch = await page.evaluate(() => (window as unknown as Hooks).__kqPhaser!()!.touchCapture);
    expect(touch).toBe(false);
    // Mid-floor, away from every hotspot (a hotspot click would leave the kitchen).
    const prevented = await page.evaluate(() => {
      const canvas = document.querySelector('#stage canvas')!;
      const r = canvas.getBoundingClientRect();
      const out: Record<string, boolean> = {};
      for (const type of ['mousedown', 'mousemove', 'mouseup']) {
        const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.2, clientY: r.top + r.height * 0.95 });
        canvas.dispatchEvent(ev);
        out[type] = ev.defaultPrevented;
      }
      return out;
    });
    expect(prevented).toEqual({ mousedown: false, mousemove: false, mouseup: false });
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

  it('opened from a canvas hotspot, the knife roll returns focus to the Knife roll button', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.getByRole('button', { name: 'Knife roll' }).waitFor();
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.dispatchEvent(new CustomEvent('kq:action', { detail: { id: 'toolkit' } }));
    });
    await page.getByRole('dialog', { name: 'Your knife roll' }).waitFor();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-action'))).toBe('toolkit');
  });

  it('no horizontal scroll after shrinking from wide to 400px', async () => {
    app = await openApp('/', { reducedMotion: true, width: 1280 });
    const { page } = app;
    await page.locator('#stage canvas').waitFor();
    await page.setViewportSize({ width: 400, height: 800 });
    await page.waitForTimeout(100);
    await expectNoHorizontalScroll(page);
  });
});
