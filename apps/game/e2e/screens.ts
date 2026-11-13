import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright';
import { parse } from 'yaml';
import { VOICE_ALLOWLIST } from '../src/content/voice-allowlist';
import { STORE_KEY, type PlayerState } from '../src/state/store';
import { openApp, type OpenedApp } from './helpers';

/**
 * Every screen the player can meet, for the Step 12 sweeps (a11y, never-rules). Add a screen here and every
 * sweep checks it. `open` runs after the first load and leaves the screen showing; `primary` is the screen's
 * main action, which must stay visible at 200% text.
 */
export interface ScreenCase {
  label: string;
  path: string;
  open?: (page: Page) => Promise<void>;
  seed?: Partial<PlayerState>;
  /** Runs before the first navigation: mock `/api/**` here (signed-in screens). */
  beforeGoto?: (page: Page) => Promise<unknown>;
  primary: (page: Page) => Locator;
  /** A mentor surface (panel, cards, consent cards, rules screen, Settings): its written content is also held to MENTOR_BANNED. */
  mentor?: true;
  /** An M5 weekly-loop screen: held to LOOP_NEVER in chrome and content alike (Step 12). */
  loop?: true;
  /** A plan, market or rescue screen: no countdown word either (audit M-4, never rule 5). */
  countdown?: true;
  /** Runs in the page before the app (e.g. a fixed Math.random, so the Pan says one chosen variant of a line). */
  initScript?: string;
  /**
   * An M6 market screen (Step 11): held to LOOP_NEVER and M6_NEVER in chrome and content (the allowlist by location,
   * content only), and to the structure rules: no timer, no <progress>, no <meter>, and a footnote under every chalkboard.
   */
  market?: true;
  /** Cook mode (M3): its own cooking timers and "step n of m" are the recipe's, not a minigame's; exempt from those two rules. */
  cookMode?: true;
}

// ---- Never rules: the banned-word lists. M4 extends these; keep them here, in one place. ----

/** Words no UI chrome may say: spec §16 never rules 1–9, §19, voice.md §0.2–0.3, and product claims. */
export const CHROME_BANNED_WORDS = [
  'buy', 'purchase', 'upgrade', 'subscribe', 'subscription', 'premium', 'guild', 'pro plan', 'price',
  'streak', 'in a row', 'exotic', 'unlock(ed)?', 'loot(ed)?', 'acquired', 'discovered',
  // Never rule 9: no referral schemes or leaderboards. voice.md §0.2–0.3: never "ethnic food"; recipes are never collected.
  'leaderboards?', 'refer', 'referrals?', 'ethnic', 'collected',
  // Compliance: never claim HIPAA compliance or medical-grade anything.
  'HIPAA', 'medical-grade',
];
/** Words written content (inside `[data-content]`) may not say: the Pan and cooks never sell, nothing counts streaks. */
export const CONTENT_BANNED_WORDS = [
  'upgrade', 'subscribe', 'subscription', 'premium', 'guild', 'pro plan', 'streak',
  // Content may "refer you to a clinician" (voice.md §0.9), but never runs a referral scheme.
  'leaderboards?', 'referrals?', 'ethnic', 'collected',
  'HIPAA', 'medical-grade',
];
/** A banned-word list as one case-insensitive pattern; a price ("$5", "$ 5") is always banned. */
export const bannedPattern = (words: readonly string[]): RegExp => new RegExp(`\\b(${words.join('|')})\\b|\\$\\s?\\d`, 'i');
export const CHROME_BANNED = bannedPattern(CHROME_BANNED_WORDS);
export const CONTENT_BANNED = bannedPattern(CONTENT_BANNED_WORDS);
/**
 * M4 Step 12: what the Pan's lines, its cards and consent cards, the rules screen and Settings may never say:
 * the content list, the sells words, and voice.md §7's banned words (the Bureau's own jokes quote some of
 * these in negation elsewhere, so only the mentor surfaces get the full list).
 */
export const MENTOR_BANNED_WORDS = [
  ...CONTENT_BANNED_WORDS, 'subscri\\w*', 'membership', 'paid plan',
  'exotic', 'weird', 'strange', 'discover(ed)?', 'unlock(ed)?', 'loot(ed)?', 'acquired?',
  'guilt-free', 'cheat day', 'junk', 'clean eating', 'sinful', 'skipped a meal', 'good job', 'streak lost', 'authentic', 'broken english',
  'collect', 'you missed \\w+ days', 'mijo', 'mija',
];
export const MENTOR_BANNED = bannedPattern(MENTOR_BANNED_WORDS);

/**
 * M5 Step 12: the never rules for every weekly-loop screen, as strict in UI chrome as in written content (Ruling 24,
 * C29). Inside `[data-content]` only, an element whose whole text is exactly a VOICE_ALLOWLIST line passes; UI
 * chrome has no allowlist. No pattern is weakened for a line: the copy is fixed in content/ instead.
 */
export const LOOP_NEVER: Readonly<Record<string, RegExp>> = {
  /** Never rules 3, 5 and 7: nothing sells, no price, no Guild. */
  sells: /\b(guild|upgrade|subscri\w*|premium)\b|\$\s?\d/i,
  /** voice.md §7's banned words. */
  voice: /\b(exotic|ethnic|weird|strange|guilt-free|cheat day|junk|clean eating|sinful|skipped a meal|good job|streak lost|authentic|broken english|mijo|mija)\b|you missed \w+ days/i,
  /** §3.3 and voice §0.3: recipes are taught and gifted, never unlocked, looted, collected, acquired or discovered. */
  loot: /\b(unlock\w*|loot\w*|collect\w*|acquir\w*|discover\w*)\b/i,
  /** §2.3: no streaks, no runs of days, nothing "missed". */
  streak: /\bstreaks?\b|\bin a row\b|\bmissed\b/i,
  /** No completion meter across cultures: no "n/9", "n of 9" or percentage. */
  score: /\b\d+\s*(\/|of)\s*9\b|\d\s*%|\bper ?cent\b/i,
  /** Compliance: never claim HIPAA or medical-grade anything. */
  compliance: /HIPAA|medical-grade/i,
};
/** Audit M-4, never rule 5: no countdown on the rescue, market or plan screens. */
export const COUNTDOWN = /\b(only|left|hurry|expires?|expiring)\b/i;
/**
 * M6 Step 11: the milestone's no-pressure, prices and selling rules on every market screen (step-11.md, verbatim where
 * it gives the pattern). A keeper "offer" is the keeper selling their own goods in the app; shopping advice for the
 * player's own shop ("buy whole, buy small", "buy from a busy shop") is the skill §3.5 teaches, so the bare word is
 * not matched (C29). No pattern is weakened for a line: copy is fixed in content/ instead (M5 Ruling 24).
 */
export const M6_NEVER: Readonly<Record<string, RegExp>> = {
  /** Never rules 3, 5, 7 (step-11.md's sells pattern). */
  sells: /\b(guild|upgrade|subscri\w*|premium)\b|\$\s?\d/i,
  /** Ruling 5: chalkboard numbers are in no currency; nothing anywhere names one. */
  currency: /[$£€¥₹₩₦₱¢]/,
  /** Ruling 6: nothing is smuggled. */
  smuggled: /\bsmuggl\w*/i,
  /** No score tally: no "x/y", no "x of y". */
  tally: /\b\d+\s*\/\s*\d+\b|\b\d+\s+of\s+\d+\b/i,
  /** No countdown (step-11.md). */
  countdown: /\b\d+\s*(s|sec|seconds|min)\s*(left|remaining)\b/i,
  /** In-app, nothing is for sale: a keeper never offers their goods. */
  offer: /\bbuy (?:it |them |one |some )?(?:from me|here|now|today)\b|\bon sale\b|\bspecial price\b|\badd (?:it |them )?to (?:your |the )?(?:basket|cart)\b|\bfor sale\b|\bcheckout\b|\bbuy now\b|\bdiscount\w*\b|\bdeal of the day\b/i,
};
/**
 * The in-page allowlist, matched by location as well as text (Step 12 fix round 1, Minor 1). Every written line in
 * `content/` is a source with its file and key path (the paths VOICE_ALLOWLIST uses). A `[data-content]` element is
 * excused only when every source that could have rendered its text is an allowlisted location holding exactly that
 * line, so the same words shipped anywhere else are scanned. A `{var}` matches one phrase (no sentence end), and
 * the words the Pan filled in are returned so the caller still scans them: an entry excuses its own words only.
 */
interface LineSource { file: string; where: string; text: string; re: RegExp }
const CONTENT_ROOT = new URL('../../../content/', import.meta.url);
function stringsIn(node: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof node === 'string') out.push([path, node]);
  else if (Array.isArray(node)) node.forEach((n, i) => stringsIn(n, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) stringsIn(v, path === '' ? k : `${path}.${k}`, out);
  return out;
}
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A shipped line as a whole-text matcher; each `{var}` is one capture that holds no sentence end. */
export const lineMatcher = (line: string): RegExp => new RegExp(`^${line.split(/\{\w+\}/).map(escapeRe).join('([^.!?]+?)')}$`);
function sourcesOf(rel: string): LineSource[] {
  const y = parse(readFileSync(fileURLToPath(new URL(rel, CONTENT_ROOT)), 'utf8')) as Record<string, unknown>;
  const pairs: [string, string][] = rel === 'dialogue/pan.yaml'
    ? Object.entries(y.triggers as Record<string, { lines?: string[] }>).flatMap(([id, t]) => (t.lines ?? []).map((l, i): [string, string] => [`triggers.${id}[${i}]`, l]))
    : stringsIn(y, '');
  return pairs.map(([where, text]) => ({ file: `content/${rel}`, where, text, re: lineMatcher(text) }));
}
const COOK_FILES = ['leela', 'marisol', 'haruka'].map((c) => `cooks/${c}.yaml`);
/** M6 Step 5: the market stalls ship (lazily) and are allowlisted by the same file and key path. */
const STALL_FILES = ['wen', 'bram', 'okafor-sato', 'spice'].map((s) => `market/${s}.yaml`);
export const LINE_SOURCES: readonly LineSource[] = ['dialogue/pan.yaml', 'bureau/forms.yaml', ...COOK_FILES, ...STALL_FILES].flatMap(sourcesOf);
const ALLOWED_AT = new Set(VOICE_ALLOWLIST.map((a) => `${a.file}\0${a.where}\0${a.line}`));
/** The filled-in words when `whole` is an allowlisted line at its own location (and at no other), else null. */
export function allowlistedAt(whole: string): string[] | null {
  const from = LINE_SOURCES.filter((src) => src.re.test(whole));
  if (from.length === 0 || !from.every((src) => ALLOWED_AT.has(`${src.file}\0${src.where}\0${src.text}`))) return null;
  return from.flatMap((src) => src.re.exec(whole)!.slice(1));
}

// ---- Screens ----

const yaml = <T>(rel: string): T => parse(readFileSync(fileURLToPath(new URL(`../../../content/${rel}`, import.meta.url)), 'utf8')) as T;
const leelaIntro = yaml<{ intro: string[] }>('cooks/leela.yaml').intro;
export const PARIPPU_TITLE = /^title: (.+)$/m.exec(readFileSync(fileURLToPath(new URL('../../../recipes/india/kerala/parippu.cook', import.meta.url)), 'utf8'))![1];
export const LEELA_PIN = 'Visit Ammachi Leela — Kochi, Kerala, India';
const PARIPPU = 'india/kerala/parippu';

const pad = (n: number) => String(n).padStart(2, '0');
const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** A player who has cooked tempering twice, long ago: it shows Rusty on the knife roll. */
export const RUSTY_SEED: Partial<PlayerState> = {
  firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
  toolkit: { techniques: { tempering: { tier: 'yours', firstAt: daysAgo(300), lastUsedAt: daysAgo(200), recipes: [PARIPPU, 'mexico/oaxaca/frijoles'] } } },
};
/** This plan week's Monday (no market day set) and a plan with parippu on its Sunday (M5 Step 10). */
const monday = (() => { const d = new Date(); return daysAgo((d.getDay() + 6) % 7); })();
export const WEEK_SEED: Partial<PlayerState> = {
  ...{ intake: { step: 'done' as const }, aiDisclosureSeen: true },
  localWeek: { plans: [{ weekStart: monday, items: [{ day: 6, kind: 'dish', slug: PARIPPU, servings: 3 }], hard: false, slot: 'unanswered' }], runs: [] },
};
const coconutSevere = { id: 'r1', target: { kind: 'ingredient' as const, ids: ['coconut'] }, type: 'avoid' as const, severity: 'anaphylactic' as const };
const settings = (familyTable: boolean) => ({ showCalories: false, reducedMotion: 'system' as const, familyTable, iosNoteDismissed: false, aiMentor: true, rescueNudges: true, voice: { on: false, readAloud: true, handsFree: false } });
const h1 = (page: Page, text: string | RegExp) => page.locator('h1', { hasText: text }).first().waitFor();
const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name });
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
/** Done with Form 1-A and the AI disclosure (M4 Step 11), so a screen opens without the intake. */
const PAN_READY: Partial<PlayerState> = { intake: { step: 'done' }, aiDisclosureSeen: true };
const NOTICES = { health_data: { version: 'v3', text: 'We keep your allergies and diet rules so dishes can be checked.' }, ai_health: { version: 'v1', text: 'The AI may see your rules and meals.' } };
/** Signed in as cook@example.com with no rules and no consents. */
async function signedInApi(page: Page): Promise<void> {
  await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
  await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
  await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, { consents: [], needsReconsent: [], notices: NOTICES })));
}
const BOTH_CONSENTS = {
  consents: ['health_data', 'ai_health'].map((purpose) => ({ purpose, noticeVersion: purpose === 'health_data' ? 'v3' : 'v1', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true })),
  needsReconsent: [], notices: NOTICES,
};
const line = (trigger: string, vars: Record<string, string> = {}) => ({ kind: 'line', line: { trigger, vars } });
const inHalfAnHour = () => new Date(Date.now() + 30 * 60_000).toISOString();
const SESAME_CARD = {
  kind: 'rule', rule: { target: { kind: 'ingredient', ids: ['sesame'] }, type: 'avoid', severity: 'allergy' }, severe: true, severityUnclear: false, form: 'rule_allergen',
  display: { ingredient: 'sesame', spelled: 'S-E-S-A-M-E', severity: 'an allergy', covers: 'sesame' },
  readback: [{ trigger: 'rule.readback', vars: { ingredient: 'sesame', spelled: 'S-E-S-A-M-E', severity: 'an allergy', covers: 'sesame' } }],
};
const TOAST_CARD = {
  kind: 'meal', meal: { eatenOn: '2026-11-10', slot: 'breakfast', item: { kind: 'free', description: 'toast' } }, summary: 'toast, breakfast', estimate: true,
  readback: [{ trigger: 'log.confirm_readback', vars: { summary: 'toast, breakfast' } }],
};
const MARKET_CARD = {
  kind: 'profile', patch: { marketDays: [6] }, summary: 'market day Saturday', readback: [{ trigger: 'profile.readback', vars: { summary: 'market day Saturday' } }],
};
const PANTRY_CARD = {
  kind: 'pantry', add: [{ name: 'lentils', ingredientId: null }], remove: [], removeIds: [], summary: 'add lentils', readback: [{ trigger: 'pantry.readback', vars: { summary: 'add lentils' } }],
};
/**
 * Signed in with both consents and the AI on; the server's turn answers with a card of every kind and the
 * M4 lines a turn can carry (R9: lines and cards only), so the sweeps read all of them at once.
 */
async function serverCardsApi(page: Page): Promise<void> {
  await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
  await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
  await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, BOTH_CONSENTS)));
  const cards = [SESAME_CARD, TOAST_CARD, MARKET_CARD, PANTRY_CARD];
  await page.route((u) => u.pathname === '/api/mentor/turn', (r) => r.fulfill(json(200, {
    conversationId: 'c1', route: 'ai', notice: null, toolTurn: true, actions: [],
    parts: [
      ...cards.flatMap((c) => c.readback.map((l) => ({ kind: 'line', line: l }))),
      line('rule.ask_what_else', { term: 'peanut' }), line('rule.exclusion_not_kept', { term: 'tree nut' }),
      line('pantry.not_found', { items: 'milk' }), line('write.not_done'), line('mentor.check_card'),
    ],
    cards: cards.map((card, i) => ({ proposalId: `P${i + 1}`, expiresAt: inHalfAnHour(), card })),
  })));
}
/** Signed in, AI on, the daily allowance used up: the server says scripted + rate_limited. */
async function cappedApi(page: Page): Promise<void> {
  await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
  await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
  await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, BOTH_CONSENTS)));
  await page.route((u) => u.pathname === '/api/mentor/turn', (r) => r.fulfill(json(200, {
    conversationId: null, route: 'scripted', parts: [], cards: [], actions: [], notice: 'rate_limited', toolTurn: false,
  })));
}
const accountLoaded = (p: Page) => p.waitForFunction(() => Boolean((JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as { account?: unknown }).account));
async function say(p: Page, text: string, bubbles: number): Promise<void> {
  await accountLoaded(p);
  await p.locator('#pan-button').click();
  await p.locator('#pan-text').fill(text);
  await p.keyboard.press('Enter');
  await p.waitForFunction((n) => document.querySelectorAll('#pan-panel .bubble.pan').length >= n, bubbles);
}
const ageRequired = (page: Page) => page.route('**/api/auth/verify', (r) => r.fulfill(json(400, { error: { code: 'bad_request', message: 'x', details: { code: 'age_confirmation_required' } } })));
async function openAgeScreen(page: Page): Promise<void> {
  await page.locator('#verify').click();
  await page.locator('#birth-year').waitFor();
}
/** The rules screen's form fallback, filled in up to the 27-B card. */
async function openRuleCard(page: Page): Promise<void> {
  await button(page, 'Add a rule').click();
  await page.locator('#rule-search').fill('sesa');
  await page.locator('.rule-form-option', { hasText: 'sesame' }).first().click();
  await button(page, 'Fill in Form 27-B').click();
  await page.locator('.rules-card .pan-card').waitFor();
}


async function openPermit(page: Page): Promise<void> {
  await button(page, LEELA_PIN).click();
  await page.getByRole('dialog', { name: 'Travel Permit' }).waitFor();
}
/** Play Leela's intro to the end. */
async function finishIntro(page: Page): Promise<void> {
  for (const line of leelaIntro) {
    await page.locator('.dialogue .dialogue-text .typed-full').filter({ hasText: line }).waitFor();
    await page.locator('.dialogue .dialogue-next').click();
  }
  // M5 Step 9: Leela's quest runs after the intro; its lines, then "Not yet" at the errand pauses it on the action bar.
  for (let i = 0; i < 60; i++) {
    if (await page.locator('.quest-panel').count()) { await page.locator('.quest-panel').getByRole('button', { name: 'Not yet' }).click(); continue; }
    if (await page.locator('.dialogue .dialogue-next').count()) { await page.locator('.dialogue .dialogue-next').click(); continue; }
    // M6 Step 10: the errand may wait a moment on the market (its stall question): the bar is back only once enabled.
    if (await button(page, 'Carry on with the quest').count() && await button(page, 'Carry on with the quest').isEnabled()) break;
    await page.waitForTimeout(50);
  }
  await button(page, 'See the recipe: Parippu').waitFor();
}

/** The intro, then the quest's talk lines: the errand's panel is up. */
async function toQuestPanel(page: Page): Promise<void> {
  for (let i = 0; i < 60 && (await page.locator('.quest-panel').count()) === 0; i++) {
    if (await page.locator('.dialogue .dialogue-next').count()) await page.locator('.dialogue .dialogue-next').click();
    else await page.waitForTimeout(50);
  }
  await page.locator('.quest-panel').waitFor();
}
const cookReady = (page: Page) => page.locator('.cook-progress').waitFor();

// ---- M5 Step 12: every weekly-loop screen, in standard and in Family Table mode (C31) ----

const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const MARISOL_PIN = 'Visit Doña Marisol — Oaxaca, Mexico';
const ft = { settings: settings(true) };
/** Frijoles de olla cooked a week ago (C27): legumes, heat-control and patience Tried, so tempering is on offer. */
const PRIOR_COOK = { id: '7a1c2b7e-0d3a-4c55-9b8e-1a2b3c4d5e6f', kind: 'cooked' as const, at: daysAgo(7), recipe: FRIJOLES, planned: false };
const PRIOR: Partial<PlayerState> = {
  ...PAN_READY, firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
  progress: {
    events: [PRIOR_COOK],
    grants: [{ id: `${PRIOR_COOK.id}#0`, eventId: PRIOR_COOK.id, isoDay: PRIOR_COOK.at, kind: 'xp', amount: 30, reason: 'cook' }],
    base: null, pendingUpload: [PRIOR_COOK.id],
  },
};
/** A Use-It-Up offer: spinach bought two days ago, with cooked rice and oil told to the Pan (Step 10's rescue). */
export const RESCUE_SEED: Partial<PlayerState> = {
  ...PAN_READY,
  localPantry: [
    { id: 'sp', name: 'spinach', ingredientId: 'spinach', addedOn: daysAgo(2), source: 'market' },
    { id: 'rice', name: 'cooked rice', ingredientId: 'cooked_rice' },
    { id: 'oil', name: 'sunflower oil', ingredientId: 'neutral_oil' },
  ],
};
const shallotSevere = { id: 'r2', target: { kind: 'ingredient' as const, ids: ['shallot'] }, type: 'avoid' as const, severity: 'anaphylactic' as const };
const peanutSevere = { id: 'r3', target: { kind: 'ingredient' as const, ids: ['peanut'] }, type: 'avoid' as const, severity: 'anaphylactic' as const };
const VIEW_COOKED = {
  xp: 70, level: 1, stamps: 1, trust: { leela: 1 }, toolkit: { techniques: {} }, questsDone: ['leela-tempering'], questSteps: { 'leela-tempering': 6 }, questStartedOn: {},
  cookedOn: { [PARIPPU]: [daysAgo(3)] }, framesCookedOn: {},
};
const BOOK_NOTES = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', recipe: PARIPPU, ops: [{ op: 'add', name: 'lime' }], text: 'more garlic next time', at: daysAgo(3) }];
const HEALTH_GRANTED = {
  consents: [{ purpose: 'health_data', noticeVersion: 'v3', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true }],
  needsReconsent: [], notices: NOTICES,
};
/** Signed in with health_data: the book, the progress and the after-cook routes answer. */
export async function loopApi(page: Page): Promise<void> {
  await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
  await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
  await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, HEALTH_GRANTED)));
  await page.route((u) => u.pathname === '/api/pantry', (r) => r.fulfill(json(200, { items: [] })));
  await page.route((u) => u.pathname === '/api/progress', (r) => r.fulfill(json(200, { view: VIEW_COOKED })));
  await page.route((u) => u.pathname === '/api/progress/events', (r) => {
    const body = r.request().postDataJSON() as { events: { id: string }[] };
    return r.fulfill(json(200, { accepted: body.events.map((e) => ({ clientId: e.id, grants: [] })), duplicate: [], rejected: [], warnings: [], view: VIEW_COOKED }));
  });
  await page.route((u) => u.pathname === '/api/notes', (r) => (r.request().method() === 'GET'
    ? r.fulfill(json(200, { notes: BOOK_NOTES }))
    : r.fulfill(json(201, { note: { ...(r.request().postDataJSON() as { note: object }).note, id: 'bbbbbbbb-0000-4000-8000-000000000001', check: { status: 'ok', findings: [], severe: false, disclaimer: null } } }))));
  await page.route((u) => u.pathname.startsWith('/api/notes/'), (r) => r.fulfill({ status: 204 }));
  await page.route((u) => u.pathname === '/api/shared-table', (r) => r.fulfill(json(201, { id: 'aaaaaaaa-0000-4000-8000-000000000002' })));
  await page.route((u) => u.pathname === '/api/shared-table/tally', (r) => r.fulfill(json(200, { shared: 2, byRecipe: { [PARIPPU]: 2 } })));
  await page.route((u) => u.pathname === '/api/meals', (r) => r.fulfill(json(201, { meal: { ...(r.request().postDataJSON() as { meal: object }).meal, id: 'cccccccc-0000-4000-8000-000000000001' } })));
  await page.route((u) => u.pathname === '/api/plans/current', (r) => r.fulfill(json(200, { plan: null, weekStart: monday, checks: [] })));
}
/** Leela's quest, answered until `stop` holds. */
async function questTo(page: Page, answer: (panel: string) => string, stop: (p: Page) => Promise<boolean>) {
  const riddle = (yaml<{ quest: { steps: { type: string; prompt?: string; options?: { text: string; correct: boolean }[] }[] } }>('cooks/leela.yaml')).quest.steps.find((s) => s.type === 'riddle')!;
  for (let i = 0; i < 120; i++) {
    if (await stop(page)) return;
    const panel = page.locator('.quest-panel');
    if (await panel.count()) {
      const text = (await panel.textContent()) ?? '';
      const name = text.includes(riddle.prompt!) ? riddle.options!.find((o) => o.correct)!.text : answer(text);
      await panel.getByRole('button', { name, exact: true }).click();
      continue;
    }
    if (await page.locator('.dialogue .dialogue-next').count()) { await page.locator('.dialogue .dialogue-next').click(); continue; }
    await page.waitForTimeout(50);
  }
  throw new Error('the quest never got there');
}
const errandAnswer = (panel: string) => (panel.includes('Fetch') ? "I've got it" : panel.includes('Cook it anyway') ? 'Cook it anyway' : "I've practised it");
const panelWith = (text: string) => async (p: Page) => (await p.locator('.quest-panel', { hasText: text }).count()) > 0;
/** Cook parippu to the certificate and through it: the after-cook questions (or, in Family Table mode, the kitchen). */
export async function cookThrough(page: Page): Promise<void> {
  await page.locator('.cook-progress').waitFor();
  for (let i = 0; i < 10 && (await button(page, 'Done ▶').count()) === 0; i++) await button(page, /Next step/).click();
  await button(page, 'Done ▶').click();
  await page.getByRole('dialog', { name: /Certificate of a Dish Cooked/ }).getByRole('button', { name: 'Continue' }).click();
}
const afterCookSignedIn = async (p: Page) => {
  await p.waitForFunction(() => Boolean((JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as { account?: unknown }).account));
  await cookThrough(p);
  await p.locator('.bureau-slip[data-kind="cooked_for"]').waitFor();
};

/** Fix round 1 (I1): a server plan card with a ⛔ dish (the account's coconut rule) and a ❓ one, beside the M5 lines. */
async function planCardApi(page: Page): Promise<void> {
  await loopApi(page);
  await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [{ ...coconutSevere, id: 's1', version: 1 }] })));
  await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, BOTH_CONSENTS)));
  const items = [
    { day: 2, kind: 'dish', slug: 'japan/osaka/onigiri', servings: 2 },
    { day: 4, kind: 'dish', slug: FRIJOLES, servings: 4 },
    { day: 6, kind: 'dish', slug: PARIPPU, servings: 3 },
  ];
  const card = {
    kind: 'plan', weekStart: monday, items, hard: false,
    checks: [{ slug: 'japan/osaka/onigiri', status: 'unverified' }, { slug: FRIJOLES, status: 'ok' }, { slug: PARIPPU, status: 'ok' }],
    unknown: [], dropped: [], offer: null, summary: 'Wednesday: Onigiri; Friday: Frijoles de Olla; Sunday: Parippu Curry.', added: items, basis: '00000000',
    readback: [{ trigger: 'plan.readback', vars: { summary: 'Wednesday: Onigiri; Friday: Frijoles de Olla; Sunday: Parippu Curry' } }],
  };
  await page.route((u) => u.pathname === '/api/mentor/turn', (r) => r.fulfill(json(200, {
    conversationId: 'c1', route: 'ai', notice: null, toolTurn: true, actions: [],
    parts: [
      line('plan.readback', card.readback[0].vars), line('plan.unverified_dish', { dish: 'Onigiri' }), line('plan.fewer_than_asked', { count: '2' }),
      { kind: 'go', target: { to: 'market' }, line: { trigger: 'nav.offer', vars: { place: 'the market list' } } },
    ],
    cards: [{ proposalId: 'P1', expiresAt: inHalfAnHour(), card }],
  })));
}
/**
 * M7 Step 11 (the a11y "partial move" flake, root cause): the plan screen reads the account once, when its week has
 * loaded, to decide on the move offer. On a cold load that raced the sign-in answer (/api/me): under load the week came
 * first, the screen was drawn signed out with no offer, and the case timed out waiting for it. A signed-in case means the
 * screen drawn signed in, so: wait until the account is stored, then draw the screen afresh.
 */
async function mountedSignedIn(page: Page, hash: string): Promise<void> {
  await page.waitForFunction((k) => ((JSON.parse(localStorage.getItem(k) ?? '{}') as { account?: unknown }).account ?? null) !== null, STORE_KEY);
  await page.evaluate(() => { location.hash = '#/'; });
  await page.locator('h1').first().waitFor();
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.locator('.plan-body, .market-body').first().waitFor();
}
/** Fix round 1 (I2): a partial move: the plan lands, the run's ticks can't follow (`week.move_partial`). */
async function partialMoveApi(page: Page): Promise<void> {
  await loopApi(page);
  await page.route((u) => u.pathname === `/api/plans/${monday}`, (r) => r.fulfill(json(200, { plan: { ...(r.request().postDataJSON() as { plan: object }).plan, id: 'row' }, checks: [] })));
  await page.route((u) => u.pathname === '/api/market-runs', (r) => r.fulfill(json(500, { error: { code: 'internal', message: 'x' } })));
}
const MOVE_RUN_SEED: Partial<PlayerState> = {
  ...WEEK_SEED,
  localWeek: {
    plans: WEEK_SEED.localWeek!.plans,
    runs: [{ id: 'local-run', weekStart: monday, doneAt: null, pantryIds: {}, items: [{ key: 'shallot', name: 'shallots', ingredientId: 'shallot', stall: 'wen', forDishes: [PARIPPU], ticked: true }] }],
  },
};
/** A plan with tempering gone Rusty (C27's refresher): the slot offers `one_more.refresh`. */
const REFRESH_SEED: Partial<PlayerState> = { ...RUSTY_SEED, ...PAN_READY, localWeek: { plans: [{ weekStart: monday, items: [], hard: false, slot: 'unanswered' }], runs: [] } };

export const LOOP_SCREENS: ScreenCase[] = [
  // The quest runner: each step kind and the adapted panels (Step 9).
  {
    label: 'visit (a quest step: the drill)', loop: true, path: '/#/visit/leela', seed: PAN_READY,
    open: (p) => questTo(p, errandAnswer, panelWith("I've practised it")),
    primary: (p) => p.locator('.quest-panel').getByRole('button', { name: "I've practised it" }),
  },
  {
    label: 'visit (a quest step: the riddle)', loop: true, path: '/#/visit/leela', seed: PAN_READY,
    open: async (p) => {
      for (let i = 0; i < 120 && (await p.locator('.quest-panel button', { hasText: 'Mustard seeds' }).count()) === 0; i++) {
        if (await p.locator('.quest-panel').count()) { await p.locator('.quest-panel button').first().click(); continue; }
        if (await p.locator('.dialogue .dialogue-next').count()) await p.locator('.dialogue .dialogue-next').click(); else await p.waitForTimeout(50);
      }
      await p.locator('.quest-panel button', { hasText: 'Mustard seeds' }).waitFor();
    },
    primary: (p) => p.locator('.quest-panel button').first(),
  },
  {
    label: 'visit (a quest step: recognize, then the cook step\'s card)', loop: true, path: '/#/visit/leela', seed: PRIOR,
    open: (p) => questTo(p, errandAnswer, async (pg) => (await pg.getByRole('dialog', { name: PARIPPU_TITLE }).count()) > 0),
    primary: (p) => p.getByRole('dialog', { name: PARIPPU_TITLE }).getByRole('button', { name: /Cook it/ }),
  },
  {
    label: 'visit (adapted: a blocked errand passes, the ⛔ dish taught as a lesson)', loop: true, path: '/#/visit/leela', seed: { ...PAN_READY, localRules: [shallotSevere] },
    open: (p) => questTo(p, (t) => (t.includes('Learn it as a lesson') ? 'Learn it as a lesson' : "I've practised it"), panelWith('Learn it as a lesson')),
    primary: (p) => p.locator('.quest-panel').getByRole('button', { name: 'Learn it as a lesson' }),
  },
  {
    label: 'visit (adapted: a ❓ dish, the lesson or "Cook it anyway")', loop: true, path: '/#/visit/leela', seed: { ...PAN_READY, localRules: [peanutSevere] },
    open: (p) => questTo(p, (t) => (t.includes('Fetch') ? "I've got it" : "I've practised it"), panelWith('Cook it anyway')),
    primary: (p) => p.locator('.quest-panel').getByRole('button', { name: 'Cook it anyway' }),
  },
  {
    label: 'visit (the rules can\'t be read: the quest waits, with a link)', loop: true, path: '/#/visit/leela', seed: { ...PAN_READY, rulesUnreadable: true },
    open: (p) => questTo(p, () => 'Later', async (pg) => (await pg.locator('.quest-panel a.quest-rules-link').count()) > 0),
    primary: (p) => p.locator('.quest-panel a.quest-rules-link'),
  },
  {
    label: 'map: a cook awaiting an introduction (Travel anyway)', loop: true, path: '/#/map', seed: PAN_READY,
    open: async (p) => { await button(p, MARISOL_PIN).click(); await p.getByRole('dialog', { name: 'Travel Permit' }).getByRole('button', { name: 'Travel anyway' }).waitFor(); },
    primary: (p) => p.getByRole('dialog', { name: 'Travel Permit' }).getByRole('button', { name: 'Travel anyway' }),
  },
  { label: 'visit (Family Table: the cook\'s lines, no quest runner)', loop: true, path: '/#/visit/leela', seed: { ...PAN_READY, ...ft }, open: (p) => p.locator('.dialogue .dialogue-text .typed-full').waitFor(), primary: (p) => p.locator('.dialogue .dialogue-next') },

  // The week (Step 10).
  {
    label: 'plan: the weekly slot offers tempering (C27)', loop: true, countdown: true, path: '/#/plan', seed: { ...PRIOR, localWeek: WEEK_SEED.localWeek },
    open: (p) => p.locator('.plan-slot').waitFor(), primary: (p) => p.locator('.plan-slot').getByRole('button', { name: 'Not this week' }),
  },
  {
    label: 'plan: a ⛔ dish, Cook disabled', loop: true, countdown: true, path: '/#/plan', seed: { ...WEEK_SEED, localRules: [coconutSevere] },
    open: (p) => p.locator('.plan-item[data-status="blocked"]').waitFor(), primary: (p) => p.locator('.plan-save'),
  },
  { label: 'plan (Family Table)', loop: true, countdown: true, path: '/#/plan', seed: { ...WEEK_SEED, ...PRIOR, localWeek: WEEK_SEED.localWeek, ...ft }, open: (p) => p.locator('.plan-item').first().waitFor(), primary: (p) => p.getByRole('link', { name: 'The market list' }) },
  { label: 'market list (Family Table)', loop: true, countdown: true, path: '/#/market', seed: { ...WEEK_SEED, ...ft }, open: (p) => p.locator('.market-row').first().waitFor(), primary: (p) => p.getByRole('link', { name: "This week's plan" }) },
  { label: 'pantry frame (Family Table)', loop: true, path: '/#/frame/fried-rice', seed: { ...PAN_READY, ...ft }, open: (p) => p.locator('.frame-cook').waitFor(), primary: (p) => p.locator('.frame-cook') },
  {
    label: 'kitchen: the Use-It-Up rescue', loop: true, countdown: true, path: '/', seed: RESCUE_SEED,
    open: (p) => p.locator('.rescue').waitFor(), primary: (p) => p.locator('.rescue').getByRole('button', { name: 'Cook the frame' }),
  },
  {
    label: 'plan (signed in): the move-this-week card', loop: true, countdown: true, path: '/#/plan', seed: WEEK_SEED, beforeGoto: loopApi,
    open: async (p) => { await mountedSignedIn(p, '#/plan'); await p.locator('.week-move-offer').waitFor(); }, primary: (p) => p.locator('.week-move-offer').getByRole('button', { name: 'Move it' }),
  },

  // Fix round 1 (I1): the Pan panel's Form 7-W plan card, from the server (⛔ and ❓ rows) and from the script.
  {
    label: 'mentor panel (signed in): a plan card with a ⛔ and a ❓ dish', loop: true, countdown: true, mentor: true, path: '/', seed: PAN_READY, beforeGoto: planCardApi,
    open: async (p) => {
      await say(p, 'plan my week', 1);
      await p.locator('#pan-panel .pan-card[data-kind="plan"] .plan-item[data-status="blocked"]').waitFor();
      await p.locator('#pan-panel .pan-card[data-kind="plan"] .plan-item[data-status="unverified"]').first().waitFor();
    },
    primary: (p) => p.locator('#pan-panel .pan-card[data-kind="plan"]').getByRole('button', { name: 'Plan it ✔' }),
  },
  {
    label: 'mentor panel (signed out): the scripted plan card', loop: true, countdown: true, mentor: true, path: '/', seed: PAN_READY,
    open: async (p) => {
      await p.locator('#pan-button').click();
      await p.locator('#pan-text').fill('plan my week: parippu on Sunday, onigiri on Wednesday');
      await p.keyboard.press('Enter');
      await p.locator('#pan-panel .pan-card[data-kind="plan"] .plan-item').first().waitFor();
    },
    primary: (p) => p.locator('#pan-panel .pan-card[data-kind="plan"]').getByRole('button', { name: 'Plan it ✔' }),
  },
  {
    label: 'mentor panel (signed out): a scripted plan card naming a ⛔ dish', loop: true, countdown: true, mentor: true, path: '/', seed: { ...PAN_READY, localRules: [coconutSevere] },
    open: async (p) => {
      await p.locator('#pan-button').click();
      await p.locator('#pan-text').fill('plan my week: parippu on Sunday, onigiri on Wednesday');
      await p.keyboard.press('Enter');
      await p.locator('#pan-panel .pan-card[data-kind="plan"]').waitFor();
    },
    primary: (p) => p.locator('#pan-panel').getByRole('button', { name: 'Send', exact: true }),
  },
  {
    // The Pan picks its line at random; fixed here to its last variant, plan.saved[3] ("A plan's just a guess": M5
    // final m14 reworded it from "only", so it needs no allowlist entry). The week screens say a trigger's first line.
    label: 'mentor panel (signed out): a plan card confirmed', loop: true, countdown: true, mentor: true, path: '/', seed: PAN_READY, initScript: 'Math.random = () => 0.99;',
    open: async (p) => {
      await p.locator('#pan-button').click();
      await p.locator('#pan-text').fill('plan my week: parippu on Sunday');
      await p.keyboard.press('Enter');
      const card = p.locator('#pan-panel .pan-card[data-kind="plan"]');
      await card.getByRole('button', { name: 'Plan it ✔' }).click();
      await p.locator('#pan-panel .trail-entry').waitFor();
    },
    primary: (p) => p.locator('#pan-panel').getByRole('button', { name: 'Send', exact: true }),
  },
  // Fix round 1 (I2): the states after Save, the shop done, a refresher slot and a partial move.
  {
    label: 'plan: saved', loop: true, countdown: true, path: '/#/plan', seed: WEEK_SEED,
    open: async (p) => { await p.locator('.plan-save').click(); await p.waitForFunction(() => (document.getElementById('plan-status')?.textContent ?? '').trim().length > 0); },
    primary: (p) => p.locator('.plan-save'),
  },
  {
    label: 'market list: the shop done', loop: true, countdown: true, path: '/#/market', seed: WEEK_SEED,
    open: async (p) => {
      const box = p.locator('.market-tick').first();
      await box.waitFor();
      const key = await box.getAttribute('data-key');
      await box.click();
      await p.locator(`.market-tick[data-key="${key}"]:checked`).waitFor();
      await button(p, "That's the shop done").click();
      await p.locator('.market-done').waitFor({ state: 'detached' });
      await p.waitForFunction(() => [...document.querySelectorAll('.week-note')].some((e) => (e.textContent ?? '').trim().length > 0));
    },
    primary: (p) => p.getByRole('link', { name: "This week's plan" }),
  },
  {
    label: 'plan: the weekly slot as a refresher (Rusty tempering)', loop: true, countdown: true, path: '/#/plan', seed: REFRESH_SEED,
    open: (p) => p.locator('.plan-slot').waitFor(), primary: (p) => p.locator('.plan-slot').getByRole('button', { name: 'Not this week' }),
  },
  {
    label: 'plan (signed in): a partial move', loop: true, countdown: true, path: '/#/plan', seed: MOVE_RUN_SEED, beforeGoto: partialMoveApi,
    open: async (p) => {
      await mountedSignedIn(p, '#/plan');
      const offer = p.locator('.week-move-offer');
      await offer.getByRole('button', { name: 'Move it' }).click();
      await p.waitForFunction(() => (document.querySelector('.week-move-offer [role="status"]')?.textContent ?? '').trim().length > 0);
    },
    primary: (p) => p.locator('.week-move-offer').getByRole('button', { name: 'Move it' }),
  },

  // The kitchen's apprentice card and the guest offer (Step 9).
  { label: 'kitchen: the apprentice card', loop: true, path: '/', seed: PRIOR, open: (p) => p.locator('.apprentice-card').waitFor(), primary: (p) => button(p, 'Go out to the world map') },
  {
    label: 'kitchen (signed in): the guest-progress offer', loop: true, path: '/', seed: PRIOR, beforeGoto: loopApi,
    open: (p) => p.getByRole('region', { name: "Add this device's progress to your account?" }).waitFor(),
    primary: (p) => button(p, 'Add it to my account'),
  },
  { label: 'kitchen: the apprentice card (Family Table)', loop: true, path: '/', seed: { ...PRIOR, ...ft }, open: (p) => p.locator('.apprentice-card').waitFor(), primary: (p) => button(p, 'Go out to the world map') },

  // After the cooking (Step 11): the new slips.
  {
    label: 'after cook (signed in): who ate with you', loop: true, path: `/#/cook/${PARIPPU}`, seed: PAN_READY, beforeGoto: loopApi,
    open: afterCookSignedIn, primary: (p) => p.locator('.bureau-slip[data-kind="cooked_for"]').getByRole('button', { name: 'Skip' }),
  },
  {
    label: 'after cook (signed in): "Just me", then the margin note slip', loop: true, path: `/#/cook/${PARIPPU}`, seed: PAN_READY, beforeGoto: loopApi,
    open: async (p) => {
      await afterCookSignedIn(p);
      const who = p.locator('.bureau-slip[data-kind="cooked_for"]');
      await who.getByRole('button', { name: 'Just me' }).click();
      await who.getByRole('button', { name: 'Stamp it ✔' }).click();
      await p.locator('.note-text').fill('added lime');
      await button(p, 'Read it back').click();
      await p.locator('.bureau-slip[data-kind="margin_note"]').waitFor();
    },
    primary: (p) => p.locator('.bureau-slip[data-kind="margin_note"]').getByRole('button', { name: 'Write it in ✔' }),
  },
  {
    label: 'after cook (signed in): the one-tap log, logged', loop: true, path: `/#/cook/${PARIPPU}`, seed: PAN_READY, beforeGoto: loopApi,
    open: async (p) => {
      await afterCookSignedIn(p);
      await p.locator('.bureau-slip[data-kind="cooked_for"]').getByRole('button', { name: 'Skip' }).click();
      await p.locator('.note-skip').click();
      const log = p.locator('.bureau-slip[data-kind="meal"]');
      await log.waitFor();
      await log.getByRole('button', { name: 'Log it' }).click();
      await p.locator('.after-cook-step', { hasText: 'Log it?' }).getByRole('button', { name: /Undo/ }).waitFor();
    },
    primary: (p) => button(p, 'Back to the kitchen'),
  },
  {
    label: 'after cook (signed out): the account-only questions say so', loop: true, path: `/#/cook/${PARIPPU}`, seed: PAN_READY,
    open: async (p) => { await cookThrough(p); await p.locator('.after-cook').waitFor(); },
    primary: (p) => button(p, 'Back to the kitchen'),
  },
  {
    label: 'after cook (Family Table): straight back to the kitchen', loop: true, path: `/#/cook/${PARIPPU}`, seed: { ...PAN_READY, ...ft }, beforeGoto: loopApi,
    open: async (p) => { await cookThrough(p); await p.waitForFunction(() => location.hash === '#/kitchen'); await h1(p, 'Your kitchen'); },
    primary: (p) => button(p, 'Go out to the world map'),
  },

  // The Recipe Book (Step 11).
  { label: 'book (signed in)', loop: true, path: '/#/book', seed: PAN_READY, beforeGoto: loopApi, open: (p) => p.locator('.book-index-item').first().waitFor(), primary: (p) => button(p, 'Download my book') },
  { label: 'book page (signed in): notes and the Shared Table', loop: true, path: `/#/book/${PARIPPU}`, seed: PAN_READY, beforeGoto: loopApi, open: (p) => p.locator('.book-notes-panel').waitFor(), primary: (p) => button(p, 'Download my book') },
  { label: 'book (signed out)', loop: true, path: '/#/book', seed: PRIOR, open: (p) => p.locator('.book-index, .book-empty').first().waitFor(), primary: (p) => button(p, 'Download my book') },
  { label: 'book (Family Table)', loop: true, path: '/#/book', seed: { ...PAN_READY, ...ft }, beforeGoto: loopApi, open: (p) => p.locator('.book-index-item').first().waitFor(), primary: (p) => button(p, 'Download my book') },
  { label: 'book page (Family Table)', loop: true, path: `/#/book/${PARIPPU}`, seed: { ...PAN_READY, ...ft }, beforeGoto: loopApi, open: (p) => p.locator('.book-techniques').waitFor(), primary: (p) => button(p, 'Download my book') },
];

/**
 * M6 Step 9: the market hub and each stall, standard and Family Table, for the a11y and never-rules sweeps. A stall
 * shows its keeper's greeting and the round's first question; "Leave the stall" is its primary action.
 * M6 Step 11: every M6 screen and state, in standard and Family Table mode (where Family Table has the state): the
 * hub, each stall, the Protein Counter (consented and not), a round mid-question and after an answer, the chalkboard,
 * the FAQ, the round's end, the Season's Table (the seasonal round, "no calendar yet", list notes), the market list
 * with amounts, an open stock control and a swap taken, the check-off card (grammar and model), the drill-first hint
 * and the market-day screens (the errand question, cook mode's swap label). Family Table has no FAQ, no consent card,
 * no stock control and no check-off card (it records nothing and has no text box, C31): its cases show what it shows.
 */
const STALLS = ['wen', 'bram', 'okafor-sato', 'spice'] as const;
const VEGETARIAN = { id: 'r-veg', target: { kind: 'category' as const, ids: ['meat', 'fish', 'shellfish', 'gelatin'] }, type: 'avoid' as const, severity: 'preference' as const };
const stallOpen = (p: Page) => p.locator('.stall-option').first().waitFor();
const m6 = { market: true as const, loop: true as const };
/** Saturday 14 November 2026, mid-morning: the Pacific Northwest table has a November entry (Ruling 9). */
const MARKET_NOW = new Date(2026, 10, 14, 10, 0, 0);
const MARKET_MONDAY = '2026-11-09';
const atMarketNow = (then?: (p: Page) => Promise<unknown>) => async (p: Page) => { await p.clock.install({ time: MARKET_NOW }); await p.clock.resume(); await then?.(p); };
const PNW_PROFILE = { marketDays: [], mealsPerWeek: null, country: 'United States', region: 'Washington State', mealWindows: [] };
const KERALA_PROFILE = { ...PNW_PROFILE, country: 'India', region: 'Kerala' };
type StallYaml = { questions: { id: string; options: { correct?: boolean }[] }[] };
const wenYaml = yaml<StallYaml>('market/wen.yaml');
/** Every Wen base question answered right in October, so the November seasonal questions lead the round. */
const WEN_SOLVED = {
  events: [{ id: '00000000-0000-4000-8000-000000000901', kind: 'stall_round' as const, at: '2026-10-19', stall: 'wen', answers: wenYaml.questions.map((q) => ({ q: q.id, pick: q.options.findIndex((o) => o.correct === true) })) }],
  grants: [], base: null, pendingUpload: [],
};
const AI_OFF = (familyTable: boolean) => ({ ...settings(familyTable), aiMentor: false });
const PARIPPU_WEEK = { plans: [{ weekStart: MARKET_MONDAY, items: [{ day: 6, kind: 'dish' as const, slug: PARIPPU, servings: 3 }], hard: false, slot: 'unanswered' as const }], runs: [] };
const row = (key: string, name: string, stall: 'wen' | 'okafor-sato' | 'spice' | 'general', extra: object = {}) => ({ key, name, ingredientId: key.replace(/^stock:/, ''), stall, forDishes: [PARIPPU], ticked: false, ...extra });
/** A run where the shallots were out and onion taken (as Step 10's stall swap leaves it). */
const SWAPPED_RUN = {
  id: 'local-run', weekStart: MARKET_MONDAY, doneAt: null, pantryIds: {},
  items: [
    row('stock:onion', 'onion', 'wen', { stockSwap: { from: 'shallot' }, ticked: true }),
    row('shallot', 'shallots', 'wen', { amounts: [{ quantity: 3, unit: null, text: '3' }], outOfStock: true }),
    row('moong_dal', 'split moong dal', 'okafor-sato', { amounts: [{ quantity: 100, unit: 'g', text: '100 g' }] }),
  ],
};
/**
 * The Season's Table on the list. No canon dish uses the Pacific Northwest's November produce (Step 10 carry), so two
 * ticked rows are seeded (a ticked row is kept exactly, C23): cranberries ("in season here, now") and winter squash
 * (stored). The note itself is the screen's own, from core `seasonNote`.
 */
const SEASON_RUN = {
  ...SWAPPED_RUN,
  items: [...SWAPPED_RUN.items, row('cranberry', 'cranberries', 'wen', { ticked: true }), row('winter_squash', 'winter squash', 'wen', { ticked: true })],
};
const marketWeek = (familyTable: boolean, extra: Partial<PlayerState> = {}): Partial<PlayerState> => ({
  ...PAN_READY, settings: AI_OFF(familyTable), localProfile: PNW_PROFILE, localWeek: PARIPPU_WEEK, ...extra,
});
/** Signed in with the account's rules and consents (the Protein Counter needs health_data, Ruling 17). */
const stallApi = (opts: { health: boolean; rules: unknown[] }) => async (page: Page) => {
  const consents = opts.health ? HEALTH_GRANTED : { consents: [], needsReconsent: [], notices: NOTICES };
  await page.route((u) => u.pathname.startsWith('/api/'), (r) => {
    const path = new URL(r.request().url()).pathname.replace(/^\/api/, '');
    if (path === '/me') return r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] }));
    if (path === '/me/consents') return r.fulfill(json(200, consents));
    if (path === '/profile') return r.fulfill(json(200, { marketDays: [], mealsPerWeek: null, country: null, region: null, mealWindows: [] }));
    if (path === '/rules') return r.fulfill(json(200, { rules: opts.rules }));
    if (path === '/progress') return r.fulfill(json(200, { view: null }));
    return r.fulfill(json(404, { error: { code: 'not_found', message: path } }));
  });
};
/** Answer the round's questions (the first option) until `id` shows, or the round ends. */
async function toQuestion(p: Page, id: string): Promise<void> {
  await stallOpen(p);
  for (let i = 0; i < 12 && (await p.locator('.stall-round').getAttribute('data-question')) !== id; i++) {
    await p.locator('.stall-option').first().click();
    await p.locator('.stall-next').click();
  }
  await p.locator(`.stall-round[data-question="${id}"]`).waitFor();
}
const answerFirst = async (p: Page) => { await p.locator('.stall-option').first().click(); await p.locator('.stall-feedback:not([hidden])').waitFor(); };
async function playOut(p: Page): Promise<void> {
  await stallOpen(p);
  for (let i = 0; i < 12 && (await p.locator('.stall-round').count()) > 0; i++) { await answerFirst(p); await p.locator('.stall-next').click(); }
  await p.locator('.stall-done').waitFor();
}
async function panSays(p: Page, text: string): Promise<void> {
  await p.locator('#pan-button').click();
  const before = await p.locator('#pan-panel .bubble.pan').count();
  await p.locator('#pan-text').fill(text);
  await p.keyboard.press('Enter');
  await p.waitForFunction((n) => document.querySelectorAll('#pan-panel .bubble.pan').length > n, before);
}
const checkOffState = (state: string) => (p: Page) => p.waitForFunction((st) => [...document.querySelectorAll<HTMLElement>('.pan-checkoff-card')].at(-1)?.dataset.state === st, state);
/** Signed in with the AI on: the server's run, and the model's propose_check_off card waiting for a tap (Ruling 14). */
async function modelCheckOffApi(page: Page): Promise<void> {
  const run = { id: 'run1', weekStart: MARKET_MONDAY, doneAt: null, items: [row('green_chili', 'green chillies', 'wen'), row('moong_dal', 'split moong dal', 'okafor-sato')] };
  const card = {
    kind: 'check_off', source: 'model', runId: 'run1', got: ['green_chili'], missing: [], summary: 'got green chillies',
    readback: [{ trigger: 'market.checkoff_readback', vars: { summary: 'got green chillies' } }],
  };
  await page.route((u) => u.pathname.startsWith('/api/'), (r) => {
    const path = new URL(r.request().url()).pathname.replace(/^\/api/, '');
    if (path === '/me') return r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] }));
    if (path === '/me/consents') return r.fulfill(json(200, BOTH_CONSENTS));
    if (path === '/profile') return r.fulfill(json(200, { marketDays: [], mealsPerWeek: null, country: null, region: null, mealWindows: [] }));
    if (path === '/rules') return r.fulfill(json(200, { rules: [] }));
    if (path === '/pantry') return r.fulfill(json(200, { items: [] }));
    if (path === '/progress') return r.fulfill(json(200, { view: null }));
    if (path === '/plans/current') return r.fulfill(json(200, { plan: null, weekStart: MARKET_MONDAY, checks: [] }));
    if (path === '/market-runs/current') return r.fulfill(json(200, { run }));
    if (path === '/mentor/turn') {
      return r.fulfill(json(200, {
        conversationId: 'c1', route: 'ai', notice: null, toolTurn: true, actions: [],
        parts: card.readback.map((l) => ({ kind: 'line', line: l })), cards: [{ proposalId: 'P2', expiresAt: inHalfAnHour(), card }],
      }));
    }
    return r.fulfill(json(404, { error: { code: 'not_found', message: path } }));
  });
}
const MARISOL_EVENTS = (() => {
  const at = daysAgo(0);
  const ev = (n: number, kind: string, extra: object) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, kind, at, ...extra });
  return [
    ...[1, 2, 3, 4, 5, 6].map((st) => ev(st, 'quest_step', { quest: 'leela-tempering', step: st })), ev(7, 'quest_done', { quest: 'leela-tempering' }),
    ev(8, 'quest_step', { quest: 'marisol-salt-question', step: 1 }), ev(9, 'quest_step', { quest: 'marisol-salt-question', step: 2 }),
  ];
})();
async function toErrandQuestion(p: Page): Promise<void> {
  for (let i = 0; i < 160 && (await p.locator('.quest-errand-question .stall-option').count()) === 0; i++) {
    const panel = p.locator('.quest-panel');
    if (await panel.count()) {
      const t = (await panel.textContent()) ?? '';
      if (t.includes('Fetch')) { await panel.getByRole('button', { name: "I've got it", exact: true }).click(); continue; }
      if (await p.locator('.quest-errand-question').count()) { await p.waitForTimeout(50); continue; }
      await panel.getByRole('button', { name: 'Not yet', exact: true }).click();
      continue;
    }
    if (await p.locator('.dialogue .dialogue-next').count()) { await p.locator('.dialogue .dialogue-next').click(); continue; }
    await p.waitForTimeout(50);
  }
  await p.locator('.quest-errand-question .stall-option').first().waitFor();
}

export const MARKET_SCREENS: ScreenCase[] = [
  // The hub.
  { label: 'market hub', ...m6, path: '/#/stalls', seed: PAN_READY, open: (p) => p.locator('.stall-button-games', { hasText: /\S/ }).first().waitFor(), primary: (p) => p.locator('.stall-button').first() },
  { label: 'market hub (Family Table)', ...m6, path: '/#/stalls', seed: { ...PAN_READY, ...ft }, open: (p) => p.locator('.stall-button').first().waitFor(), primary: (p) => p.locator('.stall-button').first() },
  {
    label: 'market hub: after leaving a round (market.leave_round)', ...m6, path: '/#/stall/spice', seed: PAN_READY,
    open: async (p) => { await answerFirst(p); await button(p, 'Leave the stall').click(); await p.waitForFunction(() => (document.querySelector('.week-note')?.textContent ?? '').trim().length > 0); },
    primary: (p) => p.locator('.stall-button').first(),
  },
  {
    label: 'market hub (Family Table): after leaving a round', ...m6, path: '/#/stall/spice', seed: { ...PAN_READY, ...ft },
    open: async (p) => { await answerFirst(p); await button(p, 'Leave the stall').click(); await p.locator('.stall-button').first().waitFor(); },
    primary: (p) => p.locator('.stall-button').first(),
  },
  // Each stall, mid-question (its first question), with its tips and FAQ chips.
  ...STALLS.flatMap((id): ScreenCase[] => [
    { label: `stall ${id}`, ...m6, path: `/#/stall/${id}`, seed: PAN_READY, open: stallOpen, primary: (p) => button(p, 'Leave the stall') },
    { label: `stall ${id} (Family Table)`, ...m6, path: `/#/stall/${id}`, seed: { ...PAN_READY, ...ft }, open: stallOpen, primary: (p) => button(p, 'Leave the stall') },
    { label: `stall ${id}: a question answered`, ...m6, path: `/#/stall/${id}`, seed: PAN_READY, open: async (p) => { await stallOpen(p); await answerFirst(p); }, primary: (p) => p.locator('.stall-next') },
    { label: `stall ${id} (Family Table): a question answered`, ...m6, path: `/#/stall/${id}`, seed: { ...PAN_READY, ...ft }, open: async (p) => { await stallOpen(p); await answerFirst(p); }, primary: (p) => p.locator('.stall-next') },
  ]),
  // The round's end: the done line and the keeper's farewell.
  { label: 'stall okafor-sato: the round done', ...m6, path: '/#/stall/okafor-sato', seed: PAN_READY, open: playOut, primary: (p) => button(p, 'Another round') },
  { label: 'stall okafor-sato (Family Table): the round done', ...m6, path: '/#/stall/okafor-sato', seed: { ...PAN_READY, ...ft }, open: playOut, primary: (p) => button(p, 'Another round') },
  // The FAQ: a chip tapped, its written answer shown (none in Family Table: its stall cases above show the chips absent).
  {
    label: 'stall spice: a FAQ answer open', ...m6, path: '/#/stall/spice', seed: PAN_READY,
    open: async (p) => { await stallOpen(p); await p.locator('.stall-faq-chip').first().click(); await p.locator('.stall-faq-answer p').waitFor(); },
    primary: (p) => p.locator('.stall-faq-chip').first(),
  },
  // The chalkboard (Ruling 5): Big Bram's price question and the Protein Counter's, with the example-price footnote.
  { label: 'stall bram: the chalkboard', ...m6, path: '/#/stall/bram', seed: PAN_READY, open: (p) => toQuestion(p, 'bram-value-braise'), primary: (p) => button(p, 'Leave the stall') },
  { label: 'stall bram (Family Table): the chalkboard, answered', ...m6, path: '/#/stall/bram', seed: { ...PAN_READY, ...ft }, open: async (p) => { await toQuestion(p, 'bram-value-braise'); await answerFirst(p); }, primary: (p) => p.locator('.stall-next') },
  // The Protein Counter: signed out (device rules, no consent needed on the device), signed in with and without health_data.
  {
    label: 'stall bram: the Protein Counter, a question answered', ...m6, path: '/#/stall/bram', seed: { ...PAN_READY, localRules: [VEGETARIAN] },
    open: async (p) => { await stallOpen(p); await answerFirst(p); },
    primary: (p) => p.locator('.stall-next'),
  },
  { label: 'stall bram: the Protein Counter\'s chalkboard', ...m6, path: '/#/stall/bram', seed: { ...PAN_READY, localRules: [VEGETARIAN] }, open: (p) => toQuestion(p, 'bram-pc-cheapest'), primary: (p) => button(p, 'Leave the stall') },
  { label: 'stall bram (Family Table): the Protein Counter', ...m6, path: '/#/stall/bram', seed: { ...PAN_READY, ...ft, localRules: [VEGETARIAN] }, open: stallOpen, primary: (p) => button(p, 'Leave the stall') },
  {
    label: 'stall bram (signed in): the Protein Counter without health_data asks first', ...m6, mentor: true, path: '/#/stall/bram', seed: PAN_READY,
    beforeGoto: stallApi({ health: false, rules: [{ ...VEGETARIAN, id: 's1' }] }),
    open: (p) => p.locator('.stall-consent').waitFor(), primary: (p) => p.locator('.stall-consent'),
  },
  {
    label: 'stall bram (signed in): the Protein Counter, consented', ...m6, path: '/#/stall/bram', seed: PAN_READY,
    beforeGoto: stallApi({ health: true, rules: [{ ...VEGETARIAN, id: 's1' }] }),
    open: stallOpen, primary: (p) => button(p, 'Leave the stall'),
  },
  {
    label: 'stall bram (signed in, Family Table): the Protein Counter plays in practice, no consent card', ...m6, path: '/#/stall/bram', seed: { ...PAN_READY, ...ft },
    beforeGoto: stallApi({ health: false, rules: [{ ...VEGETARIAN, id: 's1' }] }),
    open: stallOpen, primary: (p) => button(p, 'Leave the stall'),
  },
  // The Season's Table: Wen's seasonal round for the Pacific Northwest, "no calendar yet" elsewhere, and list notes.
  {
    label: 'stall wen: the seasonal round (Pacific Northwest, November)', ...m6, path: '/#/stall/wen', seed: { ...PAN_READY, localProfile: PNW_PROFILE, progress: WEN_SOLVED },
    beforeGoto: atMarketNow(), open: (p) => p.locator('.stall-round[data-question^="wen-pnw-11-"]').waitFor(), primary: (p) => button(p, 'Leave the stall'),
  },
  {
    label: 'stall wen (Family Table): the seasonal round, answered', ...m6, path: '/#/stall/wen', seed: { ...PAN_READY, ...ft, localProfile: PNW_PROFILE, progress: WEN_SOLVED },
    beforeGoto: atMarketNow(), open: async (p) => { await p.locator('.stall-round[data-question^="wen-pnw-11-"]').waitFor(); await answerFirst(p); }, primary: (p) => p.locator('.stall-next'),
  },
  {
    label: 'stall wen: no calendar yet (Kerala, India)', ...m6, path: '/#/stall/wen', seed: { ...PAN_READY, localProfile: KERALA_PROFILE },
    beforeGoto: atMarketNow(), open: async (p) => { await stallOpen(p); await p.locator('.stall-note').first().waitFor(); }, primary: (p) => button(p, 'Leave the stall'),
  },
  {
    label: 'stall wen (Family Table): no calendar yet (Kerala, India)', ...m6, path: '/#/stall/wen', seed: { ...PAN_READY, ...ft, localProfile: KERALA_PROFILE },
    beforeGoto: atMarketNow(), open: async (p) => { await stallOpen(p); await p.locator('.stall-note').first().waitFor(); }, primary: (p) => button(p, 'Leave the stall'),
  },
  {
    label: 'market list: Season\'s Table notes (Pacific Northwest)', ...m6, countdown: true, path: '/#/market', seed: marketWeek(false, { localWeek: { ...PARIPPU_WEEK, runs: [SEASON_RUN] } }),
    beforeGoto: atMarketNow(), open: async (p) => { await p.locator('.season-note').nth(1).waitFor(); }, primary: (p) => button(p, "That's the shop done"),
  },
  // The market list (Form 12-M): amounts, the stock control open, and a swap taken (the out-of-stock row marked).
  {
    label: 'market list: amounts, the stock control open on shallots', ...m6, countdown: true, path: '/#/market', seed: marketWeek(false), beforeGoto: atMarketNow(),
    open: async (p) => {
      await p.locator('.market-row[data-key="moong_dal"] .market-amount').waitFor();
      await p.locator('.market-row[data-key="shallot"] .stock-ask').click();
      await p.locator('.market-row[data-key="shallot"] .stock-swap').first().waitFor();
    },
    primary: (p) => button(p, "That's the shop done"),
  },
  {
    label: 'market list: a stall swap taken, the shallots out of stock', ...m6, countdown: true, path: '/#/market', seed: marketWeek(false, { localWeek: { ...PARIPPU_WEEK, runs: [SWAPPED_RUN] } }), beforeGoto: atMarketNow(),
    open: async (p) => { await p.locator('.market-row[data-key="stock:onion"]').waitFor(); await p.locator('.market-row[data-key="shallot"] .market-out').waitFor(); },
    primary: (p) => button(p, "That's the shop done"),
  },
  {
    // Family Table reads the list as core computes it now (no run is opened): amounts, and no stock control or box.
    label: 'market list (Family Table): amounts, no stock control', ...m6, countdown: true, path: '/#/market', seed: marketWeek(true), beforeGoto: atMarketNow(),
    open: async (p) => { await p.locator('.market-row[data-key="moong_dal"] .market-amount').waitFor(); },
    primary: (p) => p.getByRole('link', { name: "This week's plan" }),
  },
  // The check-off card: the closed grammar's (ticked at once, with an Undo; and undone), and the model's (waits for a tap).
  {
    label: 'mentor panel: the grammar check-off card, applied', ...m6, mentor: true, path: '/#/market', seed: marketWeek(false), beforeGoto: atMarketNow(),
    open: async (p) => { await p.locator('.market-row[data-key="moong_dal"]').waitFor(); await panSays(p, 'got the moong dal'); await checkOffState('applied')(p); },
    primary: (p) => p.locator('.pan-checkoff-card').getByRole('button', { name: 'Undo' }),
  },
  {
    label: 'mentor panel: the grammar check-off card, undone', ...m6, mentor: true, path: '/#/market', seed: marketWeek(false), beforeGoto: atMarketNow(),
    open: async (p) => {
      await p.locator('.market-row[data-key="moong_dal"]').waitFor();
      await panSays(p, 'got the moong dal');
      await checkOffState('applied')(p);
      await p.locator('.pan-checkoff-card').getByRole('button', { name: 'Undo' }).click();
      await checkOffState('undone')(p);
    },
    primary: (p) => p.locator('#pan-panel').getByRole('button', { name: 'Send', exact: true }),
  },
  {
    label: 'mentor panel (signed in): a model-proposed check-off card waiting for its tap', ...m6, mentor: true, path: '/', seed: { ...PAN_READY, settings: settings(false) }, beforeGoto: modelCheckOffApi,
    open: async (p) => { await accountLoaded(p); await panSays(p, 'I grabbed some of those green chilli things'); await checkOffState('pending')(p); },
    primary: (p) => p.locator('.pan-checkoff-card').getByRole('button', { name: 'Tick these' }),
  },
  {
    label: 'mentor panel (Family Table) on the market list: no text box, no check-off card', ...m6, mentor: true, path: '/#/market', seed: marketWeek(true), beforeGoto: atMarketNow(),
    open: async (p) => { await p.locator('.market-row').first().waitFor(); await p.locator('#pan-button').click(); await p.locator('#pan-panel').waitFor(); },
    primary: (p) => p.locator('#pan-panel .pan-close'),
  },
  // The drill-first hint (Ruling 16): the recipe and cook screens; none in Family Table.
  { label: 'recipe card: the drill-first hint', ...m6, path: `/#/recipe/${PARIPPU}`, seed: PAN_READY, open: (p) => p.locator('.drill-first').waitFor(), primary: (p) => button(p, 'Cook it') },
  { label: 'recipe card (Family Table): no drill-first hint', ...m6, path: `/#/recipe/${PARIPPU}`, seed: { ...PAN_READY, ...ft }, open: (p) => p.locator('.recipe-card').waitFor(), primary: (p) => button(p, 'Cook it') },
  {
    // From the recipe card, as a player meets it. (A direct load of #/cook shows no hint yet: reported as a Step 10 carry.)
    label: 'cook mode: the drill-first hint', ...m6, cookMode: true, path: `/#/recipe/${PARIPPU}`, seed: PAN_READY,
    open: async (p) => { await p.locator('.drill-first').waitFor(); await button(p, 'Cook it').click(); await p.locator('.cook-progress').waitFor(); await p.locator('.drill-first').waitFor(); },
    primary: (p) => button(p, /Next step/),
  },
  // Market day: Marisol's errand plays an Okafor-Sato bean question; cook mode says what was swapped at the market.
  {
    label: 'visit marisol: the errand\'s stall question', ...m6, path: '/#/visit/marisol', seed: { ...PAN_READY, settings: AI_OFF(false), progress: { events: MARISOL_EVENTS as never, grants: [], base: null, pendingUpload: [] } },
    open: toErrandQuestion, primary: (p) => p.locator('.quest-errand-question .stall-option').first(),
  },
  {
    label: 'visit marisol (Family Table): the cook\'s lines, no errand', ...m6, path: '/#/visit/marisol', seed: { ...PAN_READY, ...ft, progress: { events: MARISOL_EVENTS as never, grants: [], base: null, pendingUpload: [] } },
    open: (p) => p.locator('.dialogue .dialogue-text .typed-full').waitFor(), primary: (p) => p.locator('.dialogue .dialogue-next'),
  },
  {
    label: 'cook mode: swapped at the market', ...m6, cookMode: true, path: `/#/cook/${PARIPPU}`, seed: marketWeek(false, { localWeek: { ...PARIPPU_WEEK, runs: [SWAPPED_RUN] } }), beforeGoto: atMarketNow(),
    open: (p) => p.locator('.stock-label').waitFor(), primary: (p) => button(p, /Next step/),
  },
  {
    label: 'cook mode (Family Table): swapped at the market', ...m6, cookMode: true, path: `/#/cook/${PARIPPU}`, seed: marketWeek(true, { localWeek: { ...PARIPPU_WEEK, runs: [SWAPPED_RUN] } }), beforeGoto: atMarketNow(),
    open: (p) => p.locator('.cook-progress').waitFor(), primary: (p) => button(p, /Next step/),
  },
];

export const SCREENS: ScreenCase[] = [
  { label: 'kitchen', path: '/', open: (p) => h1(p, 'Your kitchen'), primary: (p) => button(p, 'Go out to the world map') },
  {
    label: 'kitchen with the knife roll open', path: '/', seed: RUSTY_SEED,
    open: async (p) => { await button(p, 'Knife roll').click(); await p.getByRole('dialog', { name: 'Your knife roll' }).waitFor(); },
    primary: (p) => p.getByRole('dialog', { name: 'Your knife roll' }).getByRole('button', { name: 'Close' }),
  },
  { label: 'recipe shelf', path: '/#/recipes', open: (p) => p.locator('.shelf-item').first().waitFor(), primary: (p) => p.locator('.shelf-item a').first() },
  { label: 'recipe card (ok)', path: `/#/recipe/${PARIPPU}`, open: (p) => p.locator('.recipe-card').waitFor(), primary: (p) => button(p, 'Cook it') },
  {
    label: 'recipe card (blocked, severe rule)', path: `/#/recipe/${PARIPPU}`, seed: { v: 1, localRules: [coconutSevere] },
    open: (p) => p.locator('.recipe-card .recipe-status .chip[data-status="blocked"]').waitFor(), primary: (p) => button(p, 'Cook it'),
  },
  { label: 'map', path: '/#/map', open: (p) => p.locator('.map-pin').first().waitFor(), primary: (p) => button(p, LEELA_PIN) },
  { label: 'map with the travel permit open', path: '/#/map', open: openPermit, primary: (p) => button(p, 'Stamp it ✔') },
  {
    label: 'visit (dialogue showing)', path: '/#/visit/leela',
    open: (p) => p.locator('.dialogue .dialogue-text .typed-full').waitFor(), primary: (p) => p.locator('.dialogue .dialogue-next'),
  },
  {
    label: 'visit (a quest step: the errand)', loop: true, path: '/#/visit/leela',
    open: toQuestPanel, primary: (p) => p.locator('.quest-panel').getByRole('button', { name: "I've got it" }),
  },
  {
    label: 'visit with the recipe card open', path: '/#/visit/leela',
    open: async (p) => { await finishIntro(p); await button(p, 'See the recipe: Parippu').click(); await p.getByRole('dialog', { name: PARIPPU_TITLE }).waitFor(); },
    primary: (p) => p.getByRole('dialog', { name: PARIPPU_TITLE }).getByRole('button', { name: /Cook it/ }),
  },
  { label: 'cook mode step 1', path: `/#/cook/${PARIPPU}`, open: cookReady, primary: (p) => button(p, /Next step/) },
  {
    label: 'cook mode with a running timer', path: `/#/cook/${PARIPPU}`,
    open: async (p) => {
      await cookReady(p);
      await p.keyboard.press('ArrowRight');
      await p.locator('button.timer-start').first().click();
      await p.getByRole('group', { name: 'Running timers' }).waitFor();
    },
    primary: (p) => button(p, /Next step/),
  },
  {
    label: 'certificate', path: `/#/cook/${PARIPPU}`,
    open: async (p) => {
      await cookReady(p);
      for (let i = 0; i < 6; i++) await button(p, /Next step/).click();
      await button(p, /^Done/).click();
      await p.getByRole('dialog', { name: /Certificate of a Dish Cooked/ }).waitFor();
    },
    primary: (p) => p.getByRole('dialog', { name: /Certificate of a Dish Cooked/ }).getByRole('button', { name: 'Continue' }),
  },
  { label: 'settings (signed out)', mentor: true, path: '/#/settings', open: (p) => button(p, 'Send me a sign-in link').waitFor(), primary: (p) => button(p, 'Send me a sign-in link') },
  {
    label: 'settings (signed in)', mentor: true, path: '/#/settings',
    beforeGoto: signedInApi,
    open: async (p) => { await p.getByText('Signed in as cook@example.com').waitFor(); await p.locator('#set-ai-health:not([disabled])').waitFor(); },
    primary: (p) => button(p, 'Sign out'),
  },
  {
    label: 'settings: the ai_health notice open', mentor: true, path: '/#/settings',
    beforeGoto: signedInApi,
    open: async (p) => {
      await p.locator('#set-ai-health:not([disabled])').waitFor();
      await p.locator('#set-ai-health').click(); // the box stays unticked until "I agree"
      await p.locator('.ai-health-notice .consent-card').waitFor();
    },
    primary: (p) => p.locator('.ai-health-notice').getByRole('button', { name: 'I agree' }),
  },
  {
    label: 'settings: stopping health details (keep or delete)', mentor: true, path: '/#/settings',
    beforeGoto: async (page) => {
      await signedInApi(page);
      await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, {
        consents: [{ purpose: 'health_data', noticeVersion: 'v3', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true }],
        needsReconsent: [], notices: NOTICES,
      })));
    },
    open: async (p) => {
      await p.locator('#set-health-data:not([disabled])').waitFor();
      await p.locator('#set-health-data').click();
      await p.getByRole('group', { name: 'Stop keeping health details?' }).waitFor();
    },
    primary: (p) => button(p, 'Stop, and keep what is saved'),
  },
  { label: 'your rules', mentor: true, path: '/#/rules', seed: { ...PAN_READY, localRules: [coconutSevere] }, open: (p) => h1(p, 'Your rules'), primary: (p) => button(p, 'Add a rule') },
  {
    label: 'your rules: unreadable, with a 27-B card', mentor: true, path: '/#/rules', seed: { ...PAN_READY, localRules: [coconutSevere], rulesUnreadable: true },
    open: openRuleCard,
    primary: (p) => p.locator('.rules-card').getByRole('button', { name: 'Stamp it ✔' }),
  },
  {
    label: 'your rules: removing a severe rule', mentor: true, path: '/#/rules', seed: { ...PAN_READY, localRules: [coconutSevere] },
    open: async (p) => { await button(p, 'Remove').click(); await p.getByRole('dialog', { name: 'Removal of a Rule' }).waitFor(); },
    primary: (p) => p.getByRole('dialog', { name: 'Removal of a Rule' }).getByRole('button', { name: 'Remove', exact: true }),
  },
  {
    label: 'your rules (signed in, a device rule to copy)', mentor: true, path: '/#/rules', seed: { ...PAN_READY, localRules: [coconutSevere] }, beforeGoto: signedInApi,
    open: (p) => p.locator('.rules-copy').waitFor(),
    primary: (p) => button(p, 'Copy to my account'),
  },
  {
    label: 'mentor panel open (standard)', mentor: true, path: '/', seed: PAN_READY,
    open: async (p) => { await p.locator('#pan-button').click(); await p.locator('#pan-panel').waitFor(); },
    primary: (p) => p.locator('#pan-panel').getByRole('button', { name: 'Send', exact: true }),
  },
  {
    label: 'mentor panel, first open: AI disclosure and Form 1-A', mentor: true, path: '/',
    open: async (p) => {
      await p.locator('#pan-button').click();
      await p.locator('#pan-panel .pan-disclosure').waitFor();
      await p.locator('#pan-panel .intake-checklist').waitFor();
      await p.waitForFunction(() => document.querySelectorAll('#pan-panel .bubble.pan').length >= 2);
    },
    primary: (p) => p.locator('#pan-panel').getByRole('button', { name: 'Send', exact: true }),
  },
  {
    label: 'mentor panel: the intake consent card (signed in)', mentor: true, path: '/', seed: { aiDisclosureSeen: true, intake: { step: 'allergies' } }, beforeGoto: signedInApi,
    open: async (p) => {
      await p.waitForFunction(() => Boolean((JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as { account?: unknown }).account));
      await p.locator('#pan-button').click();
      await p.locator('#pan-panel .consent-card').waitFor();
    },
    primary: (p) => p.locator('#pan-panel .consent-card').getByRole('button', { name: 'I agree' }),
  },
  {
    label: 'mentor panel open (Family Table)', mentor: true, path: '/', seed: { settings: settings(true) },
    open: async (p) => { await p.locator('#pan-button').click(); await p.locator('#pan-panel').waitFor(); },
    primary: (p) => p.locator('#pan-panel .pan-close'),
  },
  {
    label: 'mentor panel: server cards of every kind and the M4 lines', path: '/', seed: PAN_READY, beforeGoto: serverCardsApi, mentor: true,
    open: async (p) => { await say(p, 'all the things', 9); await p.waitForFunction(() => document.querySelectorAll('#pan-panel .pan-card').length === 4); },
    primary: (p) => p.locator('#pan-panel').getByRole('button', { name: 'Send', exact: true }),
  },
  {
    label: 'mentor panel: capped chat (rate_limited) and a scripted rule card', path: '/', seed: PAN_READY, beforeGoto: cappedApi, mentor: true,
    open: async (p) => { await say(p, "I'm allergic to sesame", 2); await p.locator('#pan-panel .pan-card').waitFor(); },
    primary: (p) => p.locator('#pan-panel .pan-card').getByRole('button', { name: 'Stamp it ✔' }),
  },
  { label: 'plan (Form 7-W)', loop: true, countdown: true, path: '/#/plan', seed: WEEK_SEED, open: (p) => p.locator('.plan-item').first().waitFor(), primary: (p) => p.locator('.plan-save') },
  { label: 'market list (Form 12-M)', loop: true, countdown: true, path: '/#/market', seed: WEEK_SEED, open: (p) => p.locator('.market-tick').first().waitFor(), primary: (p) => button(p, "That's the shop done") },
  { label: 'pantry frame: the slot picker', loop: true, path: '/#/frame/fried-rice', seed: PAN_READY, open: (p) => p.locator('.frame-cook').waitFor(), primary: (p) => p.locator('.frame-cook') },
  { label: '/auth/verify', path: '/auth/verify?token=x', open: (p) => p.locator('#verify').waitFor(), primary: (p) => p.locator('#verify') },
  {
    label: '/auth/verify: the age screen', path: '/auth/verify?token=x', beforeGoto: ageRequired,
    open: openAgeScreen, primary: (p) => p.locator('#create-account'),
  },
  {
    label: '/auth/verify: under 16', path: '/auth/verify?token=x', beforeGoto: ageRequired,
    open: async (p) => {
      await openAgeScreen(p);
      await p.locator('#birth-year').selectOption(String(new Date().getFullYear() - 10));
      await p.locator('#create-account').click();
      await p.getByRole('link', { name: 'Back to the kitchen' }).waitFor();
    },
    primary: (p) => p.getByRole('link', { name: 'Back to the kitchen' }),
  },
  ...MARKET_SCREENS,
  { label: 'not found', path: '/#/no-such-page', open: (p) => h1(p, 'Not found'), primary: (p) => p.getByRole('link', { name: 'Back to the kitchen' }) },
  ...LOOP_SCREENS,
];

/** Open a screen the way a player meets it: load, then do what the case says. */
export async function openScreen(sc: ScreenCase, opts: { width?: number; reducedMotion?: boolean } = {}): Promise<OpenedApp> {
  const app = await openApp(sc.path, { reducedMotion: opts.reducedMotion ?? true, width: opts.width, seed: sc.seed, beforeGoto: sc.beforeGoto, initScript: sc.initScript });
  try {
    await sc.open?.(app.page);
  } catch (err) {
    await app.close();
    throw err;
  }
  return app;
}
