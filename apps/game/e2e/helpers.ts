import AxeBuilder from '@axe-core/playwright';
import { chromium, type BrowserContext, type ConsoleMessage, type Page, type Request, type Response } from 'playwright';
import { expect, inject } from 'vitest';
import { STORE_KEY, type PlayerState } from '../src/state/store';

/**
 * A player who has finished Form 1-A and seen the AI disclosure (M4 Step 11): the panel opens straight to the
 * conversation. Tests about other things in the panel seed this so the intake doesn't start.
 */
export const PAN_READY: Partial<PlayerState> = { intake: { step: 'done' }, aiDisclosureSeen: true };

export interface OpenedApp {
  page: Page; context: BrowserContext; consoleErrors: string[]; requests: string[]; close(): Promise<void>;
  /** The first navigation's response (its headers), or null. */
  response: Response | null;
}

export async function openApp(
  path: string,
  opts: OpenOptions = {},
): Promise<OpenedApp> {
  return openAt(new URL(path, inject('baseUrl')).toString(), opts);
}

/** M7 Step 11: open the hands-free build (VITE_HANDS_FREE=on against the test fixture record; e2e/setup.ts). */
export function openHandsFreeApp(path: string, opts: OpenOptions = {}): Promise<OpenedApp> {
  return openAt(new URL(path, inject('handsFreeUrl')).toString(), opts);
}

/** Open a component fixture served from source (e2e/fixtures), not part of the production build. */
export function openFixture(path: string, opts: { width?: number; reducedMotion?: boolean } = {}): Promise<OpenedApp> {
  return openAt(new URL(path, inject('fixtureUrl')).toString(), opts);
}

interface OpenOptions {
  seed?: Partial<PlayerState>; reducedMotion?: boolean; width?: number; serviceWorkers?: 'allow' | 'block';
  userAgent?: string;
  /** Extra Chromium flags (M7 Step 11: the fake microphone). */
  launchArgs?: string[];
  /** Runs in the page before any of the app's scripts, on every load. */
  initScript?: string;
  /** Runs before the first navigation: register `page.route` mocks for `/api/**` here. */
  beforeGoto?: (page: Page, context: BrowserContext) => Promise<unknown>;
}

/** M2's "not signed in" answer. Every test gets it for `/api/**` unless it routes the API itself. */
const SIGNED_OUT = { status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in required' } }) };

/** Chromium logs every 4xx/5xx fetch as a console error; for the mocked API those are expected answers. */
const isApiStatusLog = (m: ConsoleMessage) =>
  m.text().startsWith('Failed to load resource') && /^\/api\//.test(new URL(m.location().url || 'about:blank', 'http://x').pathname);

async function openAt(url: string, opts: OpenOptions): Promise<OpenedApp> {
  const browser = await chromium.launch(opts.launchArgs ? { args: opts.launchArgs } : {});
  const context = await browser.newContext({
    viewport: { width: opts.width ?? 1280, height: 800 },
    serviceWorkers: opts.serviceWorkers ?? 'block',
    reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
    ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
  });
  if (opts.initScript) await context.addInitScript(opts.initScript);
  // No real API in game tests: anything not mocked by the test is "signed out". Match the path's start, not
  // '**/api/**', which also catches source modules like /src/api/client.ts on the dev (fixture) server.
  await context.route((u) => u.pathname.startsWith('/api/'), (r) => r.fulfill(SIGNED_OUT));
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
  page.on('console', (m) => { if (m.type() === 'error' && !isApiStatusLog(m)) consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => { consoleErrors.push(e.message); });
  page.on('request', (r) => { requests.push(r.url()); });
  let response: Response | null;
  try {
    await opts.beforeGoto?.(page, context);
    response = await page.goto(url);
  } catch (err) {
    await browser.close();
    throw err;
  }
  return { page, context, consoleErrors, requests, response, close: () => browser.close() };
}

export async function expectNoA11yViolations(page: Page, label: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => v.id), `${label}: axe violations`).toEqual([]);
}

/**
 * M7 Ruling 17: what a Family Table session wrote to the API, besides the device's Family Table report
 * (`PUT /api/voice/family-table { on: true, deviceId }`: the setting itself, so the server refuses voice too; never a record).
 * Asserts the report is sent, signed in, and only ever says on.
 */
export function writesBesidesFamilyTableReport(sent: Request[]): string[] {
  const report = (r: Request) => r.method() === 'PUT' && new URL(r.url()).pathname === '/api/voice/family-table';
  const reports = sent.filter(report);
  expect(reports.length, 'the Family Table report (Ruling 17)').toBeGreaterThan(0);
  // Fix round 2: with this install's random device id, the same one on every report (the server's block is per device).
  const ids = new Set<unknown>();
  for (const r of reports) {
    const body = r.postDataJSON() as { on: unknown; deviceId: unknown };
    expect(body).toEqual({ on: true, deviceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) as unknown });
    ids.add(body.deviceId);
  }
  expect(ids.size).toBe(1);
  return sent.filter((r) => r.method() !== 'GET' && !report(r)).map((r) => `${r.method()} ${new URL(r.url()).pathname}`);
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(m.s, `scrollWidth ${m.s} vs clientWidth ${m.c}`).toBeLessThanOrEqual(m.c);
}

/** Requests that left the app's origin. data: and blob: URLs never touch the network. */
export function offOrigin(requests: string[], base: string): string[] {
  return requests.filter((u) => !u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:'));
}
