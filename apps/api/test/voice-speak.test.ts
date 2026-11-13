// M7 Step 5, Ruling 15 (D4, B5, Ruling 11): what the Pan says aloud is rendered by the API alone, from server-held data.
// The client names items by id only; every variable passes filterReply again; anything that can't be said safely is
// spoken as voice.check_screen, never dropped. TTS takes only SpeakableText, which only renderSpeak makes.
import { buildRuleCard, MAX_SPEAK_CHARS, speechChunks, SPEAK_VAR_MAX, type LineRef, type ReplyPart, type RuleCard, type SpeakItem } from '@kitchenquest/core';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { loadPanBank } from '../src/mentor/lines.js';
import { createProposal } from '../src/mentor/proposals.js';
import { createRecipeIndexSource, type RecipeIndex } from '../src/recipes/recipe-index.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { recentReplies } from '../src/voice/recent-replies.js';
import { cardReadback, isSpeakable, renderSpeak, stepCleared, type SpeakableText, type SpeakContext } from '../src/voice/speak.js';
import type { VoiceLink } from '../src/voice/upstream.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb } from './helpers/db.js';

const config = testConfig();
const catalog = defaultCatalog();
const bank = loadPanBank();
const NOW = new Date('2026-11-10T12:00:00Z'); // a Tuesday
const TODAY = '2026-11-10';
const MONDAY = '2026-11-09';
const PARIPPU = 'india/kerala/parippu';
const CHECK = bank.lineAt('voice.check_screen', 0, {})!;
const STEP_ON_SCREEN = bank.lineAt('voice.step_on_screen', 0, {})!;

let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let recipes: RecipeIndex;
let seq = 0;

/** A test dish, synced with the canon: ghee and rice only, so a ghee rule makes it 🔁 and nothing else touches it. */
const GHEE_RICE = 'test/voice/ghee-rice';
const GHEE_RICE_COOK = `---
title: Ghee Rice
country: Test
region: Test
credit: A test dish
cook: leela
difficulty: 1
skills: [grains]
servings: 2
license: CC-BY-SA-4.0
status: draft
---
Warm the @ghee{1%tbsp} in a #pot{}.

Add the @rice{200%g} and stir.
`;
let recipeDir = '';

beforeAll(async () => {
  ({ db, close: closeDb } = await testDb());
  recipeDir = mkdtempSync(join(tmpdir(), 'kq-voice-recipes-'));
  cpSync(RECIPES_DIR, recipeDir, { recursive: true });
  mkdirSync(join(recipeDir, 'test/voice'), { recursive: true });
  writeFileSync(join(recipeDir, `${GHEE_RICE}.cook`), GHEE_RICE_COOK);
  await syncCanon(db, recipeDir, catalog.graph, NOW);
  recipes = await createRecipeIndexSource().current(db);
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false });
});
afterAll(async () => {
  await app?.close();
  await closeDb?.();
  rmSync(recipeDir, { recursive: true, force: true });
});

const call = (cookie: string, opts: InjectOptions) => app.inject({ ...opts, cookies: { kq_session: cookie } });
async function player(): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app, mailer, `speak${++seq}@example.com`);
  const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } });
  expect(res.statusCode).toBe(201);
  return { cookie, id: (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id };
}

/** A context with nothing server-held but what a test gives it. */
function ctx(over: Partial<SpeakContext> = {}): SpeakContext {
  return {
    userId: 'u-test',
    bank,
    catalog,
    lastTranscript: () => null,
    card: () => Promise.resolve(null),
    stepOk: () => Promise.resolve(true),
    recipes: new Map(),
    ...over,
  };
}
const said = (t: SpeakableText) => t.chunks.map((c) => c.text).join(' ');

describe('PanBank.lineAt and varsOf (Ruling 15)', () => {
  test('lineAt gives the exact variant, filled; null for an unknown trigger, an index out of range or a missing var. varsOf lists declared and used vars', () => {
    expect(bank.lineAt('voice.check_screen', 0, {})).toBe("It's on the screen; read it there.");
    expect(bank.lineAt('voice.check_screen', 1, {})).toBe("That one's on the screen. Have a look there.");
    expect(bank.lineAt('voice.check_screen', 2, {})).toBeNull();
    expect(bank.lineAt('voice.check_screen', -1, {})).toBeNull();
    expect(bank.lineAt('no.such_trigger', 0, {})).toBeNull();
    expect(bank.lineAt('voice.heard_check', 0, {})).toBeNull();
    expect(bank.lineAt('voice.heard_check', 0, { terms: 'kiwi' })).toBe("I heard kiwi. Tap the card if that's right.");
    expect(bank.varsOf('voice.check_screen')).toEqual([]);
    expect(bank.varsOf('voice.heard_check_spelled')).toEqual(['spelled', 'terms']);
    // greet.morning declares {name} and uses it in some variants only: it takes a var.
    expect(bank.varsOf('greet.morning')).toEqual(['name']);
    expect(bank.varsOf('no.such_trigger')).toEqual([]);
  });
});

describe('renderSpeak', () => {
  test('a line item with vars in its trigger → voice.check_screen; a var-free line renders its exact variant', async () => {
    const t = await renderSpeak([{ kind: 'line', trigger: 'voice.check_screen', index: 1 }], ctx());
    expect(said(t)).toBe("That one's on the screen. Have a look there.");
    // greet.morning variant 0 has no {name}, but the trigger takes one: the client could be holding a filled copy.
    expect(said(await renderSpeak([{ kind: 'line', trigger: 'greet.morning', index: 0 }], ctx()))).toBe(CHECK);
    expect(said(await renderSpeak([{ kind: 'line', trigger: 'voice.heard_check', index: 0 }], ctx()))).toBe(CHECK);
    // an unknown trigger or an index out of range: check_screen, never silence
    expect(said(await renderSpeak([{ kind: 'line', trigger: 'no.such_trigger', index: 0 }], ctx()))).toBe(CHECK);
    expect(said(await renderSpeak([{ kind: 'line', trigger: 'voice.check_screen', index: 9 }], ctx()))).toBe(CHECK);
  });

  test("a reply item resolves its LineRef from recentReplies with the server's vars; an unknown replyId → voice.check_screen", async () => {
    const parts: ReplyPart[] = [
      { kind: 'text', text: 'model words are never spoken' },
      { kind: 'line', line: { trigger: 'voice.heard_check', vars: { terms: 'kiwi' } } },
    ];
    recentReplies.put('u-reply', 'r-1', parts, NOW.getTime());
    const c = ctx({ userId: 'u-reply', nowMs: NOW.getTime() });
    expect(said(await renderSpeak([{ kind: 'reply', replyId: 'r-1', part: 1 }], c))).toBe("I heard kiwi. Tap the card if that's right.");
    // the model's text part, an unknown reply, a part out of range, another user's reply: check_screen
    for (const item of [
      { kind: 'reply', replyId: 'r-1', part: 0 },
      { kind: 'reply', replyId: 'r-2', part: 1 },
      { kind: 'reply', replyId: 'r-1', part: 7 },
    ] satisfies SpeakItem[]) {
      expect(said(await renderSpeak([item], c)), JSON.stringify(item)).toBe(CHECK);
    }
    expect(said(await renderSpeak([{ kind: 'reply', replyId: 'r-1', part: 1 }], ctx({ userId: 'u-other', nowMs: NOW.getTime() })))).toBe(CHECK);
    // past RECENT_REPLY_TTL_MS the reply is gone
    expect(said(await renderSpeak([{ kind: 'reply', replyId: 'r-1', part: 1 }], { ...c, nowMs: NOW.getTime() + 600_000 }))).toBe(CHECK);
    recentReplies.clear('u-reply');
  });

  test("a card item reads the sealed proposal's read-back for that user only; another user's proposalId → voice.check_screen", async () => {
    const a = await player();
    const b = await player();
    const built = buildRuleCard({ term: 'peanut', severity: 'anaphylactic' }, catalog.graph, catalog.ruleTerms);
    if (!built.ok) throw new Error('no peanut card');
    const card: RuleCard = built.card;
    const id = (await db.transaction((tx) => createProposal(tx, config.keyring, { userId: a.id, conversationId: null, turnSeq: null, card }, NOW))).proposalId;
    const source = (userId: string) => (proposalId: string) => cardReadback(db, config.keyring, userId, proposalId);
    const expected = card.readback.map((r) => bank.firstLine(r)).join(' ');
    const t = await renderSpeak([{ kind: 'card', proposalId: id }], ctx({ userId: a.id, card: source(a.id) }));
    expect(said(t).replace(/\s+/g, ' ')).toContain('P. E. A. N. U. T.');
    expect(t.chunks.length).toBeGreaterThan(0);
    expect(t.chunks.every((c) => c.cache === false)).toBe(true);
    expect(expected).toContain('P-E-A-N-U-T');
    expect(await cardReadback(db, config.keyring, b.id, id)).toBeNull();
    expect(said(await renderSpeak([{ kind: 'card', proposalId: id }], ctx({ userId: b.id, card: source(b.id) })))).toBe(CHECK);
    expect(said(await renderSpeak([{ kind: 'card', proposalId: 'not-a-uuid' }], ctx({ userId: a.id, card: source(a.id) })))).toBe(CHECK);
  });

  test('a heard item for "allergic to sesame, peanut and shellfish" speaks the spelling from code, "S. E. S. A. M. E., P. E. A. N. U. T., …", nothing dropped', async () => {
    const transcripts = new Map([[3, 'allergic to sesame, peanut and shellfish']]);
    const c = ctx({ lastTranscript: (id) => transcripts.get(id) ?? null });
    const t = await renderSpeak([{ kind: 'heard', utteranceId: 3 }], c);
    expect(said(t)).toBe("I heard sesame, peanut and shellfish: S. E. S. A. M. E., P. E. A. N. U. T., S. H. E. L. L. F. I. S. H. Tap the card if that's right.");
    // its chunks carry the player's words: never cached
    expect(t.chunks.every((ch) => !ch.cache)).toBe(true);
    // no health wording: the words, not the spelling (Ruling 4)
    transcripts.set(4, 'rice and peanut for tea');
    expect(said(await renderSpeak([{ kind: 'heard', utteranceId: 4 }], c))).toBe("I heard rice and peanut. Tap the card if that's right.");
    // a transcript this socket doesn't hold, or one naming nothing: check_screen
    transcripts.set(5, 'what time is it');
    expect(said(await renderSpeak([{ kind: 'heard', utteranceId: 9 }], c))).toBe(CHECK);
    expect(said(await renderSpeak([{ kind: 'heard', utteranceId: 5 }], c))).toBe(CHECK);
  });

  test('carry 7: a heard check over MAX_TEXT (HeardCheck.tooLong) is refused, never cut: voice.too_long asks the player to type', async () => {
    const long = `allergic to sesame ${'and so on '.repeat(400)}`;
    const t = await renderSpeak([{ kind: 'heard', utteranceId: 1 }], ctx({ lastTranscript: () => long }));
    expect(said(t)).toBe(bank.lineAt('voice.too_long', 0, {}));
    expect(said(t)).not.toMatch(/S\. E\. S/);
  });

  test("a var over SPEAK_VAR_MAX (a 90-char dish name) → voice.check_screen, never silently dropped; same for a var failing filterReply (\"it's safe\")", async () => {
    const dish = 'a very long dish name that goes on and on past the limit of what the pan will say out loud!'.slice(0, 90);
    expect(dish.length).toBe(90);
    expect(dish.length).toBeGreaterThan(SPEAK_VAR_MAX);
    const refs: Record<string, LineRef> = {
      long: { trigger: 'voice.heard_check', vars: { terms: dish } },
      safe: { trigger: 'voice.heard_check', vars: { terms: "it's safe" } },
      ok: { trigger: 'voice.heard_check', vars: { terms: 'kiwi' } },
    };
    recentReplies.put('u-vars', 'r', [refs.long, refs.safe, refs.ok].map((line): ReplyPart => ({ kind: 'line', line })), NOW.getTime());
    const c = ctx({ userId: 'u-vars', nowMs: NOW.getTime() });
    expect(said(await renderSpeak([{ kind: 'reply', replyId: 'r', part: 0 }], c))).toBe(CHECK);
    expect(said(await renderSpeak([{ kind: 'reply', replyId: 'r', part: 1 }], c))).toBe(CHECK);
    // only THAT item: the others around it are said; the fallback stands where the item was
    const mixed = await renderSpeak(
      [
        { kind: 'reply', replyId: 'r', part: 2 },
        { kind: 'reply', replyId: 'r', part: 0 },
        { kind: 'line', trigger: 'voice.step_on_screen', index: 0 },
      ],
      c,
    );
    expect(said(mixed)).toBe(`I heard kiwi. Tap the card if that's right. ${CHECK} ${STEP_ON_SCREEN}`);
    recentReplies.clear('u-vars');
  });

  test('a total over MAX_SPEAK_CHARS: the items before the cut are spoken, then voice.check_screen once', async () => {
    const card = 'voice.too_long';
    const items: SpeakItem[] = Array.from({ length: 8 }, () => ({ kind: 'line', trigger: card, index: 0 }));
    const one = bank.lineAt(card, 0, {})!;
    const t = await renderSpeak(items, ctx());
    const total = t.chunks.reduce((n, ch) => n + ch.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_SPEAK_CHARS);
    const text = said(t);
    const fit = text.split(one).length - 1;
    expect(fit).toBeGreaterThan(0);
    expect(fit).toBeLessThan(8);
    expect(text.endsWith(CHECK)).toBe(true);
    expect(text.split(CHECK).length - 1).toBe(1);
    // items after a fallback that are fallbacks too are said once
    const fallbacks = await renderSpeak(Array.from({ length: 3 }, (): SpeakItem => ({ kind: 'card', proposalId: 'x' })), ctx());
    expect(said(fallbacks)).toBe(CHECK);
  });

  test('a step is spoken only when ✅ with no swap; with a 🔁 or a stall swap → voice.step_on_screen', async () => {
    const step0 = 'Rinse split moong dal in a bowl two or three times, until the water runs mostly clear.';
    const item: SpeakItem = { kind: 'step', slug: PARIPPU, step: 0, localDate: TODAY };
    const cleared = (userId: string) => (slug: string, _step: number, date: string) => stepCleared(db, { keyring: config.keyring, catalog, recipes }, userId, slug, date, NOW);
    const p = await player();
    expect(said(await renderSpeak([item], ctx({ userId: p.id, recipes, stepOk: cleared(p.id) })))).toBe(step0);
    // an out-of-range step or an unknown dish: check_screen; a date that is not the player's today: on the screen
    expect(said(await renderSpeak([{ ...item, step: 40 }], ctx({ userId: p.id, recipes, stepOk: cleared(p.id) })))).toBe(CHECK);
    expect(said(await renderSpeak([{ ...item, slug: 'nowhere/dish' }], ctx({ userId: p.id, recipes, stepOk: cleared(p.id) })))).toBe(CHECK);
    expect(await stepCleared(db, { keyring: config.keyring, catalog, recipes }, p.id, PARIPPU, '2026-11-20', NOW)).toBe(false);

    // 🔁: a ghee rule swaps the ghee for oil on a dish that is otherwise ✅ (a test dish, synced as canon), so the step's
    // words are not what the player cooks.
    const swap = await player();
    const rule = await call(swap.cookie, { method: 'POST', url: '/rules', payload: { rule: { target: { kind: 'ingredient', ids: ['ghee'] }, type: 'avoid', severity: 'preference' }, confirmed: true } });
    expect(rule.statusCode, rule.body).toBe(201);
    const gheeItem: SpeakItem = { kind: 'step', slug: GHEE_RICE, step: 0, localDate: TODAY };
    const detail = await call(swap.cookie, { method: 'GET', url: `/recipes/${GHEE_RICE}?date=${TODAY}` });
    expect(detail.json<{ check: { status: string } }>().check.status).toBe('swap');
    expect(said(await renderSpeak([gheeItem], ctx({ userId: p.id, recipes, stepOk: cleared(p.id) })))).toBe('Warm the ghee in a pot.');
    expect(said(await renderSpeak([gheeItem], ctx({ userId: swap.id, recipes, stepOk: cleared(swap.id) })))).toBe(STEP_ON_SCREEN);

    // a stall swap at this week's market (moong dal → red lentils)
    const stall = await player();
    const plan = { weekStart: MONDAY, items: [{ day: 0, kind: 'dish', slug: PARIPPU, servings: 2 }], hard: false, slot: 'unanswered' };
    expect((await call(stall.cookie, { method: 'PUT', url: `/plans/${MONDAY}`, payload: { plan, confirmed: true } })).statusCode).toBe(200);
    const run = (await call(stall.cookie, { method: 'POST', url: '/market-runs', payload: { weekStart: MONDAY } })).json<{ id: string }>();
    expect(said(await renderSpeak([item], ctx({ userId: stall.id, recipes, stepOk: cleared(stall.id) })))).toBe(step0);
    const taken = await call(stall.cookie, { method: 'POST', url: `/market-runs/${run.id}/stock`, payload: { key: 'moong_dal', action: 'take', toId: 'red_lentil' } });
    expect(taken.statusCode, taken.body).toBe(200);
    expect(said(await renderSpeak([item], ctx({ userId: stall.id, recipes, stepOk: cleared(stall.id) })))).toBe(STEP_ON_SCREEN);
  });

  test('fix round 1, m8: a variable is spoken as the output filter screened it, never raw (an invisible character is gone)', async () => {
    recentReplies.put('u-screen', 'r', [{ kind: 'line', line: { trigger: 'voice.heard_check', vars: { terms: 'pea\u200bnut' } } }], NOW.getTime());
    const t = await renderSpeak([{ kind: 'reply', replyId: 'r', part: 0 }], ctx({ userId: 'u-screen', nowMs: NOW.getTime() }));
    expect(said(t)).toBe("I heard peanut. Tap the card if that's right.");
    expect(said(t)).not.toContain('\u200b');
    recentReplies.clear('u-screen');
  });

  test('fix round 1, m6: voice.step_on_screen is neutral: it is said for ⛔, ❓ and margin notes too, so it never claims the step has swaps', () => {
    for (let i = 0; bank.lineAt('voice.step_on_screen', i, {}) !== null; i++) {
      expect(bank.lineAt('voice.step_on_screen', i, {})).not.toMatch(/swap|changed|safe/i);
    }
  });

  test('cache is per chunk: var-free chunks true, var-filled chunks false', async () => {
    recentReplies.put('u-cache', 'r', [{ kind: 'line', line: { trigger: 'voice.heard_check', vars: { terms: 'kiwi' } } }], NOW.getTime());
    const t = await renderSpeak(
      [
        { kind: 'line', trigger: 'voice.check_screen', index: 1 },
        { kind: 'reply', replyId: 'r', part: 0 },
        { kind: 'line', trigger: 'voice.step_on_screen', index: 0 },
      ],
      ctx({ userId: 'u-cache', nowMs: NOW.getTime() }),
    );
    expect(t.chunks.map((c) => [c.text, c.cache])).toEqual([
      ["That one's on the screen.", true],
      ['Have a look there.', true],
      ['I heard kiwi.', false],
      ["Tap the card if that's right.", false],
      ...speechChunks(STEP_ON_SCREEN).map((text) => [text, true]),
    ]);
    recentReplies.clear('u-cache');
  });

  test('VoiceLink.speak accepts only SpeakableText: passing a plain object is a compile error (// @ts-expect-error) (D4)', async () => {
    const real = await renderSpeak([{ kind: 'line', trigger: 'voice.check_screen', index: 0 }], ctx());
    expect(isSpeakable(real)).toBe(true);
    const plain = { chunks: [{ text: 'anything the client likes', cache: false }] };
    expect(isSpeakable(plain)).toBe(false);
    // A copy of a real one is not one either: only renderSpeak's own object is.
    expect(isSpeakable({ ...real })).toBe(false);
    expect(Object.isFrozen(real) && Object.isFrozen(real.chunks)).toBe(true);
    const typed = (l: VoiceLink) => {
      // @ts-expect-error: a plain object is not SpeakableText (D4)
      void l.speak(1, 'pan', plain, () => {});
    };
    void typed;
  });
});
