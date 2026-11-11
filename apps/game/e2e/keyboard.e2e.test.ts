import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { openApp, type OpenedApp } from './helpers';
import { LEELA_PIN } from './screens';

const leelaIntro = (parse(readFileSync(fileURLToPath(new URL('../../../content/cooks/leela.yaml', import.meta.url)), 'utf8')) as { intro: string[] }).intro;

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

type Page = OpenedApp['page'];

interface Focused { tag: string; id: string; text: string; label: string; interactive: boolean; ring: boolean; inDialog: string | null }

/**
 * What has focus, and whether it shows a focus ring: its outline or box-shadow differs from an unfocused copy
 * of itself (same classes, same place in the page). A `.btn` always has a box-shadow, so "has one" proves nothing,
 * and the browser's default ring doesn't count.
 */
const focused = (page: Page): Promise<Focused> => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return { tag: 'body', id: '', text: '', label: '', interactive: false, ring: false, inDialog: null };
  const look = (e: Element) => {
    const s = getComputedStyle(e);
    // 'auto' is the browser's own default ring, which ignores the game's palette: the game must draw its own.
    const outline = s.outlineStyle !== 'none' && s.outlineStyle !== 'auto' && parseFloat(s.outlineWidth) > 0
      ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` : 'none';
    return { outline, shadow: s.boxShadow };
  };
  const now = look(el);
  const copy = el.cloneNode(false) as HTMLElement;
  copy.removeAttribute('id');
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  el.after(copy);
  const rest = look(copy);
  copy.remove();
  return {
    tag: el.tagName.toLowerCase(), id: el.id, text: (el.textContent ?? '').trim(), label: el.getAttribute('aria-label') ?? '',
    interactive: el.matches('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    ring: (now.outline !== 'none' && now.outline !== rest.outline) || now.shadow !== rest.shadow,
    inDialog: el.closest('[role="dialog"]')?.getAttribute('aria-labelledby') ?? null,
  };
});

/** Every control the keyboard landed on: each must have shown a focus ring. */
const landed: Focused[] = [];
async function press(page: Page, key: string): Promise<Focused> {
  await page.keyboard.press(key);
  const f = await focused(page);
  if (f.interactive) landed.push(f);
  return f;
}
/** Tab (at most `max` times) until the focused element matches. */
async function tabTo(page: Page, what: string, match: (f: Focused) => boolean, max = 40): Promise<void> {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    const f = await press(page, 'Tab');
    if (match(f)) return;
    seen.push(`${f.tag}#${f.id} “${f.text.slice(0, 40)}”`);
  }
  throw new Error(`Tab never reached ${what}; went through: ${seen.join(' → ')}`);
}
const named = (name: string | RegExp) => (f: Focused) => (typeof name === 'string' ? f.text === name || f.label === name : name.test(f.text));
const hash = (page: Page) => page.evaluate(() => location.hash);

describe('keyboard only, kitchen to certificate and back', () => {
  it('plays the whole loop with Tab, Enter, arrows and Escape, and every control shows its focus', async () => {
    landed.length = 0;
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.locator('#view h1', { hasText: 'Your kitchen' }).waitFor();

    await tabTo(page, 'Go out to the world map', named('Go out to the world map'));
    await press(page, 'Enter');
    await page.waitForFunction(() => location.hash === '#/map');
    await page.locator('.map-pin').first().waitFor();

    await tabTo(page, 'the Leela pin', named(LEELA_PIN));
    await press(page, 'Enter');
    await page.getByRole('dialog', { name: 'Travel Permit' }).waitFor();
    expect((await focused(page)).inDialog, 'the permit dialog has focus').not.toBeNull();
    await tabTo(page, 'Stamp it ✔', named('Stamp it ✔'));
    await press(page, 'Enter');
    await page.waitForFunction(() => location.hash === '#/visit/leela');

    // The intro's "next" button takes focus; Enter goes through every line.
    await page.locator('.dialogue .dialogue-next').waitFor();
    expect((await focused(page)).text).not.toBe('');
    for (const line of leelaIntro) {
      await page.locator('.dialogue .dialogue-text .typed-full').filter({ hasText: line }).waitFor();
      await press(page, 'Enter');
    }
    // M5 Step 9: Leela's quest follows the intro. Enter through its lines; at the errand, Tab to "Not yet" to pause it.
    await page.locator('.quest-panel').or(page.locator('.dialogue')).first().waitFor();
    while (await page.locator('.quest-panel').count() === 0) {
      await page.locator('.dialogue .dialogue-next').waitFor();
      expect((await focused(page)).text, 'the dialogue keeps focus on its button').toMatch(/Next|Done/);
      await press(page, 'Enter');
      await page.locator('.quest-panel').or(page.locator('.dialogue')).first().waitFor();
    }
    expect((await focused(page)).text, 'the quest panel focuses its first answer').toBe("I've got it");
    await tabTo(page, 'Not yet', named('Not yet'));
    await press(page, 'Enter');
    await page.locator('.quest-panel').waitFor({ state: 'detached' });
    await page.locator('.dialogue').waitFor({ state: 'detached' });
    await tabTo(page, 'See the recipe: Parippu', named('See the recipe: Parippu'));
    await press(page, 'Enter');
    await page.locator('.visit-card .recipe-card').waitFor();
    await tabTo(page, 'Cook it', named(/Cook it/));
    await press(page, 'Enter');
    await page.waitForFunction(() => location.hash === '#/cook/india/kerala/parippu');
    await page.locator('.cook-progress').waitFor();
    expect((await focused(page)).tag, 'cook mode puts focus on its h1').toBe('h1');

    await press(page, 'ArrowRight');
    expect(await page.locator('.cook-progress').textContent()).toBe('Step 2 of 7');
    await tabTo(page, 'the timer button', (f) => /timer/i.test(f.text) && f.tag === 'button');
    await press(page, 'Enter');
    expect(await page.getByRole('group', { name: 'Running timers' }).textContent()).toContain('Step 2');

    for (let i = 0; i < 5; i++) await press(page, 'ArrowRight');
    expect(await page.locator('.cook-progress').textContent()).toBe('Step 7 of 7');
    await tabTo(page, 'Done ▶', named(/^Done/));
    await press(page, 'Enter');
    const cert = page.getByRole('dialog', { name: /Certificate of a Dish Cooked/ });
    await cert.waitFor();
    await tabTo(page, 'Continue', named('Continue'));
    await press(page, 'Enter');
    await page.waitForFunction(() => location.hash === '#/kitchen');
    await page.locator('#view h1', { hasText: 'Your kitchen' }).waitFor();

    await tabTo(page, '#pan-button', (f) => f.id === 'pan-button');
    await press(page, 'Enter');
    expect(await page.locator('#pan-panel').isVisible()).toBe(true);
    expect((await focused(page)).id, 'the panel puts focus in its text box').toBe('pan-text');
    const before = await page.locator('#pan-panel .bubble.pan').count();
    await page.keyboard.type('thanks');
    await press(page, 'Enter');
    await page.waitForFunction((n) => document.querySelectorAll('#pan-panel .bubble.pan').length > n, before);
    await press(page, 'Escape');
    expect(await page.locator('#pan-panel').isVisible()).toBe(false);
    expect((await focused(page)).id).toBe('pan-button');

    expect(await hash(page)).toBe('#/kitchen');
    expect(landed.length).toBeGreaterThan(10);
    const noRing = landed.filter((f) => !f.ring).map((f) => `${f.tag}#${f.id} “${f.text.slice(0, 40)}”`);
    expect(noRing, 'focused controls with no visible focus style').toEqual([]);
    expect(app.consoleErrors).toEqual([]);
  });
});
