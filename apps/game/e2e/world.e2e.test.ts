import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { expectNoA11yViolations, expectNoHorizontalScroll, openApp, PAN_READY, type OpenedApp } from './helpers';

const yaml = <T>(rel: string): T => parse(readFileSync(fileURLToPath(new URL(`../../../content/${rel}`, import.meta.url)), 'utf8')) as T;
const leela = yaml<{ name: string; intro: string[] }>('cooks/leela.yaml');
// The card's title is the recipe's own, from its front matter.
const PARIPPU_TITLE = /^title: (.+)$/m.exec(readFileSync(fileURLToPath(new URL('../../../recipes/india/kerala/parippu.cook', import.meta.url)), 'utf8'))![1];
const pan = yaml<{ triggers: Record<string, { lines: string[] }> }>('dialogue/pan.yaml');

const PIN_NAMES = [
  'Visit Doña Marisol — Oaxaca, Mexico',
  'Visit Ammachi Leela — Kochi, Kerala, India',
  'Visit Haruka — Osaka, Japan',
];
const LEELA_PIN = 'Visit Ammachi Leela — Kochi, Kerala, India';
const coconutSevere = { id: 'r1', target: { kind: 'ingredient' as const, ids: ['coconut'] }, type: 'avoid' as const, severity: 'anaphylactic' as const };
const BANNED = /\b(unlock(ed)?|loot(ed)?|discovered|exotic|acquired)\b/i;

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

type Page = OpenedApp['page'];
const dialogueText = (page: Page) => page.locator('.dialogue .dialogue-text .typed-full');

/** Text on the page that the UI wrote itself: everything outside `[data-content]`. */
async function chromeText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || parent.closest('[data-content], script, style')) continue;
      out.push(n.textContent ?? '');
    }
    const labels = [...document.querySelectorAll('[aria-label]')].filter((e) => !e.closest('[data-content]')).map((e) => e.getAttribute('aria-label'));
    return [...out, ...labels].join(' ');
  });
}

async function openPermit(page: Page): Promise<void> {
  await page.getByRole('button', { name: LEELA_PIN }).click();
  await page.getByRole('dialog', { name: 'Travel Permit' }).waitFor();
}

/** Map → permit → stamp → Leela's kitchen, intro played to the end. */
async function visitLeela(page: Page): Promise<void> {
  await openPermit(page);
  await page.getByRole('button', { name: 'Stamp it ✔' }).click();
  await page.waitForFunction(() => location.hash === '#/visit/leela');
  for (let i = 0; i < leela.intro.length; i += 1) {
    await dialogueText(page).filter({ hasText: leela.intro[i] }).waitFor();
    await page.locator('.dialogue .dialogue-next').click();
  }
  await page.getByRole('button', { name: 'See the recipe: Parippu' }).waitFor();
}

describe('world map', () => {
  it('shows a pin button for each cook', async () => {
    app = await openApp('/#/map', { reducedMotion: true });
    const { page } = app;
    await page.locator('#view h1', { hasText: 'World map' }).waitFor();
    const pins = page.locator('.map-pin');
    expect(await pins.count()).toBe(3);
    for (const name of PIN_NAMES) expect(await page.getByRole('button', { name }).isVisible(), name).toBe(true);
    const footnote = (await page.locator('.map-footnote').textContent())!;
    expect(footnote.startsWith('*')).toBe(true);
    expect(chromeTextOk(await chromeText(page))).toBe(true);
    await expectNoA11yViolations(page, 'map');
    expect(app.consoleErrors).toEqual([]);
  });

  it('a pin opens the travel permit; "Not quite" closes it and returns focus to the pin', async () => {
    app = await openApp('/#/map', { reducedMotion: true });
    const { page } = app;
    await openPermit(page);
    const dialog = page.getByRole('dialog', { name: 'Travel Permit' });
    const text = (await dialog.textContent())!;
    for (const want of ['FORM 9-T/TRAVEL', 'Travel Permit', 'Kochi, Kerala, India', 'To learn, if taught', 'Ammachi Leela', 'Guest. Invited.']) {
      expect(text, want).toContain(want);
    }
    await expectNoA11yViolations(page, 'travel permit');
    await page.getByRole('button', { name: 'Not quite' }).click();
    expect(await page.getByRole('dialog', { name: 'Travel Permit' }).count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(LEELA_PIN);
    expect(await page.evaluate(() => location.hash)).toBe('#/map');
  });

  it('stamping travels to the cook, who says the intro in order; then the recipe card and cook mode', async () => {
    app = await openApp('/#/map', { reducedMotion: true });
    const { page } = app;
    await openPermit(page);
    await page.getByRole('button', { name: 'Stamp it ✔' }).click();
    await page.waitForFunction(() => location.hash === '#/visit/leela');
    await page.locator('#view h1', { hasText: "Ammachi Leela's kitchen" }).waitFor();
    expect(await page.locator('#view').textContent()).toContain('Kochi, Kerala, India');
    expect(await page.locator('#view').textContent()).toContain('Ammachi Leela will teach you Parippu');
    // The Pan said its departure line.
    const depart = pan.triggers['travel.depart'].lines.map((l) => l.replace('{cook}', 'Ammachi Leela').replace('{place}', 'Kochi, Kerala, India'));
    expect(depart).toContain(await page.locator('#pan-panel .bubble.pan .bubble-text').last().textContent());

    await dialogueText(page).waitFor();
    expect(await dialogueText(page).textContent()).toBe(leela.intro[0]);
    await expectNoA11yViolations(page, 'visit dialogue');
    expect(chromeTextOk(await chromeText(page))).toBe(true);
    await page.locator('.dialogue .dialogue-next').focus();
    await page.keyboard.press('Enter');
    await dialogueText(page).filter({ hasText: leela.intro[1] }).waitFor();
    for (let i = 1; i < leela.intro.length; i += 1) {
      expect(await dialogueText(page).textContent()).toBe(leela.intro[i]);
      await page.locator('.dialogue .dialogue-next').click();
    }
    expect(await page.locator('.dialogue').count()).toBe(0);

    await page.getByRole('button', { name: 'See the recipe: Parippu' }).click();
    const card = page.getByRole('dialog', { name: PARIPPU_TITLE });
    await card.waitFor();
    expect(await card.locator('h2').textContent()).toBe(PARIPPU_TITLE);
    await expectNoA11yViolations(page, 'visit card');
    expect(chromeTextOk(await chromeText(page))).toBe(true);
    await card.getByRole('button', { name: /Cook it/ }).click();
    await page.waitForFunction(() => location.hash === '#/cook/india/kerala/parippu');
    expect(await page.getByRole('dialog', { name: PARIPPU_TITLE }).count()).toBe(0);
    expect(app.consoleErrors).toEqual([]);
  });

  it('"Hear the intro again" replays it from the first line; "Back to the map" goes back', async () => {
    app = await openApp('/#/map', { reducedMotion: true });
    const { page } = app;
    await visitLeela(page);
    await page.getByRole('button', { name: 'Hear the intro again' }).click();
    await dialogueText(page).waitFor();
    expect(await dialogueText(page).textContent()).toBe(leela.intro[0]);
    await page.getByRole('button', { name: 'Back to the map' }).click();
    await page.locator('#view h1', { hasText: 'World map' }).waitFor();
    expect(await page.locator('.dialogue').count()).toBe(0);
  });

  it('a severe coconut rule disables the visit card\'s Cook button; the pin stays on the map', async () => {
    app = await openApp('/#/map', { reducedMotion: true, seed: { v: 1, localRules: [coconutSevere] } });
    const { page } = app;
    expect(await page.getByRole('button', { name: LEELA_PIN }).isVisible()).toBe(true);
    await visitLeela(page);
    await page.getByRole('button', { name: 'See the recipe: Parippu' }).click();
    const card = page.getByRole('dialog', { name: PARIPPU_TITLE });
    await card.waitFor();
    expect(await card.getByRole('button', { name: /Cook it/ }).isDisabled()).toBe(true);
    expect(await card.textContent()).toContain("Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels.");
  });

  it('the open visit card follows a rule change from another tab (it never goes stale)', async () => {
    app = await openApp('/#/map', { reducedMotion: true, seed: { v: 1, localRules: [] } });
    const { page } = app;
    await visitLeela(page);
    await page.getByRole('button', { name: 'See the recipe: Parippu' }).click();
    const card = page.getByRole('dialog', { name: PARIPPU_TITLE });
    await card.waitFor();
    expect(await card.getByRole('button', { name: /Cook it/ }).isDisabled()).toBe(false);
    // Another tab adds a severe coconut rule: storage changes and this tab hears a storage event.
    await page.evaluate(({ key, rule }) => {
      const s = JSON.parse(localStorage.getItem(key)!) as { localRules: unknown[] };
      s.localRules = [rule];
      localStorage.setItem(key, JSON.stringify(s));
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }, { key: 'kq.player.v1', rule: coconutSevere });
    await card.getByRole('button', { name: /Cook it/ }).and(page.locator(':disabled')).waitFor();
    expect(await card.textContent()).toContain("Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels.");
    // Still one labelled dialog, its heading focusable, and focus kept inside it.
    expect(await page.getByRole('dialog').count()).toBe(1);
    expect(await page.evaluate(() => document.querySelector('.visit-card')!.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached' });
    expect(app.consoleErrors).toEqual([]);
  });

  it('keyboard: Tab reaches the Leela pin, Enter opens the permit, Escape returns focus to the pin', async () => {
    app = await openApp('/#/map', { reducedMotion: true });
    const { page } = app;
    await page.locator('.map-pin').first().waitFor();
    let reached = false;
    for (let i = 0; i < 15 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = (await page.evaluate(() => document.activeElement?.textContent)) === LEELA_PIN;
    }
    expect(reached, 'Tab reaches the Leela pin').toBe(true);
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Travel Permit' }).waitFor();
    await page.keyboard.press('Escape');
    expect(await page.getByRole('dialog', { name: 'Travel Permit' }).count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(LEELA_PIN);
  });

  for (const from of ['its button', 'the canvas hotspot'] as const) {
    it(`when an intro replayed from ${from} ends, focus goes to "Hear the intro again"`, async () => {
      app = await openApp('/#/map', { reducedMotion: true });
      const { page } = app;
      await visitLeela(page);
      if (from === 'its button') {
        await page.getByRole('button', { name: 'Hear the intro again' }).focus();
        await page.keyboard.press('Enter');
      } else {
        // A canvas click leaves focus on the body, then the scene emits the action.
        await page.evaluate(() => {
          (document.activeElement as HTMLElement | null)?.blur();
          window.dispatchEvent(new CustomEvent('kq:action', { detail: { id: 'intro' } }));
        });
      }
      await dialogueText(page).waitFor();
      for (let i = 0; i < leela.intro.length; i += 1) await page.keyboard.press('Enter');
      expect(await page.locator('.dialogue').count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Hear the intro again');
    });
  }

  it('while the intro replays, "See the recipe" cannot open the card over it', async () => {
    app = await openApp('/#/map', { reducedMotion: true });
    const { page } = app;
    await visitLeela(page);
    await page.getByRole('button', { name: 'Hear the intro again' }).click();
    await dialogueText(page).waitFor();
    const see = page.getByRole('button', { name: 'See the recipe: Parippu' });
    expect(await see.isDisabled()).toBe(true);
    await see.dispatchEvent('click');
    expect(await page.getByRole('dialog', { name: PARIPPU_TITLE }).count()).toBe(0);
    for (let i = 0; i < leela.intro.length; i += 1) await page.locator('.dialogue .dialogue-next').click();
    expect(await see.isDisabled()).toBe(false);
    await see.click();
    await page.getByRole('dialog', { name: PARIPPU_TITLE }).waitFor();
  });

  for (const [where, hash, breakIt] of [
    // renderActionBar listens on window for canvas actions: make that throw, after the backdrop has mounted.
    ['the map', '#/map', 'listener'],
    // The visit's intro reads the reduced-motion media query after the backdrop has mounted.
    ['a visit', '#/visit/leela', 'matchMedia'],
  ] as const) {
    it(`a screen that fails after its backdrop mounted (${where}) still puts #stage back home`, async () => {
      app = await openApp('/#/settings', { reducedMotion: true });
      const { page } = app;
      await page.locator('#view h1').waitFor();
      await page.evaluate((how) => {
        const w = window as unknown as Record<string, unknown>;
        if (how === 'listener') {
          const orig = window.addEventListener.bind(window);
          w.__kqRestore = () => { window.addEventListener = orig; };
          window.addEventListener = ((type: string, ...rest: never[]) => {
            if (type === 'kq:action') throw new Error('test: broken after the backdrop');
            return (orig as (...a: unknown[]) => void)(type, ...rest);
          }) as typeof window.addEventListener;
        } else {
          const orig = window.matchMedia.bind(window);
          w.__kqRestore = () => { window.matchMedia = orig; };
          window.matchMedia = () => { throw new Error('test: broken after the backdrop'); };
        }
      }, breakIt);
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.locator('#view h1', { hasText: 'Something went off the boil' }).waitFor();
      expect(await page.evaluate(() => document.querySelector('#stage')?.parentElement?.id)).toBe('screen');
      await page.evaluate(() => { (window as unknown as { __kqRestore(): void }).__kqRestore(); location.hash = '#/kitchen'; });
      await page.locator('#view h1', { hasText: 'Your kitchen' }).waitFor();
      await page.locator('#screen > #stage canvas').waitFor();
      app.consoleErrors.length = 0; // the forced failure logs by design
    });
  }

  it('an unknown cook is not found', async () => {
    app = await openApp('/#/visit/nobody', { reducedMotion: true });
    await app.page.locator('#view h1', { hasText: 'Not found' }).waitFor();
  });

  it('works with the Phaser chunk blocked', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    const blocked: string[] = [];
    await page.route('**/assets/phaser-*.js', (r) => { blocked.push(r.request().url()); return r.abort(); });
    await page.goto(new URL('/#/map', page.url()).toString());
    await page.reload();
    await page.locator('#view h1', { hasText: 'World map' }).waitFor();
    await page.locator('#view img.map-backdrop-img').waitFor();
    await page.waitForFunction(() => document.querySelector('#stage') !== null);
    await visitLeela(page);
    await page.locator('#view img.visit-backdrop-img').waitFor();
    expect(blocked.length, 'the phaser chunk was requested and blocked').toBeGreaterThan(0);
    expect(await page.locator('#stage canvas').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __kqScene?: string | null }).__kqScene ?? null)).toBeNull();
  });

  it('with Phaser loaded, the map and the cook\'s kitchen run their scenes behind the HTML', async () => {
    app = await openApp('/#/map', { reducedMotion: true });
    const { page } = app;
    await page.waitForFunction(() => (window as unknown as { __kqScene?: string | null }).__kqScene === 'Map');
    expect(await page.locator('#stage[aria-hidden="true"] canvas').count()).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { __kqTweens: () => number }).__kqTweens())).toBe(0);
    await visitLeela(page);
    await page.waitForFunction(() => (window as unknown as { __kqScene?: string | null }).__kqScene === 'CookKitchen');
    expect(await page.evaluate(() => (window as unknown as { __kqTweens: () => number }).__kqTweens())).toBe(0);
  });

  it('"Talk to the Pan" on the map says a map remark', async () => {
    app = await openApp('/#/map', { reducedMotion: true, seed: PAN_READY });
    const { page } = app;
    await page.getByRole('button', { name: 'Talk to the Pan' }).click();
    const bubble = page.locator('#pan-panel .bubble.pan .bubble-text').last();
    await bubble.waitFor();
    expect(pan.triggers['travel.map_remark'].lines).toContain(await bubble.textContent());
    expect(await page.locator('#pan-panel').isVisible()).toBe(true);
  });

  it('"Home kitchen" goes home', async () => {
    app = await openApp('/#/map', { reducedMotion: true });
    const { page } = app;
    await page.getByRole('button', { name: 'Home kitchen' }).click();
    await page.waitForFunction(() => location.hash === '#/kitchen');
  });

  for (const width of [400, 320]) it(`at width ${width} there is no horizontal scroll, and the pins are at least 44px and stay on the backdrop`, async () => {
    app = await openApp('/#/map', { reducedMotion: true, width });
    const { page } = app;
    await page.locator('.map-pin').first().waitFor();
    await expectNoHorizontalScroll(page);
    const frame = (await page.locator('.map-backdrop-frame').boundingBox())!;
    expect(frame.width).toBeGreaterThan(0);
    for (const pin of await page.locator('.map-pin').all()) {
      const b = (await pin.boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.x).toBeGreaterThanOrEqual(frame.x - 0.5);
      expect(b.y).toBeGreaterThanOrEqual(frame.y - 0.5);
      expect(b.x + b.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
    }
  });
});

function chromeTextOk(text: string): boolean {
  if (BANNED.test(text)) throw new Error(`UI chrome uses a banned word: ${BANNED.exec(text)![0]} in “${text}”`);
  return true;
}
