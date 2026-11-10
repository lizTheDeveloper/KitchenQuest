import { afterEach, describe, expect, it } from 'vitest';
import { expectNoA11yViolations, expectNoHorizontalScroll, type OpenedApp } from './helpers';
import { SCREENS, openScreen } from './screens';

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

type Page = OpenedApp['page'];

/** Visible h1s, buttons/links without an accessible name, and imgs with no alt attribute. */
async function structure(page: Page) {
  return page.evaluate(() => {
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const h1s = [...document.querySelectorAll('h1')].filter(visible).map((e) => e.textContent);
    // Accessible name, the parts these screens use: aria-labelledby, aria-label, text, an img's alt, title.
    const name = (e: Element): string => {
      const by = e.getAttribute('aria-labelledby');
      if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      const label = e.getAttribute('aria-label');
      if (label?.trim()) return label.trim();
      const text = (e as HTMLElement).innerText?.trim() || e.textContent?.trim();
      if (text) return text;
      const alts = [...e.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt')).join(' ').trim();
      return alts || (e.getAttribute('title') ?? '').trim();
    };
    const unnamed = [...document.querySelectorAll('button, a')].filter(visible).filter((e) => !name(e)).map((e) => e.outerHTML.slice(0, 120));
    const noAlt = [...document.querySelectorAll('img')].filter((e) => !e.hasAttribute('alt')).map((e) => e.outerHTML.slice(0, 120));
    const stage = document.getElementById('stage');
    return { h1s, unnamed, noAlt, stage: stage ? stage.getAttribute('aria-hidden') : null };
  });
}

describe('accessibility sweep, every screen', () => {
  for (const sc of SCREENS) {
    it(sc.label, async () => {
      app = await openScreen(sc);
      const { page } = app;
      await expectNoA11yViolations(page, sc.label);
      const s = await structure(page);
      expect(s.h1s, `${sc.label}: exactly one visible h1`).toHaveLength(1);
      expect(s.unnamed, `${sc.label}: buttons and links without a name`).toEqual([]);
      expect(s.noAlt, `${sc.label}: images without alt`).toEqual([]);
      // The sign-in landing page is its own document, with no game stage at all.
      if (!sc.path.startsWith('/auth/')) expect(s.stage, `${sc.label}: #stage is aria-hidden`).toBe('true');

      await page.setViewportSize({ width: 400, height: 800 });
      await expectNoHorizontalScroll(page);

      await page.emulateMedia({ colorScheme: 'dark' });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      expect(await page.locator('h1').filter({ visible: true }).count(), `${sc.label}: h1 at 200% text`).toBe(1);
      const primary = sc.primary(page);
      expect(await primary.isVisible(), `${sc.label}: primary action at 200% text`).toBe(true);
      await primary.scrollIntoViewIfNeeded();
      const reach = await primary.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          // 1px of slack for sub-pixel layout at 200% text.
          inView: r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
          covered: hit !== el && !el.contains(hit) ? (hit?.outerHTML.slice(0, 100) ?? 'nothing') : null,
        };
      });
      expect(reach.inView, `${sc.label}: primary action fits in the viewport at 200% text`).toBe(true);
      expect(reach.covered, `${sc.label}: primary action is not covered at 200% text`).toBeNull();
      await expectNoHorizontalScroll(page);
      expect(app.consoleErrors).toEqual([]);
    });
  }
});
