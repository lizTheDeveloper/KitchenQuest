import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Page, Request } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { expectNoA11yViolations, openApp, PAN_READY, writesBesidesFamilyTableReport, type OpenedApp } from './helpers';

const pan = parse(readFileSync(fileURLToPath(new URL('../../../content/dialogue/pan.yaml', import.meta.url)), 'utf8')) as { triggers: Record<string, { lines: string[] }> };
const EXPORTED = pan.triggers['book.exported'].lines;
const PARIPPU = 'india/kerala/parippu';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const VIEW = {
  xp: 40, level: 1, stamps: 1, trust: { leela: 1 }, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {},
  cookedOn: { [PARIPPU]: ['2026-11-05'] }, framesCookedOn: {},
};
const NOTES = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', recipe: PARIPPU, ops: [{ op: 'add', name: 'lime' }, { op: 'add', name: 'paste from x@y.example' }], text: 'more garlic next time, ask cook@example.com', at: '2026-11-05' },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', recipe: FRIJOLES, ops: [], text: 'never shown: no page', at: '2026-11-06' },
];

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function signedIn(page: Page, sent: Request[]): Promise<void> {
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) sent.push(r); });
  await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
  await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
  await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, { consents: [], needsReconsent: [], notices: {} })));
  await page.route((u) => u.pathname === '/api/progress', (r) => r.fulfill(json(200, { view: VIEW })));
  await page.route((u) => u.pathname === '/api/notes', (r) => r.fulfill(json(200, { notes: NOTES })));
  await page.route((u) => u.pathname.startsWith('/api/notes/'), (r) => r.fulfill({ status: 204 }));
  await page.route((u) => u.pathname === '/api/shared-table/tally', (r) => r.fulfill(json(200, { shared: 3, byRecipe: { [PARIPPU]: 2 } })));
}

describe('the Recipe Book (M5 Step 11)', () => {
  it('signed in: one page per taught dish, notes filtered on the device, the tally per dish, delete with undo, and the download', async () => {
    const sent: Request[] = [];
    app = await openApp('/#/book', { reducedMotion: true, seed: PAN_READY, beforeGoto: (page) => signedIn(page, sent) });
    const { page } = app;
    await page.locator(`.book-index-item[data-slug="${PARIPPU}"]`).waitFor();
    expect(await page.locator('.book-index-item').count()).toBe(1); // frijoles has a note but was never taught: no page
    await expectNoA11yViolations(page, 'book index');
    const index = await page.locator('#view').textContent();
    expect(index).not.toMatch(/\b\d+ of \d+\b|collected|unlocked|streak|guild|\$\s?\d/i);
    expect(index).toContain('The home cooks of');

    await page.locator(`.book-index-item[data-slug="${PARIPPU}"] a`).click();
    await page.locator('.book-notes-panel').waitFor();
    await expectNoA11yViolations(page, 'book page');
    expect(await page.locator('.book-note-text').allTextContents()).toEqual(['added lime; added paste from x@y.example; more garlic next time, ask cook@example.com']);
    expect(await page.locator('.book-shared').textContent()).toBe('Shared at your table 2 times.');
    expect(await page.locator('#view').textContent()).not.toContain('never shown');
    for (const r of sent.filter((x) => new URL(x.url()).pathname.startsWith('/api/notes'))) expect(r.url()).not.toContain('?');
    // One GET /notes per screen visit (the index, then the page), never one per recipe and never with a slug.
    expect(sent.filter((x) => new URL(x.url()).pathname === '/api/notes').map((x) => x.url().replace(/^https?:\/\/[^/]+/, ''))).toEqual(['/api/notes', '/api/notes']);

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download my book' }).click()]);
    expect(download.suggestedFilename()).toBe('kitchen-quest-recipe-book.html');
    const html = readFileSync(await download.path(), 'utf8');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toContain('cook@example.com');
    expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.\w/); // fix M3: no email-like string anywhere, ops included
    expect(html).toContain('more garlic next time');
    expect(html).toContain('skills: [legumes, heat-control, tempering]'); // the canon Cooklang source is in the file
    expect(html).toMatch(/@\w/); // its ingredient markers too
    // Fix M8: any of the book.exported lines (the Pan picks one), each saying the export never costs anything.
    expect(EXPORTED).toContain(await page.locator('.book-status').textContent());

    await page.locator('.book-note-delete').click();
    await expect.poll(() => sent.some((r) => r.method() === 'DELETE' && new URL(r.url()).pathname === `/api/notes/${NOTES[0].id}`)).toBe(true);
    await page.locator('.book-note-none').waitFor();
    expect(await page.getByRole('button', { name: 'Undo' }).count()).toBe(1);
    expect(app.consoleErrors).toEqual([]);
  });

  it('Family Table (fix I1): dishes, dates and techniques only; no notes, no tally, no text box, no writes; the export holds no notes', async () => {
    const sent: Request[] = [];
    const settings = { showCalories: false, reducedMotion: 'system' as const, familyTable: true, iosNoteDismissed: false, aiMentor: false, rescueNudges: false, voice: { on: false, readAloud: true, handsFree: false } };
    app = await openApp(`/#/book/${PARIPPU}`, { reducedMotion: true, seed: { ...PAN_READY, settings }, beforeGoto: (page) => signedIn(page, sent) });
    const { page } = app;
    await page.locator('.book-techniques').waitFor();
    await expectNoA11yViolations(page, 'book page, Family Table');
    expect(await page.locator('.book-notes-panel, textarea, input[type="text"], .book-note-delete, .book-shared').count()).toBe(0);
    expect(await page.locator('#view').textContent()).not.toContain('more garlic');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download my book' }).click()]);
    const html = readFileSync(await download.path(), 'utf8');
    expect(html).not.toContain('more garlic');
    expect(html).not.toContain('Your margin notes');
    expect(html).not.toContain('Shared at your table');
    expect(sent.filter((r) => /\/api\/(notes|shared-table)/.test(new URL(r.url()).pathname))).toEqual([]);
    expect(writesBesidesFamilyTableReport(sent)).toEqual([]);
  });

  it('signed out: the book shows the device\'s progress, no notes, and still downloads', async () => {
    app = await openApp('/#/book', { reducedMotion: true, seed: PAN_READY });
    const { page } = app;
    await page.locator('.book-empty, .book-index').first().waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download my book' }).click()]);
    const html = readFileSync(await download.path(), 'utf8');
    expect(html).not.toMatch(/<script|https?:\/\//i);
    expect(html).not.toContain('Your margin notes');
    expect(app.requests.filter((u) => /\/api\/(notes|shared-table)/.test(u))).toEqual([]);
  });

  it('an untaught dish has no page', async () => {
    app = await openApp(`/#/book/${FRIJOLES}`, { reducedMotion: true, seed: PAN_READY });
    await app.page.locator('#view h1').first().waitFor();
    expect(await app.page.locator('.book-notes-panel').count()).toBe(0);
    expect(await app.page.locator('#view').textContent()).not.toContain('Frijoles');
  });
});
