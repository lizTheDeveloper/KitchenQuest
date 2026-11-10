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
      return r.fulfill(json(200, { consents: [], needsReconsent: [], notices: { health_data: { version: 'v2', text: 'HEALTH NOTICE TEXT' }, ai_health: { version: 'v1', text: 'AI NOTICE TEXT' } } }));
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
    expect(consentPosts[0].postDataJSON()).toEqual({ purpose: 'health_data', noticeVersion: 'v2', method: 'tap' });
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
          return r.fulfill(json(200, { consents, needsReconsent: [], notices: { health_data: { version: 'v2', text: 'HEALTH NOTICE TEXT' }, ai_health: { version: 'v1', text: 'AI NOTICE TEXT' } } }));
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
});
