import { afterEach, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Request } from 'playwright';
import { buildProfileCard, UNDO_WINDOW_MS } from '@kitchenquest/core/engine';
import { expectNoA11yViolations, openApp, PAN_READY, type OpenedApp } from './helpers';

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

  it('a long text-only conversation stays axe-clean: the scrollable list is focusable and named', async () => {
    app = await openApp('/#/settings', { reducedMotion: true, seed: PAN_READY });
    const { page } = app;
    await page.locator('#pan-button').click();
    for (let n = 1; n <= 14; n++) {
      await page.locator('#pan-text').fill('thank you');
      await page.locator('#pan-text').press('Enter');
      await page.waitForFunction((k) => document.querySelectorAll('#pan-panel .bubble.pan').length >= k, n);
    }
    const list = page.locator('#pan-panel .bubbles');
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight), 'the list scrolls').toBe(true);
    expect(await list.getAttribute('tabindex')).toBe('0');
    expect(await list.getAttribute('aria-label')).toBe('Conversation with the Pan');
    await expectNoA11yViolations(page, 'long conversation');
    await list.focus();
    expect(await page.evaluate(() => document.activeElement?.classList.contains('bubbles'))).toBe(true);
  });

  it('answers thanks, other text and a rule statement from the script, and makes no requests', async () => {
    app = await openApp('/#/settings', { reducedMotion: true, seed: PAN_READY });
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
    await page.locator('#pan-text').fill('tell me a joke');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#pan-panel .bubble.pan').length === 2);
    // M4: the scripted engine answers what it can't read with didnt_understand.
    expect(lines('didnt_understand')).toContain((await lastPan(page).textContent())!);
    // A rule statement gets the code-built read-back, spelled, with no request (the AI is off, nothing is written).
    await page.locator('#pan-text').fill("I'm allergic to sesame");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#pan-panel .bubble.pan').length >= 3);
    // The read-back (and, when it asks "Is that right?", the tap line after it), with the card.
    expect(await page.locator('#pan-panel .bubble.pan .bubble-text').nth(2).textContent()).toContain('S-E-S-A-M-E');
    expect(await page.locator('#pan-panel .pan-card').textContent()).toContain('S-E-S-A-M-E');
    // (The card's slip loads its fonts; only API calls count.)
    expect(app.requests.filter((u) => new URL(u).pathname !== '/api/me').slice(before).filter((u) => new URL(u).pathname.startsWith('/api/'))).toEqual([]);
  });

  // M7 Step 6: voice.not_yet is gone; the talk control sends and says nothing until Step 9 wires the voice controller.
  it('hold-to-talk presses and releases, and sends and says nothing yet', async () => {
    app = await openApp('/', { reducedMotion: true });
    const { page } = app;
    await page.locator('#pan-button').click();
    const bubbles = await page.locator('#pan-panel .bubble').count();
    const before = app.requests.length;
    await page.locator('#pan-talk').focus();
    await page.keyboard.down('Space');
    expect(await page.locator('#pan-talk').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#pan-talk').textContent()).toBe('Listening…');
    await page.keyboard.up('Space');
    expect(await page.locator('#pan-talk').getAttribute('aria-pressed')).toBe('false');
    await page.waitForTimeout(300);
    expect(await page.locator('#pan-panel .bubble').count()).toBe(bubbles);
    expect(app.requests.slice(before).filter((u) => new URL(u).pathname.startsWith('/api/mentor'))).toEqual([]);
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
    app = await openApp('/#/settings', { reducedMotion: false, seed: PAN_READY });
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
    app = await openApp('/', { reducedMotion: true, seed: { settings: { showCalories: false, reducedMotion: 'system', familyTable: true, iosNoteDismissed: false, aiMentor: true, rescueNudges: true } } });
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
    app = await openApp('/', { reducedMotion: true, seed: { settings: { showCalories: false, reducedMotion: 'system', familyTable: true, iosNoteDismissed: false, aiMentor: true, rescueNudges: true } } });
    await app.page.locator('#pan-button').click();
    await expectNoA11yViolations(app.page, 'familyTable');
  });
});

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const DISCLAIMER = "Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels.";
const panText = (page: Page) => page.locator('#pan-panel .bubble.pan .bubble-text');
const panTexts = async (page: Page) => (await panText(page).allTextContents());
const tell = async (page: Page, text: string) => {
  const before = await panText(page).count();
  await page.locator('#pan-text').fill(text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#pan-panel .bubble.pan').length > n, before);
};
const filled = (id: string, vars: Record<string, string>) => lines(id).map((l) => l.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? ''));
const BOTH_CONSENTS = {
  consents: ['health_data', 'ai_health'].map((purpose) => ({ purpose, noticeVersion: purpose === 'health_data' ? 'v3' : 'v1', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true })),
  needsReconsent: [], notices: {},
};
/** Signed in with the AI mentor on: /me, /rules and /me/consents answered; `extra` routes the mentor. */
const signedIn = (extra: (page: Page) => Promise<unknown>) => async (page: Page) => {
  await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
  await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
  await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, BOTH_CONSENTS)));
  await extra(page);
};

describe('mentor cards, trail and AI backend (M4 Step 10)', () => {
  it('AI off: say an allergy, get a 27-B card, a typed yes asks for a tap, a tap stamps it, and the dish is blocked', async () => {
    app = await openApp('/#/settings', { reducedMotion: true, seed: PAN_READY });
    const { page } = app;
    await page.locator('#pan-button').click();
    await tell(page, "I'm allergic to coconut");
    const card = page.locator('#pan-panel .pan-card');
    await card.waitFor();
    expect(await card.textContent()).toContain('C-O-C-O-N-U-T');
    expect(await card.textContent()).toContain('27-B/ALLERGEN');
    await tell(page, 'yes');
    expect(filled('rule.tap_needed', { ingredient: 'coconut' })).toContain((await panTexts(page)).at(-1));
    expect(await page.locator('#pan-panel .trail-entry').count()).toBe(0);
    await card.getByRole('button', { name: 'Stamp it ✔' }).click();
    const entry = page.locator('#pan-panel .trail-entry');
    await entry.waitFor();
    expect(await entry.locator('.trail-text').textContent()).toBe('🛡 Stamped: coconut, an allergy');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { location.hash = '#/recipe/india/kerala/parippu'; });
    await page.locator('.recipe-card').waitFor();
    expect((await page.locator('.recipe-card .recipe-status .chip').textContent())!.toLowerCase()).toContain('blocked');
    expect(await page.textContent('body')).toContain(DISCLAIMER);
    // Nothing went to the server: the AI is off and the rule lives on this device.
    expect(app.requests.filter((u) => new URL(u).pathname.startsWith('/api/mentor'))).toEqual([]);
    expect(app.consoleErrors).toEqual([]);
  });

  it('AI on: a server card is confirmed with exactly one POST { channel: "tap", conversationId } on a double click', async () => {
    const card = buildProfileCard({ marketDays: [6] });
    const confirms: Request[] = [];
    const turnBodies: unknown[] = [];
    app = await openApp('/#/settings', {
      reducedMotion: true,
      seed: PAN_READY,
      beforeGoto: signedIn(async (page) => {
        await page.route((u) => u.pathname === '/api/mentor/turn', (r) => {
          turnBodies.push(r.request().postDataJSON());
          return r.fulfill(json(200, {
            conversationId: 'c1', route: 'ai', notice: null, toolTurn: true, actions: [],
            parts: [{ kind: 'line', line: card.readback[0] }, { kind: 'text', text: 'MODEL WORDS' }],
            cards: [{ proposalId: 'P1', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), card }],
          }));
        });
        await page.route((u) => u.pathname === '/api/mentor/proposals/P1/confirm', async (r) => {
          confirms.push(r.request());
          await new Promise((res) => setTimeout(res, 150));
          return r.fulfill(json(200, {
            trail: { id: 'P1', origin: 'server', kind: 'profile', summary: card.summary, undoUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString() },
            parts: [{ kind: 'line', line: { trigger: 'schedule.set', vars: { summary: card.summary } } }],
          }));
        });
      }),
    });
    const { page } = app;
    await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as { account?: unknown }).account ?? null)).not.toBeNull();
    await page.locator('#pan-button').click();
    await tell(page, 'My market day is Saturday.');
    expect(turnBodies).toHaveLength(1);
    expect(turnBodies[0]).toMatchObject({ input: { kind: 'text', text: 'My market day is Saturday.' }, conversationId: null });
    const slip = page.locator('#pan-panel .pan-card');
    await slip.waitFor();
    expect(await page.locator('#pan-panel').textContent()).not.toContain('MODEL WORDS');
    await slip.getByRole('button', { name: 'Ink it ✔' }).dblclick();
    await page.locator('#pan-panel .trail-entry').waitFor();
    expect(confirms).toHaveLength(1);
    expect(confirms[0].postDataJSON()).toEqual({ channel: 'tap', conversationId: 'c1' }); // the conversation the card came from (fix round 5, H2)
    expect(await page.locator('#pan-panel .trail-text').textContent()).toBe(`🗓 Inked: ${card.summary}`);
    expect(app.consoleErrors).toEqual([]);
  });

  it('AI down (503): the Pan says so, answers from the script, and offers Try again', async () => {
    let turns = 0;
    app = await openApp('/#/settings', {
      reducedMotion: true,
      seed: PAN_READY,
      beforeGoto: signedIn(async (page) => {
        await page.route((u) => u.pathname === '/api/mentor/turn', (r) => { turns++; return r.fulfill(json(503, { error: { code: 'unavailable', message: 'down' } })); });
      }),
    });
    const { page } = app;
    await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as { account?: unknown }).account ?? null)).not.toBeNull();
    await page.locator('#pan-button').click();
    await tell(page, 'My market day is Saturday.');
    await page.locator('#pan-panel .pan-card').waitFor();
    const texts = await panTexts(page);
    expect(lines('mentor.ai_unavailable')).toContain(texts.at(-2));
    // The scripted read-back, and its card.
    expect(await page.locator('#pan-panel .pan-card').textContent()).toContain('1-A/AMEND');
    // The one retry (after 5 s, or on the next online event) fails too: Try again.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const retry = page.locator('#pan-panel').getByRole('button', { name: 'Try again' });
    await retry.waitFor();
    expect(turns).toBe(2);
    expect(lines('ai.try_again')).toContain((await panTexts(page)).at(-1));
    // The held text is in memory only: never in storage.
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('market day is Saturday');
    await retry.click();
    await expect.poll(() => turns).toBe(3);
    expect(app.consoleErrors).toEqual([]);
  });

  it('family table: no textbox, no /api/mentor request', async () => {
    app = await openApp('/', {
      reducedMotion: true,
      seed: { settings: { showCalories: false, reducedMotion: 'system', familyTable: true, iosNoteDismissed: false, aiMentor: true, rescueNudges: true } },
      beforeGoto: signedIn(() => Promise.resolve()),
    });
    const { page } = app;
    await page.locator('#pan-button').click();
    expect(await page.locator('#pan-panel').getByRole('textbox').count()).toBe(0);
    await page.waitForTimeout(300);
    expect(app.requests.filter((u) => new URL(u).pathname.startsWith('/api/mentor'))).toEqual([]);
  });

  it('cards pass axe and keep focus order', async () => {
    app = await openApp('/#/settings', { reducedMotion: true, seed: PAN_READY });
    const { page } = app;
    await page.locator('#pan-button').click();
    await tell(page, "I'm allergic to coconut");
    await page.locator('#pan-panel .pan-card').getByRole('button', { name: 'Stamp it ✔' }).click();
    await page.locator('#pan-panel .trail-entry').waitFor();
    // The pressed button's place is taken by the trail entry text (fix round 1, M3).
    expect(await page.evaluate(() => document.activeElement?.className)).toBe('trail-text');
    await tell(page, 'I avoid sesame');
    await page.locator('#pan-panel .pan-card').waitFor();
    await expectNoA11yViolations(page, 'rule card and trail entry');
    // Tab goes Close → the conversation list (focusable so it scrolls) → Undo → Edit → the card's buttons (and picker) → the text box: the reading order.
    await page.locator('#pan-panel .pan-close').focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('bubbles'))).toBe(true);
    const order: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        return a?.id === 'pan-text' ? 'text' : a?.tagName === 'SELECT' ? 'select' : (a?.textContent ?? '');
      }));
      if (order.at(-1) === 'text') break;
    }
    expect(order.slice(0, 2)).toEqual(['Undo', 'Edit']);
    expect(order).toContain('Stamp it ✔');
    expect(order.indexOf('Stamp it ✔')).toBeLessThan(order.indexOf('text'));
    // Enter in the text box sends; it never presses a card button.
    await page.locator('#pan-text').fill('thank you');
    await page.keyboard.press('Enter');
    await page.locator('#pan-panel .bubble.you', { hasText: 'thank you' }).waitFor();
    expect(await page.locator('#pan-panel .trail-entry').count()).toBe(1);
  });
});

describe('the week from the Pan (M5 Step 10)', () => {
  it('AI off: a navigation is a chip that only a tap follows; "pick 3 after the weekend" asks which day', async () => {
    app = await openApp('/#/settings', { reducedMotion: true, seed: PAN_READY });
    const { page } = app;
    await page.locator('#pan-button').click();
    // The chip carries the nav.offer line itself (no separate bubble).
    await page.locator('#pan-text').fill('take me to the market list');
    await page.keyboard.press('Enter');
    const chip = page.locator('#pan-panel .pan-go');
    await chip.waitFor();
    expect(filled('nav.offer', { place: 'the market list' })).toContain(await chip.textContent());
    expect(await page.evaluate(() => location.hash)).toBe('#/settings');
    await tell(page, 'pick 3 after the weekend');
    expect(filled('plan.after_which_day', { day: 'the weekend' })).toContain((await panTexts(page)).at(-1));
    expect(await page.locator('#pan-panel .pan-card').count()).toBe(0);
    await chip.click();
    expect(await page.evaluate(() => location.hash)).toBe('#/market');
    expect(app.consoleErrors).toEqual([]);
  });
});
