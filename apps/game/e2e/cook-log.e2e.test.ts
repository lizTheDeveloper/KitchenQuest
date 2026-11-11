import type { Page, Request } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlayerState } from '../src/state/store';
import { expectNoA11yViolations, openApp, PAN_READY, type OpenedApp } from './helpers';

const SLUG = 'india/kerala/parippu';
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const NOTICES = { health_data: { version: 'v3', text: 'We keep your allergies, diet rules, notes and plans.' } };
const GRANTED = {
  consents: [{ purpose: 'health_data', noticeVersion: 'v3', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true }],
  needsReconsent: [], notices: NOTICES,
};
const settings = (familyTable: boolean) => ({ showCalories: false, reducedMotion: 'system' as const, familyTable, iosNoteDismissed: false, aiMentor: false, rescueNudges: false });

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

/** Signed in, health_data granted, the book routes answering; every /api request is recorded. */
async function signedIn(page: Page, sent: Request[]): Promise<void> {
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) sent.push(r); });
  await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
  await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
  await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, GRANTED)));
  await page.route((u) => u.pathname === '/api/progress', (r) => r.fulfill(json(200, { view: null })));
  await page.route((u) => u.pathname === '/api/progress/events', (r) => {
    const body = r.request().postDataJSON() as { events: { id: string }[] };
    return r.fulfill(json(200, { accepted: body.events.map((e) => ({ clientId: e.id, grants: [] })), duplicate: [], rejected: [], warnings: [], view: null }));
  });
  await page.route((u) => u.pathname === '/api/shared-table', (r) => r.fulfill(json(201, { id: 'aaaaaaaa-0000-4000-8000-000000000001' })));
  await page.route((u) => u.pathname === '/api/notes', (r) => (r.request().method() === 'GET'
    ? r.fulfill(json(200, { notes: [] }))
    : r.fulfill(json(201, { note: { ...(r.request().postDataJSON() as { note: object }).note, id: 'bbbbbbbb-0000-4000-8000-000000000001', check: { status: 'ok', findings: [], severe: false, disclaimer: null } } }))));
  await page.route((u) => u.pathname === '/api/meals', (r) => r.fulfill(json(201, { meal: { ...(r.request().postDataJSON() as { meal: object }).meal, id: 'cccccccc-0000-4000-8000-000000000001' } })));
}

async function cookToTheEnd(page: Page): Promise<void> {
  await page.evaluate((s) => { location.hash = `#/cook/${s}`; }, SLUG);
  await page.locator('.cook-progress').waitFor();
  for (let i = 0; i < 10 && (await page.getByRole('button', { name: 'Done ▶' }).count()) === 0; i++) await page.getByRole('button', { name: /Next step/ }).click();
  await page.getByRole('button', { name: 'Done ▶' }).click();
  await page.getByRole('dialog', { name: /Certificate of a Dish Cooked/ }).getByRole('button', { name: 'Continue' }).click();
}

describe('cook → log (M5 Step 11)', () => {
  it('signed in: who ate (a typed name is dropped), a margin note, one-tap log, then the kitchen', async () => {
    const sent: Request[] = [];
    app = await openApp('/#/settings', { reducedMotion: true, seed: PAN_READY, beforeGoto: (page) => signedIn(page, sent) });
    const { page } = app;
    await cookToTheEnd(page);
    const who = page.locator('.bureau-slip[data-kind="cooked_for"]');
    await who.waitFor();
    await expectNoA11yViolations(page, 'after cook: who ate');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('slip-readback'))).toBe(true);
    await page.locator('#cooked-for-text').fill('my flatmate Sam and his sister');
    await page.getByRole('button', { name: 'Read it' }).click();
    expect(await page.locator('#cooked-for-text').inputValue()).toBe('');
    expect(await who.locator('.bureau-value').allTextContents()).toEqual(['You and two or three more', 'Flatmate']);
    await who.getByRole('button', { name: 'Stamp it ✔' }).click();

    await page.locator('.note-form').waitFor();
    await page.locator('.note-text').fill('added lime');
    await page.getByRole('button', { name: 'Read it back' }).click();
    const note = page.locator('.bureau-slip[data-kind="margin_note"]');
    await note.waitFor();
    await expectNoA11yViolations(page, 'after cook: margin note');
    await note.getByRole('button', { name: 'Write it in ✔' }).click();

    const log = page.locator('.bureau-slip[data-kind="meal"]');
    await log.waitFor();
    await log.getByRole('button', { name: 'Log it' }).click();
    const loggedEvents = () => sent.filter((r) => new URL(r.url()).pathname === '/api/progress/events')
      .flatMap((r) => (r.postDataJSON() as { events: { kind: string }[] }).events).filter((e) => e.kind === 'meal_logged');
    await expect.poll(() => loggedEvents().length).toBe(1);

    const shared = sent.find((r) => new URL(r.url()).pathname === '/api/shared-table')!;
    expect(shared.postData()).not.toMatch(/sam|sister/i);
    expect(shared.postDataJSON()).toMatchObject({ entry: { recipe: SLUG, frame: null, cookedFor: { count: 'two_to_three', who: 'flatmate' } }, confirmed: true, today: expect.any(String) });
    const notes = sent.filter((r) => new URL(r.url()).pathname === '/api/notes');
    for (const r of notes) expect(r.url()).not.toContain('?');
    expect(notes.find((r) => r.method() === 'POST')!.postDataJSON()).toMatchObject({ note: { recipe: SLUG, ops: [{ op: 'add', name: 'lime' }] }, confirmed: true, today: expect.any(String) });
    const meal = sent.find((r) => new URL(r.url()).pathname === '/api/meals')!;
    expect(meal.postDataJSON()).toMatchObject({ meal: { item: { kind: 'dish', slug: SLUG, servings: 1 } }, confirmed: true });
    const events = sent.filter((r) => new URL(r.url()).pathname === '/api/progress/events').flatMap((r) => (r.postDataJSON() as { events: { kind: string; mealLogId?: string }[] }).events);
    expect(events.filter((e) => e.kind === 'meal_logged')).toEqual([expect.objectContaining({ mealLogId: 'cccccccc-0000-4000-8000-000000000001' })]);
    expect(await page.locator('.after-cook').textContent()).not.toMatch(/\bXP\b|streak|\$/i);

    await page.getByRole('button', { name: 'Back to the kitchen' }).click();
    await page.waitForFunction(() => location.hash === '#/kitchen');
    expect(app.consoleErrors).toEqual([]);
  });

  it('signed in: skipping all three writes nothing', async () => {
    const sent: Request[] = [];
    app = await openApp('/#/settings', { reducedMotion: true, seed: PAN_READY, beforeGoto: (page) => signedIn(page, sent) });
    const { page } = app;
    await cookToTheEnd(page);
    await page.locator('.bureau-slip[data-kind="cooked_for"]').getByRole('button', { name: 'Skip' }).click();
    await page.locator('.note-skip').click();
    await page.locator('.bureau-slip[data-kind="meal"]').getByRole('button', { name: 'Not now' }).click();
    await page.getByRole('button', { name: 'Back to the kitchen' }).click();
    await page.waitForFunction(() => location.hash === '#/kitchen');
    const writes = sent.filter((r) => ['/api/shared-table', '/api/notes', '/api/meals'].includes(new URL(r.url()).pathname) && r.method() !== 'GET');
    expect(writes).toEqual([]);
  });

  it('Family Table: cook mode ends with the Pan\'s lines only; nothing is asked or kept (C31)', async () => {
    const sent: Request[] = [];
    const seed: Partial<PlayerState> = { ...PAN_READY, settings: settings(true) };
    app = await openApp('/#/settings', { reducedMotion: true, seed, beforeGoto: (page) => signedIn(page, sent) });
    const { page } = app;
    await cookToTheEnd(page);
    await page.waitForFunction(() => location.hash === '#/kitchen');
    expect(await page.locator('.after-cook').count()).toBe(0);
    const writes = sent.filter((r) => r.method() !== 'GET');
    expect(writes.map((r) => new URL(r.url()).pathname)).toEqual([]);
  });
});
