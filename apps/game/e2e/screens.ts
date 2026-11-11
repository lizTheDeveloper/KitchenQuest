import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright';
import { parse } from 'yaml';
import type { PlayerState } from '../src/state/store';
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
const coconutSevere = { id: 'r1', target: { kind: 'ingredient' as const, ids: ['coconut'] }, type: 'avoid' as const, severity: 'anaphylactic' as const };
const settings = (familyTable: boolean) => ({ showCalories: false, reducedMotion: 'system' as const, familyTable, iosNoteDismissed: false, aiMentor: true });
const h1 = (page: Page, text: string | RegExp) => page.locator('h1', { hasText: text }).first().waitFor();
const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name });
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
/** Done with Form 1-A and the AI disclosure (M4 Step 11), so a screen opens without the intake. */
const PAN_READY: Partial<PlayerState> = { intake: { step: 'done' }, aiDisclosureSeen: true };
const NOTICES = { health_data: { version: 'v2', text: 'We keep your allergies and diet rules so dishes can be checked.' }, ai_health: { version: 'v1', text: 'The AI may see your rules and meals.' } };
/** Signed in as cook@example.com with no rules and no consents. */
async function signedInApi(page: Page): Promise<void> {
  await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
  await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: [] })));
  await page.route((u) => u.pathname === '/api/me/consents', (r) => r.fulfill(json(200, { consents: [], needsReconsent: [], notices: NOTICES })));
}
const BOTH_CONSENTS = {
  consents: ['health_data', 'ai_health'].map((purpose) => ({ purpose, noticeVersion: purpose === 'health_data' ? 'v2' : 'v1', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true })),
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
    if (await button(page, 'Carry on with the quest').count()) break;
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
    label: 'visit (a quest step: the errand)', path: '/#/visit/leela',
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
        consents: [{ purpose: 'health_data', noticeVersion: 'v2', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true }],
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
  { label: 'not found', path: '/#/no-such-page', open: (p) => h1(p, 'Not found'), primary: (p) => p.getByRole('link', { name: 'Back to the kitchen' }) },
];

/** Open a screen the way a player meets it: load, then do what the case says. */
export async function openScreen(sc: ScreenCase, opts: { width?: number; reducedMotion?: boolean } = {}): Promise<OpenedApp> {
  const app = await openApp(sc.path, { reducedMotion: opts.reducedMotion ?? true, width: opts.width, seed: sc.seed, beforeGoto: sc.beforeGoto });
  try {
    await sc.open?.(app.page);
  } catch (err) {
    await app.close();
    throw err;
  }
  return app;
}
