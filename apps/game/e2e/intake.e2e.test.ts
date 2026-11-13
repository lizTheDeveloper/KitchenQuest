import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Request } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { expectNoA11yViolations, openApp, type OpenedApp } from './helpers';

const pan = parse(readFileSync(fileURLToPath(new URL('../../../content/dialogue/pan.yaml', import.meta.url)), 'utf8')) as {
  triggers: Record<string, { lines: string[] }>;
};
const lines = (id: string) => pan.triggers[id].lines;
const C16 = "The Pan and the cooks are AI characters. Don't rely on them for medical advice.";

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const panTexts = (page: Page) => page.locator('#pan-panel .bubble.pan .bubble-text').allTextContents();
const lastPan = async (page: Page) => (await panTexts(page)).at(-1);
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as Record<string, unknown>);

/** Type into the Pan's text box and wait for the Pan to answer. */
async function tell(page: Page, text: string): Promise<void> {
  const before = await page.locator('#pan-panel .bubble.pan').count();
  await page.locator('#pan-text').fill(text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#pan-panel .bubble.pan').length > n, before);
}
/** Tap the newest card's stamp button and wait for its trail entry. */
async function stamp(page: Page, name: string): Promise<void> {
  const before = await page.locator('#pan-panel .trail-entry').count();
  await page.locator('#pan-panel .pan-card').last().getByRole('button', { name }).click();
  await page.waitForFunction((n) => document.querySelectorAll('#pan-panel .trail-entry').length > n, before);
  await page.waitForTimeout(50);
}
const ticks = (page: Page) => page.locator('#pan-panel .intake-field.is-stamped').count();

describe('Form 1-A intake by conversation (M4 Step 11)', () => {
  it('AI off and signed out: the whole Form 1-A interview by typing, with every stamp on screen', async () => {
    app = await openApp('/#/settings', { reducedMotion: true, seed: { aiDisclosureSeen: true } });
    const { page } = app;
    await page.locator('#pan-button').click();
    await page.locator('#pan-panel .intake-checklist').waitFor();
    expect(await page.locator('#pan-panel .intake-checklist').textContent()).toContain('1-A');
    await page.waitForFunction(() => document.querySelectorAll('#pan-panel .bubble.pan').length >= 2);
    const opening = await panTexts(page);
    expect(lines('intake.open')).toContain(opening[0]);
    expect(lines('intake.market_day.ask')).toContain(opening[1]);

    await tell(page, 'Saturdays usually');
    await stamp(page, 'Ink it ✔');
    expect(await ticks(page)).toBe(1);
    await tell(page, 'maybe four');
    await stamp(page, 'Ink it ✔');
    await tell(page, 'Pacific Northwest, USA');
    await stamp(page, 'Ink it ✔');
    expect(lines('intake.allergies.ask')).toContain(await lastPan(page));
    await tell(page, 'peanuts');
    const rule = page.locator('#pan-panel .pan-card').last();
    expect(await rule.textContent()).toContain('*Kept on this device only.');
    expect(await rule.textContent()).toContain('P-E-A-N-U-T');
    await stamp(page, 'Stamp it ✔');
    expect(lines('intake.allergies.followup')).toContain(await lastPan(page));
    await tell(page, "that's all");
    expect(lines('intake.pantry.ask')).toContain(await lastPan(page));
    await tell(page, 'rice, beans and eggs');
    await stamp(page, 'Stamp it ✔');
    await page.waitForFunction(() => document.querySelectorAll('#pan-panel .intake-field.is-stamped').length === 5);
    expect(lines('intake.complete')).toContain(await lastPan(page));
    expect(await page.locator('#pan-panel .trail-entry').count()).toBe(5);
    await expectNoA11yViolations(page, 'intake complete');

    const s = await stored(page);
    expect(s.intake).toEqual({ step: 'done' });
    expect(s.localProfile).toMatchObject({ marketDays: [6], mealsPerWeek: 4, region: 'Pacific Northwest', country: 'USA' });
    expect((s.localPantry as { name: string }[]).map((p) => p.name)).toEqual(['rice', 'beans', 'eggs']);
    expect((s.localRules as { target: { ids: string[] } }[]).map((r) => r.target.ids)).toEqual([['peanut']]);
    // Nothing reached the API: signed out, the AI is never asked.
    expect(app.requests.filter((u) => new URL(u).pathname.startsWith('/api/mentor'))).toEqual([]);
    // A reload doesn't start it again.
    await page.reload();
    await page.locator('#pan-button').click();
    await page.waitForTimeout(200);
    expect(await page.locator('#pan-panel .intake-checklist').count()).toBe(0);
    expect(app.consoleErrors).toEqual([]);
  });

  const consentPosts: Request[] = [];
  const signedIn = (page: Page) => Promise.all([
    page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] }))),
    page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] }))),
    page.route((u) => u.pathname === '/api/mentor/turn', (r) => r.fulfill(json(503, { error: { code: 'unavailable', message: 'down' } }))),
    page.route((u) => u.pathname === '/api/me/consents', (r) => {
      if (r.request().method() === 'POST') {
        consentPosts.push(r.request());
        return r.fulfill(json(201, { consent: {} }));
      }
      return r.fulfill(json(200, { consents: [], needsReconsent: [], notices: { health_data: { version: 'v3', text: 'HEALTH NOTICE TEXT' }, ai_health: { version: 'v1', text: 'AI NOTICE TEXT' } } }));
    }),
  ]);

  it('signed in: the consent card is a tap; declining still completes onboarding', async () => {
    consentPosts.length = 0;
    app = await openApp('/#/settings', { reducedMotion: true, seed: { aiDisclosureSeen: true }, beforeGoto: signedIn });
    const { page } = app;
    await expect.poll(async () => (await stored(page)).account ?? null).not.toBeNull();
    await page.locator('#pan-button').click();
    await page.locator('#pan-panel .intake-checklist').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#pan-panel .bubble.pan').length >= 2);
    for (let i = 0; i < 3; i++) await tell(page, 'skip');
    const consent = page.locator('#pan-panel .consent-card');
    await consent.waitFor();
    expect(await consent.textContent()).toContain('HEALTH NOTICE TEXT');
    expect((await panTexts(page)).some((t) => lines('intake.allergies.ask').includes(t))).toBe(false);
    await expectNoA11yViolations(page, 'consent card in the intake');
    // A typed yes never grants it: the Pan asks for the tap.
    await tell(page, 'yes');
    expect(lines('consent.health_first')).toContain(await lastPan(page));
    expect(await page.locator('#pan-panel .consent-card').count()).toBe(1);
    expect(consentPosts).toHaveLength(0);
    await consent.getByRole('button', { name: 'Not now' }).click();
    await page.waitForFunction(() => document.querySelector('#pan-panel .consent-card') === null);
    await expect.poll(() => lastPan(page)).toSatisfy((t: string | undefined) => lines('intake.pantry.ask').includes(t ?? ''));
    await tell(page, 'skip');
    expect(lines('intake.complete')).toContain(await lastPan(page));
    expect((await stored(page)).intake).toEqual({ step: 'done' });
    expect(consentPosts).toHaveLength(0);
    expect(app.consoleErrors).toEqual([]);
  });

  it('signed in: "I agree" files the grant by tap, and only then', async () => {
    consentPosts.length = 0;
    app = await openApp('/#/settings', { reducedMotion: true, seed: { aiDisclosureSeen: true, intake: { step: 'allergies' } }, beforeGoto: signedIn });
    const { page } = app;
    await expect.poll(async () => (await stored(page)).account ?? null).not.toBeNull();
    await page.locator('#pan-button').click();
    const consent = page.locator('#pan-panel .consent-card');
    await consent.waitFor();
    await page.waitForTimeout(200);
    expect(consentPosts).toHaveLength(0);
    await consent.getByRole('button', { name: 'I agree' }).click();
    await expect.poll(() => consentPosts.length).toBe(1);
    expect(consentPosts[0].postDataJSON()).toEqual({ purpose: 'health_data', noticeVersion: 'v3', method: 'tap' });
    await expect.poll(() => lastPan(page)).toSatisfy((t: string | undefined) => lines('intake.allergies.ask').includes(t ?? ''));
  });

  it('the AI disclosure shows once, and always in Settings', async () => {
    app = await openApp('/#/settings', { reducedMotion: true, seed: { intake: { step: 'done' } } });
    const { page } = app;
    await page.locator('#pan-button').click();
    const note = page.locator('#pan-panel .pan-disclosure');
    await note.waitFor();
    expect((await note.locator('p').textContent())).toBe(C16);
    await expectNoA11yViolations(page, 'AI disclosure');
    await note.getByRole('button', { name: 'Got it' }).click();
    expect((await stored(page)).aiDisclosureSeen).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('pan-text');
    await page.reload();
    await page.locator('#pan-button').click();
    await page.waitForTimeout(200);
    expect(await page.locator('#pan-panel .pan-disclosure').count()).toBe(0);
    // Settings → The Pan shows the same words, always.
    await page.keyboard.press('Escape');
    const section = page.locator('section[aria-labelledby="set-pan"]');
    await section.waitFor();
    expect(await section.textContent()).toContain(C16);
    expect(await section.getByLabel("Talk to the Pan's AI").isChecked()).toBe(true);
    await section.getByLabel("Talk to the Pan's AI").uncheck();
    expect(((await stored(page)).settings as { aiMentor: boolean }).aiMentor).toBe(false);
  });

  it('Settings → The Pan: ai_health is granted on its own notice by tap, withdrawn with one tap, and conversations can be forgotten', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    let granted = false;
    app = await openApp('/#/settings', {
      reducedMotion: true, seed: { aiDisclosureSeen: true, intake: { step: 'done' } },
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
        await page.route((u) => u.pathname.startsWith('/api/me/consents') || u.pathname === '/api/mentor/conversations', (r) => {
          const req = r.request();
          const path = new URL(req.url()).pathname;
          if (req.method() !== 'GET') calls.push({ method: req.method(), path, body: req.postDataJSON() as unknown });
          if (req.method() === 'POST') { granted = true; return r.fulfill(json(201, { consent: {} })); }
          if (req.method() === 'DELETE') { granted = false; return r.fulfill({ status: 204 }); }
          const consents = granted
            ? [{ purpose: 'ai_health', noticeVersion: 'v1', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true }]
            : [];
          return r.fulfill(json(200, { consents, needsReconsent: [], notices: { health_data: { version: 'v3', text: 'HEALTH NOTICE TEXT' }, ai_health: { version: 'v1', text: 'AI NOTICE TEXT' } } }));
        });
      },
    });
    const { page } = app;
    const box = page.getByLabel('Let the AI see my allergies, rules and meals');
    await page.locator('#set-ai-health:not([disabled])').waitFor();
    expect(await box.isChecked()).toBe(false);
    // Granting: the notice first, and only "I agree" files it.
    await box.click();
    const notice = page.locator('.ai-health-notice .consent-card');
    await notice.waitFor();
    expect(await notice.textContent()).toContain('AI NOTICE TEXT');
    expect(calls).toEqual([]);
    await notice.getByRole('button', { name: 'I agree' }).click();
    await expect.poll(() => box.isChecked()).toBe(true);
    expect(calls).toEqual([{ method: 'POST', path: '/api/me/consents', body: { purpose: 'ai_health', noticeVersion: 'v1', method: 'tap' } }]);
    // Withdrawing: one tap (P-4).
    await box.click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toMatchObject({ method: 'DELETE', path: '/api/me/consents/ai_health' });
    await expect.poll(() => box.isChecked()).toBe(false);
    // Forget my conversations: a confirm, then the API, then forget.done.
    await page.getByRole('button', { name: 'Forget my conversations with the Pan' }).click();
    const modal = page.getByRole('dialog', { name: 'Forget your conversations?' });
    await modal.waitFor();
    await expectNoA11yViolations(page, 'forget confirm');
    await modal.getByRole('button', { name: 'Forget them' }).click();
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2]).toMatchObject({ method: 'DELETE', path: '/api/mentor/conversations' });
    await expect.poll(async () => lines('forget.done').includes((await page.locator('#pan-settings-status').textContent()) ?? '')).toBe(true);
    expect(app.consoleErrors).toEqual([]);
  });

  it('Settings → The Pan: health_data is withdrawn with one tap and a keep-or-delete choice; a stale notice asks again', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    // A grant under an old notice: it no longer counts.
    let health: 'stale' | 'granted' | 'none' = 'stale';
    const rec = (current: boolean) => ({ purpose: 'health_data', noticeVersion: current ? 'v3' : 'v2', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current });
    app = await openApp('/#/settings', {
      reducedMotion: true, seed: { aiDisclosureSeen: true, intake: { step: 'done' } },
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
        await page.route((u) => u.pathname.startsWith('/api/me/consents'), (r) => {
          const req = r.request();
          const path = new URL(req.url()).pathname;
          if (req.method() !== 'GET') calls.push({ method: req.method(), path, body: req.postDataJSON() as unknown });
          if (req.method() === 'POST') { health = 'granted'; return r.fulfill(json(201, { consent: {} })); }
          if (req.method() === 'DELETE') { health = 'none'; return r.fulfill({ status: 204 }); }
          return r.fulfill(json(200, {
            consents: health === 'none' ? [] : [rec(health === 'granted')], needsReconsent: health === 'stale' ? ['health_data'] : [],
            notices: { health_data: { version: 'v3', text: 'HEALTH NOTICE V3' }, ai_health: { version: 'v1', text: 'AI NOTICE TEXT' } },
          }));
        });
      },
    });
    const { page } = app;
    const box = page.getByLabel('Let the Bureau keep my health details');
    await page.locator('#set-health-data:not([disabled])').waitFor();
    expect(await box.isChecked()).toBe(false);
    expect(await page.locator('#set-health-data-note').textContent()).toContain('notice for this permission has changed');
    // Re-consent: the new notice, then the tap.
    await box.click();
    const notice = page.locator('.health-data-notice .consent-card');
    await notice.waitFor();
    expect(await notice.textContent()).toContain('HEALTH NOTICE V3');
    await notice.getByRole('button', { name: 'I agree' }).click();
    await expect.poll(() => box.isChecked()).toBe(true);
    expect(calls).toEqual([{ method: 'POST', path: '/api/me/consents', body: { purpose: 'health_data', noticeVersion: 'v3', method: 'tap' } }]);
    // Withdraw: one tap opens the choice; nothing is sent until one is picked.
    await box.click();
    const choice = page.getByRole('group', { name: 'Stop keeping health details?' });
    await choice.waitFor();
    expect(calls).toHaveLength(1);
    await expectNoA11yViolations(page, 'health_data withdraw choice');
    await choice.getByRole('button', { name: 'Keep my permission' }).click();
    expect(await box.isChecked()).toBe(true);
    await box.click();
    await choice.getByRole('button', { name: 'Stop, and delete it now' }).click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toEqual({ method: 'DELETE', path: '/api/me/consents/health_data', body: { healthData: 'delete' } });
    await expect.poll(() => box.isChecked()).toBe(false);
    expect(app.consoleErrors).toEqual([]);
  });

  it('M6 final I1: a health_data withdraw-with-delete erases the account\'s stall rounds and answered ids on this device; XP stays', async () => {
    const email = 'cook@example.com';
    const key = createHash('sha256').update(email).digest('hex');
    const at = '2026-11-09';
    const view = { xp: 5, level: 1, stamps: 1, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered: { 'bram-pc-most-protein': { correct: true, lastAt: at } } };
    let deleted = false;
    app = await openApp('/#/settings', {
      reducedMotion: true,
      seed: {
        aiDisclosureSeen: true, intake: { step: 'done' }, account: { email },
        accountProgress: { [key]: { view, progress: {
          events: [{ id: 'r1', kind: 'stall_round', at, stall: 'bram', answers: [{ q: 'bram-pc-most-protein', pick: 0 }] }],
          grants: [{ id: 'r1#0', eventId: 'r1', isoDay: at, kind: 'xp', amount: 5, reason: 'market_game' }, { id: 'r1#1', eventId: 'r1', isoDay: at, kind: 'stamp', stamp: 'market_game' }],
          base: null, pendingUpload: [],
        } } },
      } as never,
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email, entitlements: [] })));
        await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
        // The server erased the rounds: its next view has no answered ids.
        await page.route((u) => u.pathname === '/api/progress', (r) => r.fulfill(json(200, { view: deleted ? { ...view, marketAnswered: {} } : view })));
        await page.route((u) => u.pathname.startsWith('/api/me/consents'), (r) => {
          const req = r.request();
          if (req.method() === 'DELETE') { deleted = true; return r.fulfill({ status: 204 }); }
          const rec = { purpose: 'health_data', noticeVersion: 'v3', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true };
          return r.fulfill(json(200, { consents: deleted ? [] : [rec], needsReconsent: [], notices: { health_data: { version: 'v3', text: 'HEALTH NOTICE V3' }, ai_health: { version: 'v1', text: 'AI NOTICE TEXT' } } }));
        });
      },
    });
    const { page } = app;
    const part = async () => ((await stored(page)).accountProgress as Record<string, { progress: { events: { kind: string }[]; grants: unknown[] }; view: { xp: number; marketAnswered: object } | null }>)[key];
    const box = page.getByLabel('Let the Bureau keep my health details');
    await page.locator('#set-health-data:not([disabled])').waitFor();
    await expect.poll(() => box.isChecked()).toBe(true);
    expect((await part()).progress.events.map((e) => e.kind)).toEqual(['stall_round']);
    await box.click();
    await page.getByRole('group', { name: 'Stop keeping health details?' }).getByRole('button', { name: 'Stop, and delete it now' }).click();
    await expect.poll(() => box.isChecked()).toBe(false);
    await expect.poll(async () => (await part()).progress.events.length).toBe(0);
    const p = await part();
    expect(p.progress.grants).toHaveLength(2); // XP and the stamp never drop
    expect(p.view?.xp).toBe(5);
    expect(JSON.stringify(await stored(page))).not.toContain('bram-pc');
    expect(app.consoleErrors).toEqual([]);
  });

  it('Settings → The Pan: with the grant not counting (stale or after keep), saved health details can still be deleted; the conversation clears and offline rules fail closed', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    let rulesDown = false;
    app = await openApp('/#/settings', {
      reducedMotion: true, seed: { aiDisclosureSeen: true, intake: { step: 'done' } },
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route((u) => u.pathname === '/api/rules', (r) => (rulesDown ? r.abort() : r.fulfill(json(200, { rules: [{ id: 's1', target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' }] }))));
        await page.route((u) => u.pathname === '/api/mentor/turn', (r) => r.fulfill(json(503, { error: { code: 'unavailable', message: 'down' } })));
        await page.route((u) => u.pathname.startsWith('/api/me/consents'), (r) => {
          const req = r.request();
          if (req.method() !== 'GET') {
            calls.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postDataJSON() as unknown });
            rulesDown = true; // the next rules refresh can't reach the API
            return r.fulfill({ status: 204 });
          }
          // Withdrawn earlier with "keep": no active grant.
          return r.fulfill(json(200, { consents: [], needsReconsent: [], notices: { health_data: { version: 'v3', text: 'HEALTH NOTICE V3' }, ai_health: { version: 'v1', text: 'AI NOTICE TEXT' } } }));
        });
      },
    });
    const { page } = app;
    await expect.poll(async () => ((await stored(page)).accountRules as unknown[] | null)?.length ?? 0).toBe(1);
    // Something said to the Pan first.
    await page.locator('#pan-button').click();
    await tell(page, "I'm allergic to peanuts");
    expect(await page.locator('#pan-panel .bubble').count()).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    const erase = page.getByRole('button', { name: 'Delete my saved health details' });
    await erase.waitFor();
    await erase.click();
    const modal = page.getByRole('dialog', { name: 'Delete your saved health details?' });
    await modal.waitFor();
    expect(calls).toEqual([]);
    await modal.getByRole('button', { name: 'Delete them' }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/api/me/consents/health_data', body: { healthData: 'delete' } });
    await expect.poll(() => page.locator('#pan-panel .bubble, #pan-panel .pan-card').count()).toBe(0);
    // The refresh couldn't reach the rules: no stale copy is trusted.
    await expect.poll(async () => (await stored(page)).accountRules).toBeNull();
    // M7 Step 8 (M6 N2): the delete is counted on the account's partition when asked and again once done, so a round
    // open in another tab, or a post or view on its way, is never kept after it.
    await expect.poll(async () => Object.values((await stored(page)).accountProgress as Record<string, { healthDeletes?: number }>).map((p) => p.healthDeletes ?? 0)).toEqual([2]);
    expect(app.consoleErrors).toEqual([]);
  });
});
