import { afterEach, describe, expect, inject, it } from 'vitest';
import { offOrigin, type OpenedApp } from './helpers';
import { CHROME_BANNED, CONTENT_BANNED, RUSTY_SEED, SCREENS, bannedPattern, openScreen } from './screens';

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

type Page = OpenedApp['page'];

/**
 * Everything the page says, in two scopes: text inside a `[data-content]` element (written content) and the
 * rest (UI chrome), which also takes the title and the attributes a screen reader or a tooltip reads.
 */
async function rendered(page: Page): Promise<{ chrome: string[]; content: string[] }> {
  return page.evaluate(() => {
    const chrome: string[] = [document.title];
    const content: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      const text = n.textContent?.trim();
      if (!parent || !text || parent.closest('script, style')) continue;
      (parent.closest('[data-content]') ? content : chrome).push(text);
    }
    for (const el of document.querySelectorAll('[aria-label], [alt], [title], [placeholder]')) {
      for (const attr of ['aria-label', 'alt', 'title', 'placeholder']) {
        const v = el.getAttribute(attr)?.trim();
        if (v) (el.closest('[data-content]') ? content : chrome).push(v);
      }
    }
    return { chrome, content };
  });
}

const hits = (texts: string[], re: RegExp) => texts.filter((t) => re.test(t)).map((t) => `${re.exec(t)![0]} in “${t}”`);

describe('never rules, every screen', () => {
  it('the word lists build the patterns Step 12 names, plus the compliance words', () => {
    expect(CHROME_BANNED.test('Buy now')).toBe(true);
    expect(CHROME_BANNED.test('Recipe unlocked!')).toBe(true);
    expect(CHROME_BANNED.test('3 days in a row')).toBe(true);
    expect(CHROME_BANNED.test('Only $5')).toBe(true);
    expect(CHROME_BANNED.test('HIPAA compliant')).toBe(true);
    expect(CHROME_BANNED.test('Medical-grade advice')).toBe(true);
    expect(CHROME_BANNED.test('Leela taught you Parippu')).toBe(false);
    expect(CHROME_BANNED.test('Buyers')).toBe(false);
    expect(CONTENT_BANNED.test('buy the dark ones')).toBe(false);
    expect(CONTENT_BANNED.test("nobody's food is 'exotic'")).toBe(false);
    expect(CONTENT_BANNED.test('a streak of chili')).toBe(true);
    expect(CONTENT_BANNED.test('not HIPAA-anything')).toBe(true);
    expect(bannedPattern(['tip jar']).test('the tip jar')).toBe(true);
    for (const t of ['Top of the leaderboard', 'Refer a friend', 'Referrals pay', 'ethnic food', 'Recipes collected: 3']) {
      expect(CHROME_BANNED.test(t), t).toBe(true);
    }
    for (const t of ['See the leaderboards', 'Referral bonus', 'ethnic food', 'You collected a recipe']) expect(CONTENT_BANNED.test(t), t).toBe(true);
    expect(CONTENT_BANNED.test('I can refer you to a clinician')).toBe(false);
    expect(CHROME_BANNED.test('Never referred to by gender')).toBe(false);
  });

  for (const sc of SCREENS) {
    it(sc.label, async () => {
      app = await openScreen(sc);
      const { page } = app;
      const { chrome, content } = await rendered(page);
      expect(chrome.length, 'some chrome was read').toBeGreaterThan(0);
      expect(hits(chrome, CHROME_BANNED), `${sc.label}: UI chrome`).toEqual([]);
      expect(hits(content, CONTENT_BANNED), `${sc.label}: written content`).toEqual([]);
      expect(offOrigin(app.requests, inject('baseUrl')), `${sc.label}: requests off the app's origin`).toEqual([]);
      if (sc.label === 'mentor panel open (Family Table)') {
        expect(await page.locator('textarea, input[type="text"], #pan-talk').count(), 'Family Table: no text box').toBe(0);
      }
    });
  }

  it('the rusty knife roll uses no chili red anywhere', async () => {
    const sc = SCREENS.find((s) => s.seed === RUSTY_SEED)!;
    app = await openScreen(sc);
    const { page } = app;
    expect(await page.locator('.knife-roll .fresh-rusty').count(), 'a rusty technique is showing').toBeGreaterThan(0);
    const red = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--chili)';
      document.body.append(probe);
      const chili = getComputedStyle(probe).color;
      probe.remove();
      const bad = [...document.querySelectorAll('.knife-roll, .knife-roll *')].filter((e) => {
        const s = getComputedStyle(e);
        return s.color === chili || s.backgroundColor === chili;
      }).map((e) => e.outerHTML.slice(0, 100));
      return { chili, bad };
    });
    expect(red.chili).toMatch(/^rgb/);
    expect(red.chili).not.toBe('rgb(0, 0, 0)');
    expect(red.bad).toEqual([]);
  });
});
