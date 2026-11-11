// M4 Step 12: the free-forever promise (§16, never rule 1, pre-flight C6, C30). A player with no
// entitlements, at the daily AI cap, without ai_health, with the global AI budget spent or the AI
// off, keeps every safety and logging feature, and the mentor never answers with 402 or 403.
import { readFileSync } from 'node:fs';
import type { TurnResponse } from '@kitchenquest/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiProvider } from '../src/ai/provider.js';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { NOTICES } from '../src/consent/notices.js';
import { aiCostHours, auditEvents, usageEvents } from '../src/db/schema.js';
import { grant as grantEntitlement } from '../src/entitlements/entitlements.js';
import { WRITES_PER_DAY } from '../src/usage/write-cap.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { FREE_AI_TURNS_PER_DAY } from '../src/mentor/constants.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testAiEnv, testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { fakeAi, toolCall } from './helpers/fake-ai.js';

const catalog = defaultCatalog();
const NOW = new Date('2026-11-10T18:00:00Z');
const TODAY = '2026-11-10';
const HOUR = 3_600_000;
/** step-12.md: no response sells. */
const SELLS = /\b(guild|upgrade|subscri\w*|premium)\b|\$\s?\d/i;
const FREE_NOTICES = ['needs_ai_health', 'rate_limited', 'ai_off'];

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;
/** Every mentor turn's response body in this file. */
const turnBodies: string[] = [];

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
  await sql`delete from canon_recipes`;
  await syncCanon(db, RECIPES_DIR, catalog.graph, NOW);
});
afterAll(async () => {
  await closeDb?.();
});
beforeEach(async () => {
  mailer = new CaptureMailer();
  await sql`delete from ai_cost_hours`; // the global budget is spent only where a test says so
});
afterEach(async () => {
  await app?.close();
});

async function makeApp(ai: AiProvider | null) {
  const config = ai === null ? testConfig() : loadConfig(testAiEnv);
  app = await buildApp({ config, db, mailer, ai, now: () => NOW, logger: false });
}

/** Every response body in this file (fix round 1, M9: not only the mentor's). */
const allBodies: { url: string; body: string }[] = [];
async function call(cookie: string, opts: InjectOptions) {
  const res = await app.inject({ ...opts, cookies: { kq_session: cookie } });
  allBodies.push({ url: typeof opts.url === 'string' ? opts.url : '', body: res.body });
  return res;
}

/** No entitlements, the free cap used up in the last day. */
async function cappedFreePlayer() {
  const cookie = await signIn(app, mailer, `free${++seq}@example.com`);
  const userId = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  for (let i = 0; i < FREE_AI_TURNS_PER_DAY; i++) {
    await db.insert(usageEvents).values({ userId, feature: 'mentor_text', units: 1, costMicroUsd: 0, createdAt: new Date(NOW.getTime() - HOUR) });
  }
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entitlements where user_id = ${userId}`;
  expect(n).toBe(0);
  return { cookie, userId };
}

const grant = (cookie: string, purpose: 'health_data' | 'ai_health') =>
  call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose, noticeVersion: NOTICES[purpose]!.version } });

async function turn(cookie: string, text: string): Promise<TurnResponse> {
  const res = await call(cookie, {
    method: 'POST',
    url: '/mentor/turn',
    payload: { conversationId: null, input: { kind: 'text', text }, localDate: TODAY, localTime: '18:30', screen: null, intakeStep: null },
  });
  turnBodies.push(res.body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<TurnResponse>();
}

/** Everything §16 keeps free, for this player, with no AI involved. */
async function everyFreeFeature(cookie: string) {
  expect((await grant(cookie, 'health_data')).statusCode).toBe(201);
  const rule = await call(cookie, {
    method: 'POST',
    url: '/rules',
    payload: { rule: { target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' }, confirmed: true },
  });
  expect(rule.statusCode).toBe(201);
  const meal = await call(cookie, {
    method: 'POST',
    url: '/meals',
    payload: { meal: { eatenOn: TODAY, slot: 'breakfast', item: { kind: 'free', description: 'toast' } }, confirmed: true },
  });
  expect(meal.statusCode).toBe(201);
  const pantry = await call(cookie, {
    method: 'POST',
    url: '/pantry/changes',
    payload: { add: [{ name: 'rice', ingredientId: null }], removeNames: [], removeIds: [], confirmed: true },
  });
  expect(pantry.statusCode).toBe(200);
  expect((await call(cookie, { method: 'PUT', url: '/profile', payload: { marketDays: [6] } })).statusCode).toBe(200);
  // The recipe checks run for everyone: a coconut rule blocks nothing it shouldn't, and the check is there.
  const list = await call(cookie, { method: 'GET', url: `/recipes?date=${TODAY}` });
  expect(list.statusCode).toBe(200);
  expect(list.json<{ recipes: { check: { status: string } }[] }>().recipes.every((r) => typeof r.check.status === 'string')).toBe(true);
  const detail = await call(cookie, { method: 'GET', url: `/recipes/india/kerala/parippu?date=${TODAY}` });
  expect(detail.statusCode).toBe(200);
  expect(detail.json<{ check: { status: string } }>().check.status).toBe('blocked'); // parippu has coconut
  expect((await call(cookie, { method: 'GET', url: '/me/export' })).statusCode).toBe(200);
}

const deleteAccount = async (cookie: string) =>
  expect((await call(cookie, { method: 'DELETE', url: '/me', payload: { confirm: 'delete my account' } })).statusCode).toBe(204);

describe('free forever (§16)', () => {
  it('AI off and the global budget spent: every free feature works; the mentor is scripted (ai_off / needs_ai_health), never 402 or 403', async () => {
    await makeApp(null);
    await db.insert(aiCostHours).values({ hour: new Date(NOW.getTime() - HOUR), costMicroUsd: 1e9 }).onConflictDoNothing();
    const p = await cappedFreePlayer();
    await everyFreeFeature(p.cookie);
    const chat = await turn(p.cookie, 'what should I cook tonight?');
    expect(chat).toMatchObject({ route: 'scripted', notice: 'ai_off' });
    const health = await turn(p.cookie, "I'm allergic to sesame");
    expect(health.route).toBe('scripted');
    expect(FREE_NOTICES).toContain(health.notice);
    await deleteAccount(p.cookie);
  });

  it('AI on but the player is capped and has no ai_health: free features work; health text gets needs_ai_health, chat rate_limited', async () => {
    const ai = fakeAi([]);
    await makeApp(ai);
    const p = await cappedFreePlayer();
    await everyFreeFeature(p.cookie);
    expect(await turn(p.cookie, "I'm allergic to sesame")).toMatchObject({ route: 'scripted', notice: 'needs_ai_health' });
    expect(await turn(p.cookie, 'tell me a joke')).toMatchObject({ route: 'scripted', notice: 'rate_limited' });
    expect(ai.requests).toHaveLength(0);
    await deleteAccount(p.cookie);
  });

  it('AI help creating rules is never capped (C6): the capped player with ai_health gets a rule card; other chat is rate_limited', async () => {
    const ai = fakeAi([toolCall('propose_rule', { term: 'sesame', severity: 'allergy' })]);
    await makeApp(ai);
    const p = await cappedFreePlayer();
    expect((await grant(p.cookie, 'health_data')).statusCode).toBe(201);
    expect((await grant(p.cookie, 'ai_health')).statusCode).toBe(201);
    const rule = await turn(p.cookie, "I'm allergic to sesame");
    expect(rule.route).toBe('ai');
    expect(rule.cards.map((c) => c.card.kind)).toEqual(['rule']);
    const dinner = await turn(p.cookie, "what's for dinner?");
    expect(dinner).toMatchObject({ route: 'scripted', notice: 'rate_limited' });
    expect(ai.requests).toHaveLength(1);
  });

  it('no response body in this file sells (never rule 7), the export\'s processor register aside', () => {
    expect(allBodies.length).toBeGreaterThan(20);
    for (const { url, body } of allBodies) {
      let text = body;
      // The export lists every processor in the register, the planned payment provider ("Guild billing") included:
      // a legal disclosure (GDPR Art. 15(1)(c)), not an offer. Everything else in the export is scanned.
      if (url === '/me/export') {
        const { processors: _processors, ...rest } = JSON.parse(body) as Record<string, unknown>;
        text = JSON.stringify(rest);
      }
      expect(text, url).not.toMatch(SELLS);
    }
  });

  it('no mentor response in this file sells (never rule 7)', () => {
    expect(turnBodies.length).toBe(6);
    for (const b of turnBodies) expect(b).not.toMatch(SELLS);
  });
});

describe('the daily write limit is an abuse limit, the same for every plan (M4 final, ruling M-4)', () => {
  it('a Guild player meets the 200-a-day meal-log limit exactly where a free player does: it is never a paid feature', async () => {
    await makeApp(null);
    const limitFor = async (guild: boolean) => {
      const cookie = await signIn(app, mailer, `cap${++seq}@example.com`);
      const userId = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
      if (guild) await grantEntitlement(db, userId, 'guild', 'manual', new Date(NOW.getTime() - HOUR));
      expect((await grant(cookie, 'health_data')).statusCode).toBe(201);
      const at = new Date(NOW.getTime() - HOUR);
      const rows = (n: number) => Array.from({ length: n }, () => ({ at, actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'meals.create', target: 'x' }));
      const log = () => call(cookie, { method: 'POST', url: '/meals', payload: { meal: { eatenOn: TODAY, slot: 'breakfast', item: { kind: 'free', description: 'toast' } }, confirmed: true } });
      await db.insert(auditEvents).values(rows(WRITES_PER_DAY - 1));
      const last = await log();
      const over = await log();
      return [last.statusCode, over.statusCode];
    };
    expect(await limitFor(false)).toEqual([201, 429]);
    expect(await limitFor(true)).toEqual([201, 429]);
  });

  it('the limit reads no plan: the write-cap module never looks at entitlements', () => {
    const src = readFileSync(new URL('../src/usage/write-cap.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/entitlement|guild|GUILD|tier|plan/i);
  });
});
