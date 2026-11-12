// M6 Step 9: the market, end to end (mocked /api/**; 400 px and 1280 px; canvas on and off). Signed out with the AI
// off: the kitchen → The Market → Old Wen → a five-question round → the stall stamp line once → Big Bram runs the
// Protein Counter for a vegetarian device rule. Signed in: one stall_round per round reaches the API; the mocked
// grants show (the stamp line, the account's XP); a second round that ISO week earns no XP and no second stamp.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { ProgressEvent, ProgressView, RewardGrant } from '@kitchenquest/core/engine';
import { STORE_KEY, type PlayerState } from '../src/state/store';
import { expectNoA11yViolations, expectNoHorizontalScroll, openApp, PAN_READY, type OpenedApp } from './helpers';

const yaml = <T>(rel: string): T => parse(readFileSync(fileURLToPath(new URL(`../../../content/${rel}`, import.meta.url)), 'utf8')) as T;
const pan = yaml<{ triggers: Record<string, { lines: string[] }> }>('dialogue/pan.yaml');
const bram = yaml<{ name: string; variants: { protein_counter: { name: string } } }>('market/bram.yaml');
/** `stamp_earned.market_game` with its `{stall}` filled: does `text` say it for `stall`? */
const stampLine = (text: string, stall: string) => pan.triggers['stamp_earned.market_game'].lines.some((l) => l.replace('{stall}', stall) === text);

const VEGETARIAN = { id: 'r-veg', target: { kind: 'category' as const, ids: ['meat', 'fish', 'shellfish', 'gelatin'] }, type: 'avoid' as const, severity: 'preference' as const };
const SIGNED_OUT_AI_OFF: Partial<PlayerState> = {
  ...PAN_READY, firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
  settings: { showCalories: false, reducedMotion: 'system', familyTable: false, iosNoteDismissed: false, aiMentor: false, rescueNudges: false },
};
/** Pressure words a round may never show (Review Focus 2). */
const PRESSURE = /\b\d+\s*(\/|of)\s*\d+\b|in a row|streak|\bscore\b|countdown|\blives\b|seconds? left|hurry/i;

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const stored = (page: Page): Promise<PlayerState> => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}') as PlayerState, STORE_KEY);
const toasts = async (page: Page): Promise<string[]> => page.locator('.progress-toast').allTextContents();

/** Answer every question of the round showing (the first option each time), then finish it. Returns how many. */
async function playRound(page: Page): Promise<number> {
  let n = 0;
  for (; n < 12; n++) {
    const round = page.locator('.stall-round');
    if ((await round.count()) === 0) break;
    expect(await round.textContent()).not.toMatch(PRESSURE);
    expect(await page.locator('.stall-round progress, .stall-round meter, .stall-round [role="progressbar"], .stall-round [role="timer"]').count()).toBe(0);
    await page.locator('.stall-option').first().click();
    // The keyboard player's focus is on the reaction.
    await page.waitForFunction(() => document.activeElement?.classList.contains('stall-feedback') === true);
    await page.locator('.stall-next').click();
  }
  await page.locator('.stall-done').waitFor();
  return n;
}

describe('the market (M6 Step 9)', () => {
  for (const width of [400, 1280]) {
    for (const canvas of [true, false]) {
      it(`signed out, AI off (${width} px, canvas ${canvas ? 'on' : 'off'}): kitchen → The Market → Wen → a round → the stamp line once → the Protein Counter`, async () => {
        app = await openApp('/', {
          reducedMotion: true, width, seed: SIGNED_OUT_AI_OFF,
          beforeGoto: async (page) => { if (!canvas) await page.route('**/assets/phaser-*.js', (r) => r.abort()); },
        });
        const { page } = app;
        await page.getByRole('button', { name: 'The Market' }).click();
        await page.locator('#view h1', { hasText: 'The Market' }).waitFor();
        await page.locator('.market-backdrop-img').waitFor();
        if (canvas) await page.waitForFunction(() => (window as unknown as { __kqScene?: string | null }).__kqScene === 'Market');
        else expect(await page.locator('#stage canvas').count()).toBe(0);
        await page.locator('.stall-button-games', { hasText: /\S/ }).first().waitFor();
        await expectNoHorizontalScroll(page);
        await page.locator('.stall-button[data-stall="wen"]').click();
        await page.waitForFunction(() => location.hash === '#/stall/wen');
        await page.locator('#view h1', { hasText: 'Old Wen' }).waitFor();
        await expectNoHorizontalScroll(page);

        expect(await playRound(page)).toBe(5);
        await expect.poll(async () => (await toasts(page)).filter((t) => stampLine(t, 'Old Wen')).length).toBe(1);
        const s = await stored(page);
        const rounds = s.progress.events.filter((e) => e.kind === 'stall_round');
        expect(rounds).toHaveLength(1);
        expect(JSON.stringify(rounds[0])).not.toMatch(/correct|score/);
        expect(s.progress.grants.some((g) => g.kind === 'stamp' && g.stamp === 'market_game')).toBe(true);

        // A vegetarian rule on the device: Big Bram runs the Protein Counter, a full stall of its own.
        await page.evaluate(({ k, rule }) => {
          const st = JSON.parse(localStorage.getItem(k)!) as PlayerState;
          localStorage.setItem(k, JSON.stringify({ ...st, localRules: [rule] }));
        }, { k: STORE_KEY, rule: VEGETARIAN });
        await page.evaluate(() => { location.hash = '#/stall/bram'; });
        await page.reload();
        await page.locator('#view h1', { hasText: bram.variants.protein_counter.name }).waitFor();
        expect(await page.locator('.stall-sign').textContent()).toBe('Protein Counter');
        expect(await page.locator('.stall-round').getAttribute('data-question')).toMatch(/^bram-pc-/);
        // With the canvas off the test aborts the Phaser chunk itself; that refusal is the only error allowed.
        expect(app.consoleErrors.filter((e) => canvas || e !== 'Failed to load resource: net::ERR_FAILED')).toEqual([]);
      });
    }
  }

  it('signed in: a round posts one stall_round; the mocked grants show; a second round that ISO week earns no XP and no second stamp', async () => {
    const posted: ProgressEvent[][] = [];
    let view: ProgressView = {
      xp: 0, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered: {},
    };
    const consents = { consents: [{ purpose: 'health_data', noticeVersion: 'v3', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true }], needsReconsent: [], notices: {} };
    app = await openApp('/#/stalls', {
      reducedMotion: true, width: 400, seed: SIGNED_OUT_AI_OFF,
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname.startsWith('/api/'), async (route) => {
          const req = route.request();
          const path = new URL(req.url()).pathname.replace(/^\/api/, '');
          if (path === '/me') return route.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] }));
          if (path === '/me/consents') return route.fulfill(json(200, consents));
          if (path === '/profile') return route.fulfill(json(200, { marketDays: [], mealsPerWeek: null, country: null, region: null, mealWindows: [] }));
          if (path === '/rules') return route.fulfill(json(200, { rules: [] }));
          if (path === '/progress') return route.fulfill(json(200, { view }));
          if (path === '/progress/events') {
            const { events } = req.postDataJSON() as { events: ProgressEvent[] };
            posted.push(events);
            // The server decides: the first round earns 5 XP a correct first answer and the week's stall stamp; the second nothing.
            const first = posted.length === 1;
            const accepted = events.map((e) => ({
              clientId: e.id,
              grants: first ? [
                { id: `${e.id}#0`, eventId: e.id, isoDay: e.at, kind: 'xp', amount: 5, reason: 'market_game' },
                { id: `${e.id}#1`, eventId: e.id, isoDay: e.at, kind: 'stamp', stamp: 'market_game' },
              ] satisfies RewardGrant[] : [],
            }));
            if (first) view = { ...view, xp: 5, stamps: 1 };
            return route.fulfill(json(200, { accepted, duplicate: [], rejected: [], warnings: [], view }));
          }
          return route.fulfill(json(404, { error: { code: 'not_found', message: `no mock for ${path}` } }));
        });
      },
    });
    const { page } = app;
    await expect.poll(async () => (await stored(page)).account ?? null).not.toBeNull();
    await page.locator('.stall-button[data-stall="okafor-sato"]').click();
    await page.locator('.stall-option').first().waitFor();
    await playRound(page);
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toHaveLength(1);
    expect(posted[0][0]).toMatchObject({ kind: 'stall_round', stall: 'okafor-sato' });
    expect(Object.keys(posted[0][0]).sort()).toEqual(['answers', 'at', 'id', 'kind', 'stall']);
    await expect.poll(async () => (await toasts(page)).filter((t) => stampLine(t, 'Mr. Okafor-Sato')).length).toBe(1);
    await expect.poll(async () => {
      const s = await stored(page);
      return Object.values(s.accountProgress).map((p) => p.view?.xp ?? 0);
    }).toContain(5);

    // A second round, the same week: posted too; the server grants nothing, so no second stamp line.
    await page.getByRole('button', { name: 'Another round' }).click();
    await page.locator('.stall-option').first().waitFor();
    await playRound(page);
    await expect.poll(() => posted.length).toBe(2);
    // Deterministic, no wall-clock wait (M9): the second answer has landed once the account holds both rounds, uploaded.
    await expect.poll(async () => Object.values((await stored(page)).accountProgress)
      .map((p) => [p.progress.events.filter((e) => e.kind === 'stall_round').length, p.progress.pendingUpload.length].join('/'))).toContain('2/0');
    await page.evaluate(() => new Promise((r) => { requestAnimationFrame(() => { r(null); }); }));
    expect((await toasts(page)).filter((t) => stampLine(t, 'Mr. Okafor-Sato'))).toHaveLength(1);
    expect(app.consoleErrors).toEqual([]);
  });

  it('keyboard only (M9): a whole round with Tab and Enter, focus on the reaction after each pick', async () => {
    app = await openApp('/#/stall/wen', { reducedMotion: true, width: 400, seed: SIGNED_OUT_AI_OFF });
    const { page } = app;
    await page.locator('.stall-option').first().waitFor();
    for (let n = 0; n < 5; n++) {
      // From the question's heading, the first option is the next stop.
      await page.locator('.stall-round h2').focus();
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.classList.contains('stall-option'))).toBe(true);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.classList.contains('stall-feedback') === true);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.classList.contains('stall-next'))).toBe(true);
      await page.keyboard.press('Enter');
    }
    await page.locator('.stall-done').waitFor();
    expect(await page.evaluate(() => document.activeElement?.classList.contains('stall-done'))).toBe(true);
    expect((await stored(page)).progress.events.filter((e) => e.kind === 'stall_round')).toHaveLength(1);
  });

  it('signed in, the Protein Counter (M9): no health_data → the consent card first; "I agree" → the round', async () => {
    let granted = false;
    const grants: unknown[] = [];
    app = await openApp('/#/stall/bram', {
      reducedMotion: true, width: 400, seed: SIGNED_OUT_AI_OFF,
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname.startsWith('/api/'), async (route) => {
          const req = route.request();
          const path = new URL(req.url()).pathname.replace(/^\/api/, '');
          if (path === '/me') return route.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] }));
          if (path === '/me/consents' && req.method() === 'POST') { granted = true; grants.push(req.postDataJSON()); return route.fulfill(json(201, { consent: {} })); }
          if (path === '/me/consents') {
            const consents = granted ? [{ purpose: 'health_data', noticeVersion: 'v3', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true }] : [];
            return route.fulfill(json(200, { consents, needsReconsent: [], notices: { health_data: { version: 'v3', text: 'HEALTH NOTICE TEXT' } } }));
          }
          if (path === '/profile') return route.fulfill(json(200, { marketDays: [], mealsPerWeek: null, country: null, region: null, mealWindows: [] }));
          if (path === '/rules') return route.fulfill(json(200, { rules: [{ ...VEGETARIAN, id: 's1' }] }));
          if (path === '/progress') return route.fulfill(json(200, { view: null }));
          return route.fulfill(json(404, { error: { code: 'not_found', message: `no mock for ${path}` } }));
        });
      },
    });
    const { page } = app;
    await page.locator('#view h1', { hasText: bram.variants.protein_counter.name }).waitFor();
    await page.locator('.stall-consent').waitFor();
    expect(await page.locator('.stall-option').count()).toBe(0);
    await page.locator('.stall-consent').click();
    const card = page.locator('#pan-panel .consent-card');
    await card.waitFor();
    await expectNoA11yViolations(page, 'the Protein Counter consent card');
    await card.getByRole('button', { name: 'I agree' }).click();
    await page.locator('.stall-option').first().waitFor();
    expect(grants).toHaveLength(1);
  });

  for (const familyTable of [false, true]) {
    it(`axe on #/stalls and #/stall/<each>${familyTable ? ' (Family Table)' : ''}`, async () => {
      const seed = { ...SIGNED_OUT_AI_OFF, settings: { ...SIGNED_OUT_AI_OFF.settings!, familyTable } };
      app = await openApp('/#/stalls', { reducedMotion: true, width: 400, seed });
      const { page } = app;
      await page.locator('.stall-button').first().waitFor();
      await expectNoA11yViolations(page, 'market hub');
      for (const id of ['wen', 'bram', 'okafor-sato', 'spice']) {
        await page.evaluate((h) => { location.hash = h; }, `#/stall/${id}`);
        await page.locator('.stall-option').first().waitFor();
        await expectNoA11yViolations(page, `stall ${id}`);
        expect(await page.locator('.stall-faq-chip').count() > 0).toBe(!familyTable);
        expect(await page.locator('#view textarea, #view input[type="text"]').count()).toBe(0);
        // After an answer too: the feedback, the board (if any) and the controls.
        await page.locator('.stall-option').first().click();
        await page.locator('.stall-feedback:not([hidden])').waitFor();
        await expectNoA11yViolations(page, `stall ${id}, answered`);
        await expectNoHorizontalScroll(page);
      }
      if (familyTable) expect((await stored(page)).progress.events.filter((e) => e.kind === 'stall_round')).toEqual([]);
    });
  }
});
