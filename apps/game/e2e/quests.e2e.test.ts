import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Route } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { ProgressEvent, ProgressView } from '@kitchenquest/core/engine';
import { STORE_KEY } from '../src/state/store';
import { expectNoA11yViolations, openApp, PAN_READY, type OpenedApp } from './helpers';

const yaml = <T>(rel: string): T => parse(readFileSync(fileURLToPath(new URL(`../../../content/${rel}`, import.meta.url)), 'utf8')) as T;
interface RiddleStep { type: 'riddle'; prompt: string; options: { text: string; correct: boolean; reaction: string }[] }
const leela = yaml<{ name: string; intro: string[]; quest: { id: string; steps: ({ type: string } | RiddleStep)[] } }>('cooks/leela.yaml');
const pan = yaml<{ triggers: Record<string, { lines: string[] }> }>('dialogue/pan.yaml');
const riddle = leela.quest.steps.find((s): s is RiddleStep => s.type === 'riddle')!;
const LEELA_PIN = 'Visit Ammachi Leela — Kochi, Kerala, India';
const MARISOL_PIN = 'Visit Doña Marisol — Oaxaca, Mexico';
/** Never anywhere (Step 12 scans): streaks, runs of days, countdowns, "x of 9", loot words. */
const NEVER = /\bstreak|in a row|days? running|countdown|\b\d+\s*(of|\/)\s*9\b|unlock|loot|collect(ed)?\b/i;

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });
type Page = OpenedApp['page'];

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const stored = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null') as { progress: { events: ProgressEvent[]; pendingUpload: string[] }; account: unknown }, STORE_KEY);

/** Click through dialogue lines and answer quest panels with `answer` until `until` holds. */
async function playUntil(page: Page, answer: (panel: string) => string, until: () => Promise<boolean>) {
  for (let i = 0; i < 120; i += 1) {
    if (await until()) return;
    const panel = page.locator('.quest-panel');
    if (await panel.count()) {
      const text = (await panel.textContent()) ?? '';
      await panel.getByRole('button', { name: answer(text), exact: true }).click();
      continue;
    }
    const next = page.locator('.dialogue .dialogue-next');
    if (await next.count()) { await next.click(); continue; }
    await page.waitForTimeout(50);
  }
  throw new Error('the quest never got there');
}

/** A signed-out player plays Leela's whole quest to cook mode and cooks parippu. */
async function playLeelaQuest(page: Page) {
  await page.locator('#view h1', { hasText: 'World map' }).waitFor();
  // Ruling 3: no locked pin. Leela is expecting you; Marisol awaits an introduction and is visitable anyway.
  expect(await page.locator('#pin-state-leela').textContent()).toBe('Expecting you');
  expect(await page.locator('#pin-state-marisol').textContent()).toBe('Awaiting an introduction');
  expect(await page.getByRole('button', { name: MARISOL_PIN }).isDisabled()).toBe(false);
  await page.getByRole('button', { name: MARISOL_PIN }).click();
  const permit = page.getByRole('dialog', { name: 'Travel Permit' });
  await permit.waitFor();
  expect(await permit.textContent()).toContain('Awaiting an introduction');
  expect(await permit.getByRole('button', { name: 'Travel anyway' }).count()).toBe(1);
  await permit.getByRole('button', { name: 'Not quite' }).click();

  await page.getByRole('button', { name: LEELA_PIN }).click();
  await page.getByRole('button', { name: 'Stamp it ✔' }).click();
  await page.waitForFunction(() => location.hash === '#/visit/leela');
  let wrongShown = false;
  let riddleChecked = false;
  await playUntil(page, (panel) => {
    if (panel.includes(riddle.prompt)) {
      if (!wrongShown) { wrongShown = true; return riddle.options.find((o) => !o.correct)!.text; }
      return riddle.options.find((o) => o.correct)!.text;
    }
    if (panel.includes('Fetch')) return "I've got it";
    return "I've practised it";
  }, async () => {
    if (wrongShown && !riddleChecked && await page.locator('.quest-reaction').count()) {
      // A wrong option: its reaction, the same riddle, no penalty. Answers are buttons and the panel is axe-clean.
      const wrong = riddle.options.find((o) => !o.correct)!;
      expect(await page.locator('.quest-reaction').textContent()).toBe(wrong.reaction);
      expect(await page.locator('.quest-panel button').count()).toBe(riddle.options.length);
      await expectNoA11yViolations(page, 'riddle');
      riddleChecked = true;
    }
    return (await page.getByRole('dialog', { name: /Parippu/ }).count()) > 0;
  });
  expect(riddleChecked).toBe(true);
  // Paused at the cook step: the recipe card opens; Cook leads to cook mode.
  const card = page.getByRole('dialog', { name: /Parippu/ });
  await card.getByRole('button', { name: /Cook it/ }).click();
  await page.waitForFunction(() => location.hash === '#/cook/india/kerala/parippu');
  await page.locator('.cook-progress', { hasText: 'Step 1 of' }).waitFor();
  for (;;) {
    const next = page.getByRole('button', { name: /Next step/ });
    if (await next.count() === 0) break;
    await next.click();
  }
  await page.getByRole('button', { name: /^Done/ }).click();
  await page.getByRole('dialog', { name: /Certificate of a Dish Cooked/ }).waitFor();
}

describe('quests and the progress log (M5 Step 9)', () => {
  it('a signed-out quest to cook mode; sign in; upload; account view lower; no level drops', async () => {
    let signedIn = false;
    const posts: { events: ProgressEvent[]; upload?: boolean }[] = [];
    // The account knows nothing yet (as if compacted device events never reached it): a lower view.
    const accountView: ProgressView = { xp: 0, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {} };
    app = await openApp('/#/map', {
      reducedMotion: true,
      seed: { ...PAN_READY, firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() },
      beforeGoto: (page) => page.route((u) => u.pathname.startsWith('/api/'), async (route: Route) => {
        const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        if (!signedIn) return route.fulfill(json(401, { error: { code: 'unauthorized', message: 'Sign in required' } }));
        if (path === '/me') return route.fulfill(json(200, { id: 'u1', email: 'cook@example.test', entitlements: [] }));
        if (path === '/rules') return route.fulfill(json(200, { rules: [] }));
        if (path === '/pantry') return route.fulfill(json(200, { items: [] }));
        if (path === '/progress') return route.fulfill(json(200, { view: accountView }));
        if (path === '/progress/events') {
          const body = route.request().postDataJSON() as { events: ProgressEvent[]; upload?: boolean };
          posts.push(body);
          return route.fulfill(json(200, { accepted: body.events.map((e) => ({ clientId: e.id, grants: [] })), duplicate: [], rejected: [], warnings: [], view: accountView }));
        }
        return route.fulfill(json(404, { error: { code: 'not_found', message: 'no' } }));
      }),
    });
    const { page } = app;
    await playLeelaQuest(page);

    // The quest's grants became the Pan's lines, from grants only: the trust line and the stamp (no XP number).
    const toasts = await page.locator('.progress-toast').allTextContents();
    const trustUp = pan.triggers.trust_up.lines.map((l) => l.replaceAll('{cook}', leela.name));
    const stampUp = pan.triggers.stamp_earned.lines.map((l) => l.replaceAll('{stamp}', 'A Quest, Completed With Thanks'));
    expect(toasts.filter((t) => trustUp.includes(t)), toasts.join(' | ')).toHaveLength(1);
    expect(toasts.filter((t) => stampUp.includes(t)), toasts.join(' | ')).toHaveLength(1);
    expect(toasts.join(' ')).not.toMatch(/\bXP\b|\+\d/);
    const s = await stored(page);
    const kinds = s.progress.events.map((e) => (e.kind === 'quest_step' ? `step${e.step}` : e.kind));
    expect(kinds).toEqual(['step1', 'step2', 'step3', 'drill', 'step4', 'step5', 'cooked', 'step6', 'quest_done']);
    expect(s.progress.pendingUpload).toEqual(s.progress.events.map((e) => e.id));
    await page.getByRole('dialog', { name: /Certificate of a Dish Cooked/ }).getByRole('button', { name: 'Continue' }).click();
    // Step 11: the after-cook questions come next; one tap leaves them.
    await page.getByRole('button', { name: 'Back to the kitchen' }).click();
    await page.waitForFunction(() => location.hash === '#/kitchen');
    const card = page.locator('.apprentice-card');
    await card.waitFor();
    const before = { level: await card.locator('.apprentice-level').textContent(), stamps: await card.locator('.apprentice-stamps').textContent() };
    expect(before.stamps).not.toBe('Bureau Stamps: 0');
    expect(await card.textContent()).not.toMatch(NEVER);
    expect(await card.locator('progress, [role="progressbar"], meter').count()).toBe(0);
    await expectNoA11yViolations(page, 'apprentice card');

    // Sign in (the account check runs again when the connection comes back). C1 ruling: nothing of the guest's goes up
    // on its own, and the account shows only its own progress, until the player taps the offer.
    signedIn = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const offer = page.getByRole('region', { name: "Add this device's progress to your account?" });
    await offer.waitFor();
    await page.waitForTimeout(300);
    expect(posts).toEqual([]);
    expect(await card.locator('.apprentice-stamps').textContent()).toBe('Bureau Stamps: 0');
    await expectNoA11yViolations(page, 'guest progress offer');
    await offer.getByRole('button', { name: 'Add it to my account' }).click();
    await page.waitForFunction((k) => (JSON.parse(localStorage.getItem(k)!) as { progress: { pendingUpload: string[] } }).progress.pendingUpload.length === 0, STORE_KEY);
    expect(posts.every((p) => p.upload === true)).toBe(true);
    expect(posts.flatMap((p) => p.events.map((e) => e.id))).toEqual(s.progress.events.map((e) => e.id));
    await offer.waitFor({ state: 'detached' });
    // The account's view is lower; the card shows the field-wise max with what was added, so nothing shown drops.
    await page.locator('.apprentice-stamps', { hasText: before.stamps! }).waitFor();
    expect(await page.locator('.apprentice-level').textContent()).toBe(before.level);
    // A reload signed in: still no drop, and no second upload.
    await page.reload();
    await page.locator('.apprentice-card').waitFor();
    await page.waitForTimeout(300);
    expect(await page.locator('.apprentice-stamps').textContent()).toBe(before.stamps);
    expect(posts.flatMap((p) => p.events)).toHaveLength(s.progress.events.length);
    expect(app.consoleErrors).toEqual([]);
  });

  it('adapted panels: a blocked errand passes as adapted, a ⛔ dish with no stand-in is taught as a lesson (axe-clean)', async () => {
    const shallot = { id: 'r1', target: { kind: 'ingredient' as const, ids: ['shallot'] }, type: 'avoid' as const, severity: 'anaphylactic' as const };
    app = await openApp('/#/visit/leela', { reducedMotion: true, seed: { ...PAN_READY, localRules: [shallot] } });
    const { page } = app;
    const adapted = pan.triggers['quest.errand_adapted'].lines.map((l) => l.replaceAll('{cook}', leela.name));
    let sawAdapted = false;
    let lessonChecked = false;
    await playUntil(page, (panel) => {
      expect(panel).not.toContain('Fetch'); // a blocked item is never sent for
      if (panel.includes(riddle.prompt)) return riddle.options.find((o) => o.correct)!.text;
      if (panel.includes('Learn it as a lesson')) return 'Learn it as a lesson';
      return "I've practised it";
    }, async () => {
      const said = await page.locator('#pan-panel .bubble.pan .bubble-text').allTextContents();
      if (said.some((t) => adapted.includes(t))) sawAdapted = true;
      if (!lessonChecked && (await page.locator('.quest-panel', { hasText: 'Learn it as a lesson' }).count())) {
        expect(await page.locator('.quest-panel').textContent()).toContain("isn't cookable with your rules");
        expect(await page.locator('.quest-panel').getByRole('button', { name: 'Cook it anyway' }).count()).toBe(0); // ⛔: never
        await expectNoA11yViolations(page, 'adapted lesson panel');
        lessonChecked = true;
      }
      return (await page.getByRole('button', { name: 'See the recipe: Parippu' }).count()) > 0 && (await page.locator('.quest-panel, .dialogue').count()) === 0;
    });
    expect(sawAdapted).toBe(true);
    expect(lessonChecked).toBe(true);
    const s = await stored(page);
    expect(s.progress.events.map((e) => e.kind).slice(-3)).toEqual(['quest_step', 'lesson', 'quest_done']);
    expect(app.consoleErrors).toEqual([]);
  });

  it('a ❓ quest dish offers the lesson and "Cook it anyway" (the card stays ❓); unreadable rules wait with a link to Your rules', async () => {
    const peanut = { id: 'r1', target: { kind: 'ingredient' as const, ids: ['peanut'] }, type: 'avoid' as const, severity: 'anaphylactic' as const };
    app = await openApp('/#/visit/leela', { reducedMotion: true, seed: { ...PAN_READY, localRules: [peanut] } });
    const { page } = app;
    await playUntil(page, (panel) => {
      if (panel.includes(riddle.prompt)) return riddle.options.find((o) => o.correct)!.text;
      if (panel.includes('Fetch')) return "I've got it";
      if (panel.includes('Cook it anyway')) return 'Cook it anyway';
      return "I've practised it";
    }, async () => {
      if (await page.locator('.quest-panel', { hasText: 'Cook it anyway' }).count()) {
        expect(await page.locator('.quest-panel button').allTextContents()).toEqual(['Learn it as a lesson', 'Cook it anyway', 'Not yet']);
        await expectNoA11yViolations(page, 'unverified dish panel');
      }
      return (await page.getByRole('dialog', { name: /Parippu/ }).count()) > 0;
    });
    expect(await page.getByRole('dialog', { name: /Parippu/ }).textContent()).toContain('❓');
    await app.close();

    app = await openApp('/#/visit/leela', { reducedMotion: true, seed: { ...PAN_READY, rulesUnreadable: true } });
    const p2 = app.page;
    await playUntil(p2, () => 'Later', async () => (await p2.locator('.quest-panel a.quest-rules-link').count()) > 0);
    expect(await p2.locator('.quest-panel a.quest-rules-link').getAttribute('href')).toBe('#/rules');
    await expectNoA11yViolations(p2, 'rules-wait panel');
  });

  it('a return visit (trust 1) opens with a trust line, then the card; the map never shows a lock', async () => {
    app = await openApp('/#/map', { reducedMotion: true, seed: { ...PAN_READY } });
    const { page } = app;
    await playLeelaQuest(page);
    await page.getByRole('dialog', { name: /Certificate of a Dish Cooked/ }).getByRole('button', { name: 'Continue' }).click();
    // Step 11: the after-cook questions come next; one tap leaves them.
    await page.getByRole('button', { name: 'Back to the kitchen' }).click();
    await page.waitForFunction(() => location.hash === '#/kitchen');
    await page.evaluate(() => { location.hash = '#/map'; });
    await page.locator('#pin-state-leela').waitFor();
    expect(await page.locator('.map-pin:disabled, .map-pin[aria-disabled="true"]').count()).toBe(0);
    // The pins and their states (the Bureau's anti-loot footnote, allowlisted under C29, is content and not scanned here).
    expect((await page.locator('#view .map-pins').textContent())!).not.toMatch(NEVER);
    await page.getByRole('button', { name: LEELA_PIN }).click();
    await page.getByRole('button', { name: 'Stamp it ✔' }).click();
    await page.waitForFunction(() => location.hash === '#/visit/leela');
    const line = await page.locator('.dialogue .dialogue-text .typed-full').textContent();
    const trust1 = yaml<{ trust_lines: Record<string, string[]> }>('cooks/leela.yaml').trust_lines['1'];
    expect(trust1).toContain(line);
    expect(leela.intro).not.toContain(line);
    await page.locator('.dialogue .dialogue-next').click();
    // Then the card (Step 9: "the trust_lines[level] line, then the card").
    await page.getByRole('dialog', { name: /Parippu/ }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'See the recipe: Parippu' }).waitFor();
    expect(await page.getByRole('button', { name: 'Carry on with the quest' }).count()).toBe(0);
    expect(app.consoleErrors).toEqual([]);
  });
});
