import AxeBuilder from '@axe-core/playwright';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { expect, inject } from 'vitest';
import { STORE_KEY, type PlayerState } from '../src/state/store';

export interface OpenedApp {
  page: Page; context: BrowserContext; consoleErrors: string[]; requests: string[]; close(): Promise<void>;
}

export async function openApp(
  path: string,
  opts: { seed?: Partial<PlayerState>; reducedMotion?: boolean; width?: number; serviceWorkers?: 'allow' | 'block' } = {},
): Promise<OpenedApp> {
  return openAt(new URL(path, inject('baseUrl')).toString(), opts);
}

/** Open a component fixture served from source (e2e/fixtures), not part of the production build. */
export function openFixture(path: string, opts: { width?: number; reducedMotion?: boolean } = {}): Promise<OpenedApp> {
  return openAt(new URL(path, inject('fixtureUrl')).toString(), opts);
}

async function openAt(
  url: string,
  opts: { seed?: Partial<PlayerState>; reducedMotion?: boolean; width?: number; serviceWorkers?: 'allow' | 'block' },
): Promise<OpenedApp> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: opts.width ?? 1280, height: 800 },
    serviceWorkers: opts.serviceWorkers ?? 'block',
    reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
  });
  if (opts.seed) {
    // Seed only when nothing is stored yet, so a reload keeps what the app saved.
    await context.addInitScript(
      ({ key, seed }) => {
        try { if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(seed)); } catch { /* ignore */ }
      },
      { key: STORE_KEY, seed: opts.seed },
    );
  }
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const requests: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => { consoleErrors.push(e.message); });
  page.on('request', (r) => { requests.push(r.url()); });
  try {
    await page.goto(url);
  } catch (err) {
    await browser.close();
    throw err;
  }
  return { page, context, consoleErrors, requests, close: () => browser.close() };
}

export async function expectNoA11yViolations(page: Page, label: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => v.id), `${label}: axe violations`).toEqual([]);
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(m.s, `scrollWidth ${m.s} vs clientWidth ${m.c}`).toBeLessThanOrEqual(m.c);
}

/** Requests that left the app's origin. data: and blob: URLs never touch the network. */
export function offOrigin(requests: string[], base: string): string[] {
  return requests.filter((u) => !u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:'));
}
