import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import type { Request } from 'playwright';
import { VOICE_ALLOWLIST } from '../src/content/voice-allowlist';
import type { PlayerState } from '../src/state/store';
import { offOrigin, openApp, PAN_READY, type OpenedApp } from './helpers';
import {
  CHROME_BANNED, CONTENT_BANNED, COUNTDOWN, LOOP_NEVER, LOOP_SCREENS, MENTOR_BANNED, RESCUE_SEED, RUSTY_SEED, SCREENS, WEEK_SEED, allowedLine, bannedPattern,
  cookThrough, loopApi, openScreen,
} from './screens';

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

type Page = OpenedApp['page'];

/**
 * Everything the page says, in two scopes: text inside a `[data-content]` element (written content) and the
 * rest (UI chrome), which also takes the title and the attributes a screen reader or a tooltip reads.
 */
async function rendered(page: Page): Promise<{ chrome: string[]; content: string[]; wholes: string[] }> {
  return page.evaluate(() => {
    const chrome: string[] = [document.title];
    const content: string[] = [];
    /** For each `content` entry, the whole text of its `[data-content]` element (the allowlist matches on that). */
    const wholes: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      const text = n.textContent?.trim();
      if (!parent || !text || parent.closest('script, style')) continue;
      const owner = parent.closest('[data-content]');
      if (owner) { content.push(text); wholes.push(owner.textContent?.trim() ?? ''); } else chrome.push(text);
    }
    for (const el of document.querySelectorAll('[aria-label], [alt], [title], [placeholder]')) {
      for (const attr of ['aria-label', 'alt', 'title', 'placeholder']) {
        const v = el.getAttribute(attr)?.trim();
        if (!v) continue;
        const owner = el.closest('[data-content]');
        if (owner) { content.push(v); wholes.push(v); } else chrome.push(v);
      }
    }
    return { chrome, content, wholes };
  });
}

const hits = (texts: string[], re: RegExp) => texts.filter((t) => re.test(t)).map((t) => `${re.exec(t)![0]} in “${t}”`);

/** Step 4's exact-line allowlist (Ruling 24, C29), for written content only. */
const ALLOWED = VOICE_ALLOWLIST.map((a) => allowedLine(a.line));
const allowlisted = (whole: string) => ALLOWED.some((re) => re.test(whole));
/**
 * The M5 never-rules scan: every LOOP_NEVER pattern (and COUNTDOWN where asked) over UI chrome, with no allowlist,
 * and over written content, where only an element whose whole text is an allowlisted line passes.
 */
function loopHits(r: { chrome: string[]; content: string[]; wholes: string[] }, countdown: boolean): string[] {
  const patterns = Object.entries({ ...LOOP_NEVER, ...(countdown ? { countdown: COUNTDOWN } : {}) });
  const out: string[] = [];
  for (const [name, re] of patterns) {
    for (const h of hits(r.chrome, re)) out.push(`${name} (chrome): ${h}`);
    r.content.forEach((t, i) => { if (re.test(t) && !allowlisted(r.wholes[i])) out.push(`${name} (content): ${re.exec(t)![0]} in “${t}”`); });
  }
  return out;
}

describe('never rules, every screen', () => {
  it('the word lists build the patterns Step 12 names, plus the compliance words', () => {
    expect(CHROME_BANNED.test('Buy now')).toBe(true);
    expect(CHROME_BANNED.test('Recipe unlocked!')).toBe(true);
    expect(CHROME_BANNED.test('3 days in a row')).toBe(true);
    expect(CHROME_BANNED.test('Only $5')).toBe(true);
    expect(CHROME_BANNED.test('HIPAA compliant')).toBe(true);
    expect(CHROME_BANNED.test('Medical-grade advice')).toBe(true);
    expect(CHROME_BANNED.test('Leela taught you Parippu')).toBe(false);
    expect(CHROME_BANNED.test('Buyers')).toBe(false);
    expect(CONTENT_BANNED.test('buy the dark ones')).toBe(false);
    expect(CONTENT_BANNED.test("nobody's food is 'exotic'")).toBe(false);
    expect(CONTENT_BANNED.test('a streak of chili')).toBe(true);
    expect(CONTENT_BANNED.test('not HIPAA-anything')).toBe(true);
    expect(bannedPattern(['tip jar']).test('the tip jar')).toBe(true);
    for (const t of ['Top of the leaderboard', 'Refer a friend', 'Referrals pay', 'ethnic food', 'Recipes collected: 3']) {
      expect(CHROME_BANNED.test(t), t).toBe(true);
    }
    for (const t of ['See the leaderboards', 'Referral bonus', 'ethnic food', 'You collected a recipe']) expect(CONTENT_BANNED.test(t), t).toBe(true);
    expect(CONTENT_BANNED.test('I can refer you to a clinician')).toBe(false);
    expect(CHROME_BANNED.test('Never referred to by gender')).toBe(false);
  });

  it('the mentor list catches sells words and voice.md §7, and passes the Pan\'s plain lines', () => {
    for (const t of ['Join the Guild', 'subscribers', 'a paid plan', 'guilt-free', 'a cheat day', 'good job skipping', 'that weird dish', 'Recipe unlocked', 'HIPAA',
      // Fix round 1 (M7): the rest of voice.md §7.
      'collect them all', 'you missed 3 days', 'Come in, mijo', 'gracias, mija']) {
      expect(MENTOR_BANNED.test(t), t).toBe(true);
    }
    for (const t of ['Check the card on screen.', 'I may have missed peanut.', "I can't find milk in your pantry"]) expect(MENTOR_BANNED.test(t), t).toBe(false);
  });

  it('every line the M4 mentor can say, and every mentor form, is free of the mentor list (all variants, not just the one shown)', () => {
    const read = (rel: string) => parse(readFileSync(fileURLToPath(new URL(`../../../content/${rel}`, import.meta.url)), 'utf8')) as Record<string, unknown>;
    const pan = read('dialogue/pan.yaml') as { triggers: Record<string, { lines: string[] }> };
    const MENTOR = /^(rule\.|log\.|pantry\.|profile\.|consent\.|intake\.|mentor\.|write\.|confirm\.|undo|card\.|ai\.|forget\.|voice\.)|^(child\.grownup|allowance\.explain|didnt_understand|rate_limited|thanks)$/;
    const ids = Object.keys(pan.triggers).filter((id) => MENTOR.test(id));
    expect(ids.length).toBeGreaterThan(40);
    const bad = ids.flatMap((id) => pan.triggers[id].lines.filter((l) => MENTOR_BANNED.test(l)).map((l) => `${id}: ${l}`));
    expect(bad).toEqual([]);
    const forms = JSON.stringify(read('bureau/forms.yaml').forms ?? read('bureau/forms.yaml'));
    expect(forms.match(/HIPAA|medical-grade|\b(guild|upgrade|subscri\w*|premium)\b|\$\s?\d/gi) ?? []).toEqual([]);
  });

  for (const sc of SCREENS) {
    it(sc.label, async () => {
      app = await openScreen(sc);
      const { page } = app;
      const r = await rendered(page);
      const { chrome, content } = r;
      expect(chrome.length, 'some chrome was read').toBeGreaterThan(0);
      expect(hits(chrome, CHROME_BANNED), `${sc.label}: UI chrome`).toEqual([]);
      expect(hits(content, CONTENT_BANNED), `${sc.label}: written content`).toEqual([]);
      if (sc.mentor) expect(hits(content, MENTOR_BANNED), `${sc.label}: mentor content (sells, voice.md §7)`).toEqual([]);
      if (sc.loop) expect(loopHits(r, sc.countdown === true), `${sc.label}: the M5 never rules`).toEqual([]);
      expect(offOrigin(app.requests, inject('baseUrl')), `${sc.label}: requests off the app's origin`).toEqual([]);
      if (sc.label === 'mentor panel open (Family Table)') {
        expect(await page.locator('textarea, input[type="text"], #pan-talk').count(), 'Family Table: no text box').toBe(0);
      }
    });
  }

  it('the rusty knife roll uses no chili red anywhere', async () => {
    const sc = SCREENS.find((s) => s.seed === RUSTY_SEED)!;
    app = await openScreen(sc);
    const { page } = app;
    expect(await page.locator('.knife-roll .fresh-rusty').count(), 'a rusty technique is showing').toBeGreaterThan(0);
    const red = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--chili)';
      document.body.append(probe);
      const chili = getComputedStyle(probe).color;
      probe.remove();
      const bad = [...document.querySelectorAll('.knife-roll, .knife-roll *')].filter((e) => {
        const s = getComputedStyle(e);
        return s.color === chili || s.backgroundColor === chili;
      }).map((e) => e.outerHTML.slice(0, 100));
      return { chili, bad };
    });
    expect(red.chili).toMatch(/^rgb/);
    expect(red.chili).not.toBe('rgb(0, 0, 0)');
    expect(red.bad).toEqual([]);
  });
});

describe('never rules, the weekly loop (M5 Step 12)', () => {
  const pan = parse(readFileSync(fileURLToPath(new URL('../../../content/dialogue/pan.yaml', import.meta.url)), 'utf8')) as { triggers: Record<string, { lines: string[] }> };
  const ftSettings = { showCalories: false, reducedMotion: 'system' as const, familyTable: true, iosNoteDismissed: false, aiMentor: false, rescueNudges: true };
  const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as PlayerState);

  it('the scan bites: every planted line is caught, and the allowlist excuses only an exact line inside [data-content]', () => {
    const planted: [string, string][] = [
      ['sells', 'Join the Guild'], ['sells', 'Only $4.99'], ['sells', 'Upgrade for more plans'], ['sells', 'subscribers cook more'],
      ['voice', 'an exotic dish'], ['voice', 'a guilt-free dinner'], ['voice', 'you missed 3 days'], ['voice', 'good job eating less'],
      ['loot', 'Recipe unlocked!'], ['loot', 'You collected Parippu'], ['loot', 'acquire a new dish'], ['loot', 'discovered in Kerala'], ['loot', 'Loot: onigiri'],
      ['streak', 'a 3-day streak'], ['streak', 'three days in a row'], ['streak', 'You missed Tuesday'],
      ['score', '3/9 cultures'], ['score', '2 of 9 kitchens'], ['score', '33% of the world'],
      ['compliance', 'HIPAA compliant'], ['compliance', 'medical-grade advice'],
      ['countdown', 'Only today'], ['countdown', '2 items left'], ['countdown', 'Hurry!'], ['countdown', 'Offer expires soon'],
    ];
    for (const [name, text] of planted) {
      const re = name === 'countdown' ? COUNTDOWN : LOOP_NEVER[name];
      expect(re.test(text), `${name}: ${text}`).toBe(true);
      // In UI chrome it always fails; in content too, unless the whole element is an allowlisted line.
      expect(loopHits({ chrome: [text], content: [], wholes: [] }, true).length, text).toBeGreaterThan(0);
      expect(loopHits({ chrome: [], content: [text], wholes: [text] }, true).length, text).toBeGreaterThan(0);
    }
    for (const t of ['Leela taught you Parippu', 'Sunday: Parippu Curry', 'Feeding yourself counts.', "That's the shop done", 'Cooked on 14 November 2026']) {
      expect(loopHits({ chrome: [t], content: [t], wholes: [t] }, true), t).toEqual([]);
    }
    const footnote = VOICE_ALLOWLIST.find((a) => a.line.includes('Missed days'))!.line;
    expect(loopHits({ chrome: [], content: [footnote], wholes: [footnote] }, false)).toEqual([]);
    expect(loopHits({ chrome: [footnote], content: [], wholes: [] }, false).length, 'no allowlist in chrome').toBeGreaterThan(0);
    expect(loopHits({ chrome: [], content: [footnote], wholes: [`${footnote} And another word.`] }, false).length, 'an edited line fails').toBeGreaterThan(0);
    const templated = VOICE_ALLOWLIST.find((a) => a.line.includes('{term}'))!.line;
    expect(loopHits({ chrome: [], content: [templated.replace('{term}', 'sesame')], wholes: [templated.replace('{term}', 'sesame')] }, false)).toEqual([]);
  });

  it('every M5 screen is swept in standard and in Family Table mode (C31)', () => {
    const labels = SCREENS.filter((s) => s.loop).map((s) => s.label);
    for (const screen of ['plan', 'market list', 'pantry frame', 'book', 'book page', 'after cook', 'visit', 'kitchen: the apprentice card']) {
      expect(labels.some((l) => l.startsWith(screen) && !/Family Table/.test(l)), `${screen}, standard`).toBe(true);
      expect(labels.some((l) => l.startsWith(screen) && /Family Table/.test(l)), `${screen}, Family Table`).toBe(true);
    }
    for (const part of ['drill', 'riddle', 'recognize', 'errand', 'adapted: a blocked errand', 'adapted: a ❓ dish', 'rescue', 'move-this-week', 'guest-progress offer', 'margin note', 'one-tap log', 'who ate']) {
      expect(labels.some((l) => l.includes(part)), part).toBe(true);
    }
    expect(LOOP_SCREENS.every((s) => s.loop)).toBe(true);
  });

  it('a Rusty toolkit row carries no warning or danger class (§17 Freshness)', async () => {
    app = await openScreen(SCREENS.find((s) => s.seed === RUSTY_SEED)!);
    const { page } = app;
    expect(await page.locator('.knife-roll .fresh-rusty').count()).toBeGreaterThan(0);
    const bad = await page.evaluate(() => [...document.querySelectorAll('.knife-roll, .knife-roll *')]
      .filter((e) => /\b(warning|danger|alert|error|red)\b/i.test(e.getAttribute('class') ?? '') || /alert/.test(e.getAttribute('role') ?? ''))
      .map((e) => e.outerHTML.slice(0, 100)));
    expect(bad).toEqual([]);
  });

  it('the Use-It-Up rescue appears at most once a day, across reloads, and never a second item that day', async () => {
    app = await openApp('/', { reducedMotion: true, seed: RESCUE_SEED });
    const { page } = app;
    const rescue = page.locator('.rescue');
    await rescue.waitFor();
    const first = await rescue.locator('.rescue-line').textContent();
    expect(first).toContain('spinach');
    // A second item that could be rescued today: the day's one nudge stays the spinach.
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('kq.player.v1')!) as PlayerState;
      const d = new Date(Date.now() - 86_400_000);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      s.localPantry = [...s.localPantry, { id: 'herb', name: 'coriander', ingredientId: 'herb', addedOn: day, source: 'market' }, { id: 'tom', name: 'soft tomatoes', ingredientId: 'tomato', addedOn: day, source: 'market' }];
      localStorage.setItem('kq.player.v1', JSON.stringify(s));
    });
    await page.reload();
    await rescue.waitFor();
    expect(await rescue.locator('.rescue-line').textContent()).toBe(first);
    await rescue.getByRole('button', { name: 'Not now' }).click();
    await rescue.waitFor({ state: 'detached' });
    for (let i = 0; i < 2; i++) {
      await page.reload();
      await page.locator('.apprentice-card').waitFor();
      await page.waitForTimeout(400);
      expect(await page.locator('.rescue').count(), `reload ${i + 1}`).toBe(0);
    }
  });

  it('"Just me" is met with "Feeding yourself counts" (audit M-9: eating alone gets equal warmth)', async () => {
    app = await openApp(`/#/cook/india/kerala/parippu`, { reducedMotion: true, seed: PAN_READY, beforeGoto: loopApi, initScript: 'Math.random = () => 0;' });
    const { page } = app;
    await page.waitForFunction(() => Boolean((JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as { account?: unknown }).account));
    await cookThrough(page);
    const who = page.locator('.bureau-slip[data-kind="cooked_for"]');
    await who.getByRole('button', { name: 'Just me' }).click();
    await who.getByRole('button', { name: 'Stamp it ✔' }).click();
    await page.locator('.after-cook-line', { hasText: 'Feeding yourself counts' }).waitFor();
    expect(pan.triggers['cooked_for.alone'].lines).toContain(await page.locator('.after-cook-line', { hasText: 'Feeding yourself counts' }).textContent());
  });

  it('Family Table (C31): the plan, the market and the after-cook flow write nothing, to the store or to /api/**', async () => {
    const sent: Request[] = [];
    const seed: Partial<PlayerState> = { ...WEEK_SEED, settings: ftSettings };
    app = await openApp('/#/plan', {
      reducedMotion: true, seed,
      beforeGoto: async (page) => { page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) sent.push(r); }); await loopApi(page); },
    });
    const { page } = app;
    await page.waitForFunction(() => Boolean((JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as { account?: unknown }).account));
    const before = await stored(page);
    const go = async (hash: string) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForFunction((h) => location.hash === h, hash); };
    await go('#/plan');
    await page.locator('.plan-view').waitFor();
    expect(await page.locator('.plan-save, .plan-remove, .plan-add, .plan-slot-yes, .plan-slot-no, #plan-hard, input, textarea').count(), 'plan: no control writes').toBe(0);
    await go('#/market');
    await page.locator('.market-body').waitFor();
    await page.waitForTimeout(300);
    expect(await page.locator('.market-tick, .market-done, input, textarea').count(), 'market: no box, no finish').toBe(0);
    await go('#/cook/india/kerala/parippu');
    await cookThrough(page);
    await page.waitForFunction(() => location.hash === '#/kitchen');
    expect(await page.locator('.after-cook, textarea, input[type="text"]').count()).toBe(0);
    const after = await stored(page);
    for (const k of ['localWeek', 'localPantry', 'progress', 'localProfile', 'localRules'] as const) expect(after[k], k).toEqual(before[k]);
    // The account's partition holds no new event, grant or upload (its cached copy of the account's view is a read).
    const logged = (st: PlayerState) => Object.values(st.accountProgress ?? {}).map((a) => ({ events: a.progress.events, grants: a.progress.grants, pending: a.progress.pendingUpload }));
    expect(logged(after).every((a) => a.events.length === 0 && a.grants.length === 0 && a.pending.length === 0)).toBe(true);
    expect(logged(before).length).toBeLessThanOrEqual(logged(after).length);
    expect(sent.filter((r) => r.method() !== 'GET').map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([]);
  });

  it('the Recipe Book export file says nothing the never rules forbid (signed in with notes, and in Family Table mode)', async () => {
    for (const familyTable of [false, true]) {
      app = await openApp('/#/book/india/kerala/parippu', {
        reducedMotion: true, seed: { ...PAN_READY, ...(familyTable ? { settings: ftSettings } : {}) }, beforeGoto: loopApi,
      });
      const { page } = app;
      await page.locator('.book-techniques').waitFor();
      if (!familyTable) await page.locator('.book-notes-panel').waitFor();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download my book' }).click()]);
      const html = readFileSync(await download.path(), 'utf8');
      // The file's words, line by line (tags and the recipe's Cooklang markers aside).
      // Cooklang writes a quantity as {100%g}: that % separates amount and unit, it is not a percentage.
      const text = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/\{([^}]*)\}/g, (_m, q: string) => `{${q.replace(/%/g, ' ')}}`);
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      expect(lines.length).toBeGreaterThan(5);
      expect(loopHits({ chrome: lines, content: [], wholes: [] }, false), familyTable ? 'Family Table export' : 'export').toEqual([]);
      expect(html.includes('more garlic'), 'notes only outside Family Table').toBe(!familyTable);
      await app.close();
      app = null;
    }
  });
});
