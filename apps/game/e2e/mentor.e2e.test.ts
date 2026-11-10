import { afterEach, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectNoA11yViolations, openApp, type OpenedApp } from './helpers';

const pan = parse(readFileSync(fileURLToPath(new URL('../../../content/dialogue/pan.yaml', import.meta.url)), 'utf8')) as {
  triggers: Record<string, { lines: string[] }>;
};
const lines = (id: string) => pan.triggers[id].lines;

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

const lastPan = (page: OpenedApp['page']) => page.locator('#pan-panel .bubble.pan .bubble-text').last();

describe('mentor panel', () => {
  it('has a Pan button on every screen that opens the panel', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    for (const hash of ['#/', '#/map', '#/settings']) {
      await page.goto(new URL(`/${hash}`, inject('baseUrl')).toString());
      await page.reload();
      const btn = page.locator('#pan-button');
      await btn.waitFor();
      expect(await btn.getAttribute('aria-expanded')).toBe('false');
      await btn.click();
      expect(await page.locator('#pan-panel').isVisible()).toBe(true);
      expect(await btn.getAttribute('aria-expanded')).toBe('true');
    }
    expect(app.consoleErrors).toEqual([]);
  });

  it('answers thanks, other text and a rule statement from the script, and makes no requests', async () => {
    app = await openApp('/#/settings', { reducedMotion: true });
    const { page } = app;
    await page.locator('#pan-button').click();
    // The app's one start-up call (who is signed in) isn't the Pan's.
    const others = () => app!.requests.filter((u) => new URL(u).pathname !== '/api/me').length;
    const before = others();
    await page.locator('#pan-text').fill('thank you');
    await page.locator('#pan-panel').getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#pan-panel .bubble.you').filter({ hasText: 'thank you' }).waitFor();
    await lastPan(page).waitFor();
    expect(lines('thanks')).toContain((await lastPan(page).textContent())!);
    await page.locator('#pan-text').fill("what's for dinner");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#pan-panel .bubble.pan').length === 2);
    // M4: the scripted engine answers what it can't read with didnt_understand.
    expect(lines('didnt_understand')).toContain((await lastPan(page).textContent())!);
    // A rule statement gets the code-built read-back, spelled, with no request (the AI is off, nothing is written).
    await page.locator('#pan-text').fill("I'm allergic to sesame");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#pan-panel .bubble.pan').length === 3);
    expect(await lastPan(page).textContent()).toContain('S-E-S-A-M-E');
    expect(others()).toBe(before);
  });

  it('hold-to-talk plays voice.not_yet', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.locator('#pan-button').click();
    await page.locator('#pan-talk').focus();
    await page.keyboard.down('Space');
    expect(await page.locator('#pan-talk').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#pan-talk').textContent()).toBe('Listening…');
    await page.keyboard.up('Space');
    expect(await page.locator('#pan-talk').getAttribute('aria-pressed')).toBe('false');
    await lastPan(page).waitFor();
    expect(lines('voice.not_yet')).toContain((await lastPan(page).textContent())!);
  });

  it('Escape closes the panel and focuses the Pan button', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.locator('#pan-button').click();
    await page.keyboard.press('Escape');
    expect(await page.locator('#pan-panel').isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('pan-button');
  });

  it('types bubbles in with motion on, and a click finishes them', async () => {
    app = await openApp('/#/settings', { reducedMotion: false });
    const { page } = app;
    await page.locator('#pan-button').click();
    await page.locator('#pan-text').fill('hello');
    await page.keyboard.press('Enter');
    await page.locator('#pan-panel .bubble.pan .typed-visible').waitFor();
    await page.locator('#pan-panel .bubble.pan').click();
    await page.waitForFunction(() => document.querySelector('#pan-panel .is-typing') === null);
    expect(lines('didnt_understand')).toContain((await lastPan(page).textContent())!);
  });

  it('Family Table mode has no text box, form or talk button', async () => {
    app = await openApp('/', { reducedMotion: true, seed: { settings: { showCalories: false, reducedMotion: 'system', familyTable: true, iosNoteDismissed: false, aiMentor: true } } });
    const { page } = app;
    await page.locator('#pan-button').click();
    expect(await page.locator('#pan-panel textarea, #pan-panel input, #pan-panel form, #pan-talk').count()).toBe(0);
    expect(await page.locator('#pan-panel').isVisible()).toBe(true);
  });

  it('has no serious accessibility violations with the panel open, in both modes', async () => {
    app = await openApp('/', { reducedMotion: true });
    await app.page.locator('#pan-button').click();
    await expectNoA11yViolations(app.page, 'standard');
    await app.close();
    app = await openApp('/', { reducedMotion: true, seed: { settings: { showCalories: false, reducedMotion: 'system', familyTable: true, iosNoteDismissed: false, aiMentor: true } } });
    await app.page.locator('#pan-button').click();
    await expectNoA11yViolations(app.page, 'familyTable');
  });
});
