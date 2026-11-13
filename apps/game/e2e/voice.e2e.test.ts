// M7 Step 11: voice end to end in a real browser. Chromium's fake microphone plays a synthetic clip
// (fixtures/voice/make.mjs) and `page.routeWebSocket` scripts the API's voice socket (voice-fake.ts); `/api/**` is
// mocked. What is pinned: §7.6 spell-back (the heard card before anything is sent), Ruling 15 (a speak names items, no
// text), §7.6b.8 (the filler), barge-in (Ruling 10), the allowance as a state (Ruling 5), §19 (no microphone in Family
// Table or for a child: Rulings 9 and 17) and §7.7 (no audio or transcript at rest, D1 with a positive control).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { HEARD_YES } from '../src/mentor/heard-card';
import { STORE_KEY, type PlayerState } from '../src/state/store';
import { expectNoA11yViolations, expectNoHorizontalScroll, openApp, openHandsFreeApp, PAN_READY, type OpenedApp } from './helpers';
import { FAKE_MIC_ARGS, fakeVoiceApi, GUM_SPY, lineTurn, newVoiceFake, ruleTurn, type VoiceFake } from './voice-fake';

let app: OpenedApp | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const pan = parse(readFileSync(fileURLToPath(new URL('../../../content/dialogue/pan.yaml', import.meta.url)), 'utf8')) as { triggers: Record<string, { lines: string[] }> };
const lines = (t: string): string[] => pan.triggers[t].lines;
type Settings = PlayerState['settings'];
const settings = (voice: Partial<Settings['voice']> = {}, extra: Partial<Settings> = {}): Settings => ({
  showCalories: false, reducedMotion: 'system', familyTable: false, iosNoteDismissed: false, aiMentor: true, rescueNudges: true,
  voice: { on: true, readAloud: true, handsFree: false, ...voice }, ...extra,
});
const liveTracks = (page: Page) => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length);
const gum = (page: Page) => page.evaluate(() => (window as unknown as { __gum: number }).__gum);
const signedIn = (page: Page) => expect.poll(() => page.evaluate((k) => (JSON.parse(localStorage.getItem(k) ?? '{}') as { account?: unknown }).account ?? null, STORE_KEY)).not.toBeNull();
const panTexts = (page: Page) => page.locator('#pan-panel .bubble.pan .bubble-text').allTextContents();

async function open(fake: VoiceFake, opts: { path?: string; width?: number; voice?: Partial<Settings['voice']>; extra?: Partial<Settings>; turn?: (b: Record<string, unknown>) => unknown; handsFreeBuild?: boolean; seed?: Partial<PlayerState> } = {}) {
  app = await (opts.handsFreeBuild ? openHandsFreeApp : openApp)(opts.path ?? '/#/settings', {
    reducedMotion: true, width: opts.width ?? 1280, launchArgs: FAKE_MIC_ARGS, initScript: GUM_SPY,
    seed: { ...PAN_READY, ...opts.seed, settings: settings(opts.voice, opts.extra) },
    beforeGoto: (page) => fakeVoiceApi(page, fake, { turn: opts.turn }),
  });
  await signedIn(app.page);
  return app.page;
}

/** Holds the talk control with the keyboard (Space) until the API has the listen, then lets go. */
async function sayIt(page: Page, fake: VoiceFake, transcript: string, key: 'Space' | 'Enter' = 'Space') {
  fake.transcripts.push(transcript);
  const listens = fake.sent.filter((m) => m.t === 'listen').length;
  const talk = page.locator('#pan-talk');
  await talk.focus();
  await page.keyboard.down(key);
  await expect.poll(() => fake.sent.filter((m) => m.t === 'listen').length, { timeout: 10_000 }).toBe(listens + 1);
  // Some audio from the fake microphone goes up while held.
  const frames = fake.frames;
  await expect.poll(() => fake.frames, { timeout: 10_000 }).toBeGreaterThan(frames);
  await page.keyboard.up(key);
  await expect.poll(() => fake.sent.filter((m) => m.t === 'end').length).toBe(listens + 1);
  return fake.sent.filter((m) => m.t === 'listen').at(-1)!.id as number;
}

const speaks = (fake: VoiceFake) => fake.sent.filter((m) => m.t === 'speak') as { id: number; items: Record<string, unknown>[] }[];

describe('voice: consent, spell-back and the heard gate (§7.6, Ruling 4)', () => {
  for (const width of [400, 1280]) {
    it(`at ${width} px: Settings → Voice → "Talk out loud" → the voice card → I agree (the microphone only after); a held "I'm allergic to sesame" → the heard card spells S-E-S-A-M-E, nothing sent; its tap → one transcript turn with heard words → the rule card`, async () => {
      const fake = newVoiceFake({ voiceGranted: false });
      const page = await open(fake, { width, voice: { on: false }, turn: () => ruleTurn('sesame') });
      const on = page.locator('#set-voice-on');
      await on.waitFor();
      await on.click(); // the box stays clear until the card's I agree
      const card = page.locator('#voice-settings .voice-consent .consent-agree');
      await card.waitFor();
      expect(await gum(page)).toBe(0);
      await expectNoA11yViolations(page, 'Settings → Voice with the voice consent card');
      await card.click();
      await expect.poll(() => page.locator('#set-voice-on').isChecked()).toBe(true);
      expect(fake.voiceGranted).toBe(true);
      expect(await gum(page)).toBe(0); // consent alone opens nothing (§7.7: voice is off until the player turns it on)
      await expectNoHorizontalScroll(page);

      await page.locator('#pan-button').click();
      await page.locator('#pan-talk').waitFor();
      const id = await sayIt(page, fake, "I'm allergic to sesame");
      expect(await gum(page)).toBe(1);
      const heard = page.locator('#pan-panel .heard-card');
      await heard.waitFor();
      expect(await heard.locator('.heard-spelled').first().textContent()).toBe('S-E-S-A-M-E');
      await expectNoA11yViolations(page, 'the heard card');
      expect(fake.turns).toEqual([]);
      // Ruling 15: the heard read-back is named by the utterance id; no text or vars leave the device.
      await expect.poll(() => speaks(fake).length).toBeGreaterThan(0);
      expect(speaks(fake).at(-1)!.items).toEqual([{ kind: 'heard', utteranceId: id }]);
      expect(JSON.stringify(fake.sent)).not.toMatch(/"(text|vars)"/);

      await heard.getByRole('button', { name: HEARD_YES }).click();
      await expect.poll(() => fake.turns.length).toBe(1);
      expect(fake.turns[0]).toMatchObject({ input: { kind: 'transcript', text: "I'm allergic to sesame", heard: { words: ['sesame'] } } });
      const rule = page.locator('#pan-panel .pan-card', { hasText: '27-B/ALLERGEN' });
      await rule.waitFor();
      expect(await rule.textContent()).toContain('S-E-S-A-M-E');
      await expectNoHorizontalScroll(page);
      expect(app!.consoleErrors).toEqual([]);
    });
  }

  it('a spoken "yes" to a severe card is answered with the tap line, and confirms nothing (§7.6: severe needs a tap)', async () => {
    const fake = newVoiceFake();
    const page = await open(fake, {
      turn: (b) => ((b.input as { text: string }).text === 'yes' ? lineTurn('rule.tap_needed', { ingredient: 'sesame' }) : ruleTurn('sesame')),
    });
    await page.locator('#pan-button').click();
    await sayIt(page, fake, "I'm allergic to sesame");
    await page.locator('#pan-panel .heard-card').getByRole('button', { name: HEARD_YES }).click();
    await page.locator('#pan-panel .pan-card', { hasText: '27-B/ALLERGEN' }).waitFor();
    const confirms = () => fake.requests.filter((r) => r.url().includes('/confirm'));
    await sayIt(page, fake, 'yes');
    await expect.poll(() => fake.turns.length).toBe(2);
    expect(fake.turns[1]).toMatchObject({ input: { kind: 'transcript', text: 'yes' } });
    const tap = lines('rule.tap_needed').map((l) => l.replace('{ingredient}', 'sesame'));
    await expect.poll(async () => tap.includes((await panTexts(page)).at(-1) ?? '')).toBe(true);
    expect(confirms()).toEqual([]);
  });
});

describe('voice: the filler, barge-in, the allowance and the text box', () => {
  it('a 2 s turn: the sizzle filler (voice.filler.*) is spoken before the reply; the reply speaks reply items for exactly what is drawn', async () => {
    const fake = newVoiceFake({ turnDelayMs: 2000 });
    const page = await open(fake, { turn: () => lineTurn('thanks') });
    await page.locator('#pan-button').click();
    await sayIt(page, fake, 'what should I cook tonight');
    await expect.poll(() => fake.turns.length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => speaks(fake).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    const [filler, reply] = speaks(fake);
    expect(filler.items).toHaveLength(1);
    expect(String(filler.items[0].trigger)).toMatch(/^voice\.filler\./);
    expect(reply.items.every((i) => i.kind === 'reply' || i.kind === 'card' || i.kind === 'line')).toBe(true);
    // Exactly what is on screen: one drawn line, one spoken item.
    const drawn = (await panTexts(page)).filter((t) => lines('thanks').includes(t));
    expect(drawn).toHaveLength(1);
    expect(reply.items).toEqual([{ kind: 'reply', replyId: 'r2', part: 0 }]);
  });

  it('a press while the Pan speaks cancels its speech (barge-in); the card already drawn stays', async () => {
    const fake = newVoiceFake();
    const page = await open(fake, { turn: () => ruleTurn('sesame') });
    await page.locator('#pan-button').click();
    await sayIt(page, fake, "I'm allergic to sesame");
    const heard = page.locator('#pan-panel .heard-card');
    await heard.waitFor();
    await expect.poll(() => speaks(fake).length).toBe(1);
    const speakId = speaks(fake)[0].id;
    // Press at once (the fake "speaks" for 400 ms).
    await sayIt(page, fake, 'never mind');
    expect(fake.sent.some((m) => m.t === 'cancel' && m.id === speakId)).toBe(true);
    expect(await heard.isVisible()).toBe(true);
  });

  it('resting: "Voice is resting until …" and no listen; resting_today: "for today"; the text box still works', async () => {
    for (const state of [{ kind: 'resting', until: '2026-11-20' }, { kind: 'resting_today' }] as const) {
      const fake = newVoiceFake({ state });
      const page = await open(fake, { turn: () => lineTurn('thanks') });
      await page.locator('#pan-button').click();
      await page.locator('#pan-talk').focus();
      await page.keyboard.down('Space');
      await expect.poll(() => fake.sent.filter((m) => m.t === 'hello').length).toBe(1);
      await page.keyboard.up('Space');
      const want = state.kind === 'resting' ? lines('voice.resting').map((l) => l.split('{')[0]) : lines('voice.resting_today');
      await expect.poll(async () => { const t = (await panTexts(page)).at(-1) ?? ''; return want.some((w) => t.startsWith(w)); }).toBe(true);
      await page.locator('#pan-text').fill('hello there');
      await page.keyboard.press('Enter');
      await expect.poll(() => fake.turns.length).toBe(1);
      expect(fake.sent.filter((m) => m.t === 'listen')).toEqual([]);
      expect(fake.frames).toBe(0);
      await app!.close();
      app = undefined;
    }
  });
});

describe('voice: §19, no microphone for children or on a Family Table (Rulings 9 and 17)', () => {
  it('Family Table: PUT /voice/family-table {on:true}; no talk button, no getUserMedia, no voice socket on any screen', async () => {
    const fake = newVoiceFake();
    const page = await open(fake, { path: '/', extra: { familyTable: true } });
    await expect.poll(() => fake.familyTable.length).toBeGreaterThan(0);
    expect(fake.familyTable[0]).toMatchObject({ on: true });
    const { SCREENS } = await import('./screens');
    for (const sc of SCREENS) {
      await page.evaluate((p) => { location.hash = p.replace(/^\/#?/, ''); }, sc.path);
      await page.waitForTimeout(100);
      await page.locator('#pan-button').click({ timeout: 1000 }).catch(() => undefined);
      expect(await page.locator('#pan-talk').count(), sc.label).toBe(0);
      expect(await page.locator('.hands-free-toggle:visible').count(), sc.label).toBe(0);
      await page.keyboard.press('Escape');
    }
    expect(await gum(page)).toBe(0);
    expect(fake.sockets).toBe(0);
  });

  for (const reason of ['child', 'family_table'] as const) {
    it(`the server closes with ${reason}: the microphone stops, the control is closed with one line, and a press opens no microphone`, async () => {
      const fake = newVoiceFake();
      const page = await open(fake);
      await page.locator('#pan-button').click();
      await sayIt(page, fake, 'what should I cook tonight');
      await expect.poll(() => fake.turns.length).toBe(1);
      await expect.poll(async () => lines('thanks').includes((await panTexts(page)).at(-1) ?? '')).toBe(true);
      fake.blocked = reason;
      fake.ws!.send(JSON.stringify({ t: 'closed', reason }));
      await fake.ws!.close({ code: reason === 'child' ? 4451 : 4452 });
      // Rulings 9 and 17 (Step 9 I-2): the control is closed (a "blocked" control that hears nothing), one line says why.
      const said = lines(reason === 'child' ? 'voice.child_block' : 'voice.family_table');
      await expect.poll(async () => (await panTexts(page)).filter((t) => said.includes(t)).length).toBe(1);
      await expect.poll(() => page.locator('#pan-talk').getAttribute('data-phase')).toBe('blocked');
      // The microphone stopped: no live track on the page.
      await expect.poll(() => liveTracks(page)).toBe(0);
      // A press opens no microphone and sends no listen (it may ask the API again, which refuses: Step 9 I-2).
      const [g, listens] = [await gum(page), fake.sent.filter((m) => m.t === 'listen').length];
      await page.locator('#pan-talk').focus();
      await page.keyboard.down('Space');
      await page.waitForTimeout(500);
      await page.keyboard.up('Space');
      expect(await gum(page)).toBe(g);
      expect(fake.sent.filter((m) => m.t === 'listen').length).toBe(listens);
      expect(await liveTracks(page)).toBe(0);
    });
  }
});

describe('voice: §7.7, audio and transcripts are never stored (D1)', () => {
  const NEEDLE = "I'm allergic to sesame";
  const atRest = (page: Page) => page.evaluate(async () => {
    const out: string[] = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const r of await c.keys()) { out.push(r.url); out.push(await (await c.match(r))!.text().catch(() => '')); }
    }
    for (const info of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((res, rej) => { const q = indexedDB.open(info.name!); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      for (const store of [...db.objectStoreNames]) {
        const all = await new Promise<unknown[]>((res) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); });
        out.push(JSON.stringify(all));
      }
      db.close();
    }
    return out.join('\n');
  });

  it('after the flow (transcript reached), no storage holds the transcript or audio; the positive control (a page script that stores it) is caught', async () => {
    const fake = newVoiceFake();
    const page = await open(fake, { turn: () => ruleTurn('sesame') });
    await page.locator('#pan-button').click();
    await sayIt(page, fake, NEEDLE);
    await page.locator('#pan-panel .heard-card').waitFor(); // the flow reached the transcript
    expect(await atRest(page)).not.toContain(NEEDLE);
    expect(await atRest(page)).not.toMatch(/RIFF|audio\/(wav|webm|ogg)/);
    // Positive control: a script that keeps the transcript must make the check fail.
    await page.evaluate((t) => { localStorage.setItem('leak', t); }, NEEDLE);
    expect(await atRest(page)).toContain(NEEDLE);
  });
});

describe('voice: hands-free cook mode (the VITE_HANDS_FREE build, against the test fixture record)', () => {
  const COOK = '/#/cook/india/kerala/parippu';
  const stepItems = (fake: VoiceFake) => speaks(fake).flatMap((s) => s.items).filter((i) => i.kind === 'step');
  const lineItems = (fake: VoiceFake, trigger: string) => speaks(fake).flatMap((s) => s.items).filter((i) => i.kind === 'line' && i.trigger === trigger);

  async function handsFree(fake: VoiceFake, seed: Partial<PlayerState> = {}) {
    const page = await open(fake, { path: COOK, handsFreeBuild: true, voice: { handsFree: true }, seed: { v: 1, ...seed } as Partial<PlayerState> });
    await page.locator('.cook-progress').waitFor();
    await page.locator('.hands-free-toggle').click();
    await expect.poll(() => fake.sent.some((m) => m.t === 'listen' && m.mode === 'handsFree'), { timeout: 15_000 }).toBe(true);
    return page;
  }

  it('parippu (✅): a spoken "next" → step 2 on screen and { kind: "step", step: 1 } is spoken (P12)', async () => {
    const fake = newVoiceFake({ transcripts: ['next'] });
    const page = await handsFree(fake);
    await expect.poll(() => page.locator('.cook-progress').textContent(), { timeout: 15_000 }).toBe('Step 2 of 7');
    await expect.poll(() => stepItems(fake).length).toBeGreaterThan(0);
    expect(stepItems(fake).at(-1)).toMatchObject({ kind: 'step', slug: 'india/kerala/parippu', step: 1 });
    expect(await page.locator('.listening-pill').count()).toBe(1);
    await expectNoA11yViolations(page, 'cook mode with the Listening pill');
  });

  // The API renders voice.step_on_screen for it (apps/api voice-speak tests); a Pantry Frame's step_on_screen is pinned
  // by cook-voice unit tests (M1), since a frame needs a stocked pantry to cook.
  it('with a 🔁 swap on screen the device still names only the step, with no text (the API decides, Ruling 11)', async () => {
    const fake = newVoiceFake({ transcripts: ['next'] });
    const page = await handsFree(fake, { localRules: [{ id: 'p1', target: { kind: 'ingredient', ids: ['coconut_oil'] }, type: 'avoid', severity: 'preference' }] } as Partial<PlayerState>);
    await expect.poll(() => page.locator('.cook-progress').textContent(), { timeout: 15_000 }).toBe('Step 2 of 7');
    await expect.poll(() => stepItems(fake).length).toBeGreaterThan(0);
    expect(Object.keys(stepItems(fake).at(-1)!).sort()).toEqual(['kind', 'localDate', 'slug', 'step']);
  });
});
