// Step 7: one-click export (GDPR access/portability, C-7) and account delete
// (erasure, C-8), with crypto-shredding (C-4) and audit pseudonymization (C-5).
import { readFileSync } from 'node:fs';
import type { MarketRunView, MealCard } from '@kitchenquest/core';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pseudonymFor } from '../src/audit/audit.js';
import { NOTICES } from '../src/consent/notices.js';
import { open } from '../src/crypto/seal.js';
import { openFor } from '../src/crypto/userkeys.js';
import { ADVISORY_LOCK } from '../src/db/advisory-locks.js';
import { auditEvents, rules, userKeys } from '../src/db/schema.js';
import { grant } from '../src/entitlements/entitlements.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { recordUsage } from '../src/usage/usage.js';
import { appendMessages, openConversation, type StoredMessage } from '../src/mentor/conversations.js';
import { MemoryHistory } from '../src/mentor/memory.js';
import { createProposal, markDecided } from '../src/mentor/proposals.js';
import { defaultCatalog } from '../src/catalog.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testAiEnv, testConfig } from './helpers/config.js';
import { loadConfig } from '../src/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { fakeAi } from './helpers/fake-ai.js';
import { captureLogs } from './helpers/logs.js';

const config = testConfig();
const NOW = new Date('2026-11-09T12:00:00Z');
const PHRASE = 'delete my account';

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
  await syncCanon(db, RECIPES_DIR, defaultCatalog().graph, NOW);
});
afterAll(async () => {
  await closeDb?.();
});
beforeEach(async () => {
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false });
});
afterEach(async () => {
  await app?.close();
});

const call = (cookie: string | null, opts: InjectOptions) =>
  app.inject({ ...opts, ...(cookie ? { cookies: { kq_session: cookie } } : {}) });

const PEANUT = { target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' };
const DAIRY = {
  target: { kind: 'ingredient', ids: ['milk'] },
  type: 'avoid',
  severity: 'intolerance',
  note: 'lactose',
};
const MEAL = { eatenOn: '2026-11-09', slot: 'lunch', item: { kind: 'free', description: 'peanut noodles' } };
const PANTRY_ITEM = { name: 'Lactose-free milk', ingredientId: 'milk' };
const PROFILE = {
  marketDays: [2, 6],
  mealsPerWeek: 10,
  country: 'GB',
  region: 'Yorkshire',
  mealWindows: [{ name: 'dinner', start: '18:00', end: '20:00' }],
};

// A plan for the profile's plan week (market Tuesday and Saturday → weeks start on Tuesday, 2026-11-03), M5 Step 6.
const PLAN = { weekStart: '2026-11-03', items: [{ day: 6, kind: 'dish', slug: 'japan/osaka/onigiri', servings: 2 }], hard: false, slot: 'unanswered' };
const NOTE = { recipe: 'japan/osaka/onigiri', ops: [{ op: 'swap', from: 'umeboshi', to: 'oat milk' }], text: 'secret note words', at: '2026-11-09' };
const SHARED = { cookedOn: '2026-11-09', recipe: 'japan/osaka/onigiri', frame: null, cookedFor: { count: 'one', who: 'partner' } };
const MARKET_EVENT = { id: '6f1c2b7e-0d3a-4c55-9b8e-1a2b3c4d5e6f', kind: 'market_run', at: '2026-11-09', weekStart: '2026-11-09' };
const MEAL_EVENT_ID = '7a2d3c8f-1e4b-4d66-8c9f-2b3c4d5e6f70';

const SAID: StoredMessage = { role: 'player', text: 'I had peanut noodles for lunch' };
const PAN_SAID: Extract<StoredMessage, { role: 'pan' }> = { role: 'pan', parts: [{ kind: 'line', line: { trigger: 'log.confirm', vars: {} } }], proposalIds: [] };
const MEAL_CARD: MealCard = { kind: 'meal', meal: MEAL as MealCard['meal'], summary: 'lunch: peanut noodles', estimate: false, readback: [] };

interface Player {
  cookie: string;
  id: string;
  email: string;
  ruleIds: string[];
  conversationId: string;
  proposalId: string;
}

/** A player with a row in every user-linked table: profile, consent, rules (and so a data key), reads, entitlement, usage. */
async function fullPlayer(): Promise<Player> {
  const email = `acct${++seq}@example.com`;
  const cookie = await signIn(app, mailer, email);
  const me = await call(cookie, { method: 'GET', url: '/me' });
  const id = me.json<{ id: string }>().id;
  expect(
    (
      await call(cookie, {
        method: 'POST',
        url: '/me/consents',
        payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version },
      })
    ).statusCode,
  ).toBe(201);
  expect((await call(cookie, { method: 'PUT', url: '/profile', payload: PROFILE })).statusCode).toBe(200);
  const ruleIds: string[] = [];
  for (const rule of [PEANUT, DAIRY]) {
    const res = await call(cookie, { method: 'POST', url: '/rules', payload: { rule, confirmed: true } });
    expect(res.statusCode).toBe(201);
    ruleIds.push(res.json<{ rule: { id: string } }>().rule.id);
  }
  const meal = await call(cookie, { method: 'POST', url: '/meals', payload: { meal: MEAL, confirmed: true } });
  expect(meal.statusCode).toBe(201);
  const pantry = await call(cookie, {
    method: 'POST',
    url: '/pantry/changes',
    payload: { add: [PANTRY_ITEM], removeNames: [], removeIds: [], confirmed: true },
  });
  expect(pantry.statusCode).toBe(200);
  // A weekly plan and its market run, one row ticked (H-11, M5 Step 6).
  expect((await call(cookie, { method: 'PUT', url: `/plans/${PLAN.weekStart}`, payload: { plan: PLAN, confirmed: true } })).statusCode).toBe(200);
  const run = (await call(cookie, { method: 'POST', url: '/market-runs', payload: { weekStart: PLAN.weekStart } })).json<MarketRunView>();
  const umeboshi = run.items.find((i) => i.name === 'umeboshi')!;
  expect((await call(cookie, { method: 'POST', url: `/market-runs/${run.id}/ticks`, payload: { key: umeboshi.key, ticked: true } })).statusCode).toBe(200);
  // A margin note (H-12) and a Shared Table row (H-13), M5 Step 7.
  expect((await call(cookie, { method: 'POST', url: '/notes', payload: { note: NOTE, confirmed: true } })).statusCode).toBe(201);
  expect((await call(cookie, { method: 'POST', url: '/shared-table', payload: { entry: SHARED, confirmed: true } })).statusCode).toBe(201);
  // Progress (U-5): a market run and a meal-log event, each earning grants (no catalogue needed for either).
  // The meal-log event names the meal log just made (I1).
  const mealLogId = meal.json<{ meal: { id: string } }>().meal.id;
  const events = [MARKET_EVENT, { id: MEAL_EVENT_ID, kind: 'meal_logged', at: '2026-11-09', minute: 750, mealLogId }];
  const progress = await call(cookie, { method: 'POST', url: '/progress/events', payload: { events } });
  expect(progress.statusCode).toBe(200);
  expect(progress.json<{ accepted: unknown[] }>().accepted).toHaveLength(2);
  expect((await call(cookie, { method: 'GET', url: '/rules' })).statusCode).toBe(200);
  await grant(db, id, 'founding', 'manual', new Date('2026-01-01T00:00:00Z'));
  await recordUsage(db, id, 'mentor_text', 3, 120);
  await recordUsage(db, id, 'mentor_text', 2, 80);
  await recordUsage(db, id, 'ingest', 1, 500);
  // A Pan conversation with a sealed transcript and a decided proposal (no route yet: Step 7).
  const memory = new MemoryHistory({ ttlMs: 60_000, max: 8 });
  const { conversationId, proposalId } = await db.transaction(async (tx) => {
    const c = await openConversation(tx, id, null, NOW);
    const card = await createProposal(tx, config.keyring, { userId: id, conversationId: c.id, turnSeq: 1, card: MEAL_CARD }, NOW);
    await appendMessages(tx, config.keyring, memory, id, c.id, [SAID, { ...PAN_SAID, proposalIds: [card.proposalId] }], true, NOW);
    await markDecided(tx, card.proposalId, 'confirmed', 'tap', null, { secret: 'undo-payload' }, config.keyring, id, NOW);
    return { conversationId: c.id, proposalId: card.proposalId };
  });
  return { cookie, id, email, ruleIds, conversationId, proposalId };
}

const exportOf = (cookie: string | null) => call(cookie, { method: 'GET', url: '/me/export' });
const deleteAccount = (cookie: string | null, payload?: unknown) =>
  call(cookie, { method: 'DELETE', url: '/me', ...(payload === undefined ? {} : { payload: payload as object }) });

/** Every table in the schema, with how many rows mention `needle` in any column (row cast to text). */
async function mentions(needle: string): Promise<Record<string, number>> {
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
  const out: Record<string, number> = {};
  for (const { table_name: t } of tables) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from ${sql(t)} as r where position(lower(${needle}) in lower(r::text)) > 0`;
    out[t] = row.n;
  }
  return out;
}

const nowhere = (counts: Record<string, number>) => Object.fromEntries(Object.keys(counts).map((t) => [t, 0]));

describe('GET /me/export', () => {
  it('needs a session', async () => {
    expect((await exportOf(null)).statusCode).toBe(401);
  });

  it('downloads every stored field as a JSON attachment, with the rules decrypted', async () => {
    const p = await fullPlayer();
    const res = await exportOf(p.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="kitchen-quest-export.json"');
    const x = res.json();

    expect(x.exportedAt).toBe(NOW.toISOString());
    expect(x.user).toEqual({
      id: p.id,
      email: p.email,
      createdAt: NOW.toISOString(),
      ageConfirmedAt: NOW.toISOString(),
    });
    expect(x.profile).toEqual({ ...PROFILE, updatedAt: expect.any(String) });
    // Both rules carry the same (fixed) clock time, so their order is not asserted.
    expect(x.rules).toHaveLength(2);
    expect(x.rules).toEqual(
      expect.arrayContaining([
        { ...PEANUT, id: p.ruleIds[0], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
        { ...DAIRY, id: p.ruleIds[1], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
      ]),
    );
    expect(x.consents).toEqual([
      expect.objectContaining({
        purpose: 'health_data',
        noticeVersion: NOTICES.health_data!.version,
        withdrawnAt: null,
      }),
    ]);
    expect(x.entitlements).toEqual([
      {
        kind: 'founding',
        source: 'manual',
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: null,
        createdAt: expect.any(String),
      },
    ]);
    expect(x.usage).toEqual([
      {
        feature: 'ingest',
        events: 1,
        units: 1,
        costMicroUsd: 500,
        firstAt: expect.any(String),
        lastAt: expect.any(String),
      },
      {
        feature: 'mentor_text',
        events: 2,
        units: 5,
        costMicroUsd: 200,
        firstAt: expect.any(String),
        lastAt: expect.any(String),
      },
    ]);
    expect(x.selfReadCounts).toEqual([{ resource: 'rules', day: '2026-11-09', count: 1 }]);
    expect(x.sessions).toEqual([{ createdAt: expect.any(String), expiresAt: expect.any(String) }]);
    expect(x.loginTokens).toEqual([
      { createdAt: expect.any(String), expiresAt: expect.any(String), usedAt: NOW.toISOString() },
    ]);
    expect(x.dataKey).toEqual({ keyId: config.keyring.activeId, createdAt: expect.any(String) });

    const actions = (x.auditEvents as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual([
      'auth.sign_in',
      'consent.grant',
      'rules.create',
      'rules.create',
      'meals.create',
      'pantry.change',
      'plan.save',
      'market_run.create',
      'pantry.change',
      'notes.create',
      'shared_table.create',
      'progress.record',
      'account.export',
    ]);
    // Pan conversations with their messages, and proposals, decrypted (C-12).
    expect(x.conversations).toEqual([
      {
        id: p.conversationId,
        startedAt: NOW.toISOString(),
        lastTurnAt: NOW.toISOString(),
        turnSeq: 0,
        messages: [
          { seq: 1, createdAt: NOW.toISOString(), ...SAID },
          { seq: 2, createdAt: NOW.toISOString(), ...PAN_SAID, proposalIds: [p.proposalId] },
        ],
      },
    ]);
    expect(x.proposals).toEqual([
      {
        id: p.proposalId,
        conversationId: p.conversationId,
        turnSeq: 1,
        kind: 'meal',
        severe: false,
        status: 'confirmed',
        card: MEAL_CARD,
        createdAt: NOW.toISOString(),
        expiresAt: expect.any(String),
        decidedAt: NOW.toISOString(),
      },
    ]);
    expect(res.body).not.toContain('undo-payload');
    // Meals and pantry, decrypted.
    expect(x.meals).toEqual([{ ...MEAL, id: expect.any(String), createdAt: NOW.toISOString() }]);
    expect(x.pantry).toHaveLength(2);
    expect(x.pantry).toEqual(
      expect.arrayContaining([
        { ...PANTRY_ITEM, id: expect.any(String), createdAt: NOW.toISOString() },
        { name: 'umeboshi', ingredientId: expect.anything(), addedOn: '2026-11-09', source: 'market', id: expect.any(String), createdAt: NOW.toISOString() },
      ]),
    );
    const bought = (x.pantry as { id: string; name: string }[]).find((i) => i.name === 'umeboshi')!;
    // Plans and market runs (H-11, M5 Step 6), decrypted, with the pantry row each tick added.
    expect(x.plans).toEqual([{ ...PLAN, id: expect.any(String), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }]);
    // Margin notes and the Shared Table (H-12, H-13), decrypted.
    expect(x.marginNotes).toEqual([{ ...NOTE, id: expect.any(String), createdAt: NOW.toISOString() }]);
    expect(x.sharedTable).toEqual([{ ...SHARED, id: expect.any(String), createdAt: NOW.toISOString() }]);
    // The C-45 subject columns are listed with each consent (always 'user' and null until M13).
    expect(x.consents.length).toBeGreaterThan(0);
    for (const c of x.consents) expect(c).toMatchObject({ subjectKind: 'user', subjectId: null });
    expect(x.marketRuns).toHaveLength(1);
    expect(x.marketRuns[0]).toMatchObject({ weekStart: PLAN.weekStart, planId: x.plans[0].id, doneAt: null, createdAt: NOW.toISOString() });
    expect(x.marketRuns[0].pantryIds).toEqual({ [x.marketRuns[0].items.find((i: { name: string }) => i.name === 'umeboshi').key]: bought.id });
    expect((x.marketRuns[0].items as { name: string; ticked: boolean }[]).filter((i) => i.ticked).map((i) => i.name)).toEqual(['umeboshi']);
    // Progress (U-5): both ledgers as stored, and the view derived from them.
    expect(x.progress.events).toEqual([
      { ...MARKET_EVENT, createdAt: NOW.toISOString() },
      { id: MEAL_EVENT_ID, kind: 'meal_logged', at: '2026-11-09', minute: 750, mealLogId: x.meals[0].id, createdAt: NOW.toISOString() },
    ]);
    // Grants carry their day only, no time (I2).
    const M = MARKET_EVENT.id;
    expect(x.progress.grants).toEqual(
      expect.arrayContaining([
        { id: `${M}#0`, eventId: M, isoDay: '2026-11-09', kind: 'xp', amount: 20, reason: 'market_run' },
        { id: `${M}#1`, eventId: M, isoDay: '2026-11-09', kind: 'stamp', stamp: 'market_run' },
        { id: `${MEAL_EVENT_ID}#0`, eventId: MEAL_EVENT_ID, isoDay: '2026-11-09', kind: 'xp', amount: 5, reason: 'nourishment' },
      ]),
    );
    expect(x.progress.grants).toHaveLength(3);
    expect(x.progress.view).toMatchObject({ xp: 25, level: 1, stamps: 1 });
    expect(x.auditEvents[0]).toEqual({
      at: NOW.toISOString(),
      actorKind: 'user',
      action: 'auth.sign_in',
      target: null,
      requestId: expect.any(String),
    });

    // Art. 15 recipients: only processors that receive user data, each labelled with where it stands.
    const register = JSON.parse(
      readFileSync(new URL('../../../docs/compliance/processors.json', import.meta.url), 'utf8'),
    ) as {
      processors: {
        id: string;
        name: string;
        purpose: string;
        country: string;
        contact: string;
        status: string;
        data_categories: string[];
      }[];
    };
    const receiving = register.processors.filter((r) => !r.data_categories.every((c) => /^none\b/i.test(c)));
    expect(receiving.map((r) => r.id)).not.toContain('pixellab');
    expect(x.processors).toEqual(
      receiving.map(({ id, name, purpose, country, contact, status }) => ({
        name,
        purpose,
        country,
        contact,
        status,
        // The AI is off on this app, but this player has model turns on record (mentor_text usage): the AI
        // processors received their data, so they are listed in use, with the period (Art. 15(1)(c)).
        inUse: !/^planned\b/i.test(status),
        detailsConfirmed: !/\[verify|\bTBD\b/i.test(`${name} ${country} ${contact}`),
        ...(id.startsWith('openrouter') ? { sentFrom: expect.any(String), sentUntil: expect.any(String) } : {}),
      })),
    );
    expect(x.processors).toContainEqual(
      expect.objectContaining({ name: 'OpenRouter', inUse: true, detailsConfirmed: false }),
    );

    // Secrets and ciphertext stay out: no token hashes, wrapped key or sealed blobs.
    expect(res.body).not.toMatch(/tokenHash|token_hash|wrapped|sealed/);
  });

  it('lists the AI processors as not in use for a player with no model turn, on a server with the AI off', async () => {
    const cookie = await signIn(app, mailer, 'export-ai-never@example.com');
    const listed = (await call(cookie, { method: 'GET', url: '/me/export' })).json<{ processors: { name: string; inUse: boolean; sentFrom?: string }[] }>().processors;
    expect(listed.find((p) => p.name === 'OpenRouter')).toMatchObject({ inUse: false });
    expect(listed.find((p) => p.name === 'OpenRouter')!.sentFrom).toBeUndefined();
  });

  it('lists the AI processors as in use, with the period, for a player whose turns reached the model, even with the AI off now (Art. 15(1)(c))', async () => {
    const cookie = await signIn(app, mailer, 'export-ai-past@example.com');
    const userId = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
    const first = new Date('2026-11-01T10:00:00Z');
    const last = new Date('2026-11-05T10:00:00Z');
    await recordUsage(db, userId, 'mentor_text', 1, 50, first);
    await recordUsage(db, userId, 'mentor_text', 1, 50, last);
    const listed = (await call(cookie, { method: 'GET', url: '/me/export' })).json<{ processors: { name: string; inUse: boolean; sentFrom?: string; sentUntil?: string }[] }>().processors;
    expect(listed.find((p) => p.name === 'OpenRouter')).toMatchObject({ inUse: true, sentFrom: first.toISOString(), sentUntil: last.toISOString() });
    expect(listed.find((p) => p.name.startsWith('Model providers'))).toMatchObject({ inUse: true });
  });

  it('m-2: with the AI configured but held off by the I-3 eval gate (no provider built), the AI processors are not in use for a player with no model turn', async () => {
    const gated = await buildApp({ config: loadConfig(testAiEnv), db, mailer, ai: null, now: () => NOW, logger: false });
    try {
      const cookie = await signIn(gated, mailer, 'export-ai-gated@example.com');
      const res = await gated.inject({ method: 'GET', url: '/me/export', cookies: { kq_session: cookie } });
      expect(res.statusCode).toBe(200);
      const listed = res.json<{ processors: { name: string; inUse: boolean }[] }>().processors;
      expect(listed.find((p) => p.name === 'OpenRouter')).toMatchObject({ inUse: false });
      expect(listed.find((p) => p.name.startsWith('Model providers'))).toMatchObject({ inUse: false });
    } finally {
      await gated.close();
    }
  });

  it('lists the AI processors as in use only on a server with the AI on (M4: built, but off in production until the DPA)', async () => {
    const aiApp = await buildApp({ config: loadConfig(testAiEnv), db, mailer, ai: fakeAi([]), now: () => NOW, logger: false });
    try {
      const cookie = await signIn(aiApp, mailer, 'export-ai-on@example.com');
      const res = await aiApp.inject({ method: 'GET', url: '/me/export', cookies: { kq_session: cookie } });
      expect(res.statusCode).toBe(200);
      const listed = res.json<{ processors: { name: string; inUse: boolean }[] }>().processors;
      expect(listed.find((p) => p.name === 'OpenRouter')).toMatchObject({ inUse: true });
    } finally {
      await aiApp.close();
    }
  });

  it('stamps every created/updated time from the injected clock, not the database or wall clock (M-3)', async () => {
    const CLOCK = new Date('2021-03-04T05:06:07.000Z');
    const at = CLOCK.toISOString();
    const own = await buildApp({ config, db, mailer, ai: null, now: () => CLOCK, logger: false });
    try {
      const req = (cookie: string | null, opts: InjectOptions) =>
        own.inject({ ...opts, ...(cookie ? { cookies: { kq_session: cookie } } : {}) });
      const cookie = await signIn(own, mailer, `clock${++seq}@example.com`);
      const id = (await req(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
      const consent = await req(cookie, {
        method: 'POST',
        url: '/me/consents',
        payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version },
      });
      expect(consent.statusCode).toBe(201);
      expect((await req(cookie, { method: 'GET', url: '/profile' })).statusCode).toBe(200);
      expect((await req(cookie, { method: 'PUT', url: '/profile', payload: PROFILE })).statusCode).toBe(200);
      const ruleId = (await req(cookie, { method: 'POST', url: '/rules', payload: { rule: PEANUT, confirmed: true } })).json().rule.id;
      expect((await req(cookie, { method: 'PUT', url: `/rules/${ruleId}`, payload: { rule: DAIRY, confirmed: true } })).statusCode).toBe(200);
      await grant(db, id, 'founding', 'manual', CLOCK, undefined, CLOCK);
      await recordUsage(db, id, 'ingest', 1, 1, CLOCK);
      const x = (await req(cookie, { method: 'GET', url: '/me/export' })).json();
      expect(x.user.createdAt).toBe(at);
      expect(x.profile.updatedAt).toBe(at);
      expect(x.rules).toEqual([expect.objectContaining({ createdAt: at, updatedAt: at })]);
      expect(x.entitlements[0].createdAt).toBe(at);
      expect(x.usage[0]).toMatchObject({ firstAt: at, lastAt: at });
      expect(x.sessions).toEqual([expect.objectContaining({ createdAt: at })]);
      expect(x.loginTokens).toEqual([expect.objectContaining({ createdAt: at })]);
      expect(x.dataKey.createdAt).toBe(at);
    } finally {
      await own.close();
    }
  });

  it('writes an account.export audit event', async () => {
    const p = await fullPlayer();
    await exportOf(p.cookie);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, p.id));
    expect(events.filter((e) => e.action === 'account.export')).toEqual([
      expect.objectContaining({ actorKind: 'user', actorId: p.id, at: NOW }),
    ]);
  });

  it("never includes another player's data", async () => {
    const a = await fullPlayer();
    const b = await fullPlayer();
    const x = (await exportOf(a.cookie)).json();
    expect((x.rules as { id: string }[]).map((r) => r.id).sort()).toEqual([...a.ruleIds].sort());
    const text = JSON.stringify(x);
    expect(text).not.toContain(b.id);
    expect(text).not.toContain(b.email);
    for (const id of b.ruleIds) expect(text).not.toContain(id);
  });

  it('covers every table linked to a user (so a new table cannot be forgotten)', async () => {
    // Export key for each user-linked table. A new table fails this test until the export includes it.
    const EXPORT_KEY: Record<string, string> = {
      users: 'user',
      profiles: 'profile',
      rules: 'rules',
      consents: 'consents',
      entitlements: 'entitlements',
      usage_events: 'usage',
      self_read_counts: 'selfReadCounts',
      sessions: 'sessions',
      login_tokens: 'loginTokens',
      user_keys: 'dataKey',
      meal_logs: 'meals',
      pantry_items: 'pantry',
      meal_plans: 'plans',
      market_runs: 'marketRuns',
      margin_notes: 'marginNotes',
      shared_table: 'sharedTable',
      conversations: 'conversations',
      messages: 'conversations',
      mentor_proposals: 'proposals',
      progress_events: 'progress',
      reward_grants: 'progress',
      audit_events: 'auditEvents',
    };
    // Linked: a foreign key to users, or a column that holds a user id or an email.
    const linked = await sql<{ table_name: string }[]>`
      select distinct c.table_name from information_schema.columns c
      where c.table_schema = 'public'
        and (c.column_name in ('id', 'email', 'actor_id') or c.column_name like '%user_id')
        and (c.table_name = 'users' or c.column_name <> 'id')
      union
      select distinct tc.table_name from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public' and ccu.table_name = 'users'
      order by 1`;
    const tables = linked.map((r) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(['users', 'login_tokens', 'audit_events', 'rules']));
    expect(
      tables.filter((t) => !(t in EXPORT_KEY)),
      'user-linked tables missing from the export',
    ).toEqual([]);

    const p = await fullPlayer();
    const x = (await exportOf(p.cookie)).json<Record<string, unknown>>();
    for (const t of tables) {
      const v = x[EXPORT_KEY[t]];
      const present = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined;
      expect(present, `export.${EXPORT_KEY[t]} (table ${t})`).toBe(true);
    }
  });

  it('keeps the email and health data out of the log', async () => {
    const logs = captureLogs();
    await app.close();
    app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: logs.logger });
    const p = await fullPlayer();
    expect((await exportOf(p.cookie)).statusCode).toBe(200);
    expect((await deleteAccount(p.cookie, { confirm: PHRASE })).statusCode).toBe(204);
    expect(logs.text()).not.toContain(p.email);
    expect(logs.text()).not.toMatch(/peanut|lactose/i);
    expect(logs.text()).not.toContain(PHRASE);
  });
});

describe('DELETE /me', () => {
  it('needs a session', async () => {
    expect((await deleteAccount(null, { confirm: PHRASE })).statusCode).toBe(401);
  });

  it.each([
    ['no body', undefined],
    ['no phrase', {}],
    ['a wrong phrase', { confirm: 'delete' }],
    ['the phrase in other case', { confirm: 'Delete my account' }],
    ['a non-string', { confirm: true }],
  ])('refuses %s with 400 confirmation_required and deletes nothing', async (_label, payload) => {
    const p = await fullPlayer();
    const before = await mentions(p.id);
    const res = await deleteAccount(p.cookie, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'confirmation_required', message: expect.any(String) } });
    expect(await mentions(p.id)).toEqual(before);
    expect((await call(p.cookie, { method: 'GET', url: '/me' })).statusCode).toBe(200);
  });

  it('deletes the account: 204, cookie cleared, the id and email in no table, the old session refused', async () => {
    const p = await fullPlayer();
    const other = await fullPlayer();
    const otherBefore = { id: await mentions(other.id), email: await mentions(other.email) };
    // A second session and a pending sign-in link for the same email.
    const second = await signIn(app, mailer, p.email);
    expect((await call(null, { method: 'POST', url: '/auth/request', payload: { email: p.email } })).statusCode).toBe(
      202,
    );
    expect((await mentions(p.email)).login_tokens).toBe(3);

    const res = await deleteAccount(p.cookie, { confirm: PHRASE });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === 'kq_session');
    expect(cleared).toMatchObject({ value: '', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
    expect(cleared!.expires!.getTime()).toBeLessThanOrEqual(Date.now());

    const byId = await mentions(p.id);
    expect(byId).toEqual(nowhere(byId));
    // Meal logs and pantry rows go with the account (P-14).
    expect(await sql`select 1 from meal_logs where user_id = ${p.id}`).toHaveLength(0);
    expect(await sql`select 1 from pantry_items where user_id = ${p.id}`).toHaveLength(0);
    // And every mentor row (P-14).
    // Both progress ledgers go with the account (U-5): events and grants alike.
    for (const t of ['progress_events', 'reward_grants', 'meal_plans', 'market_runs', 'margin_notes', 'shared_table']) {
      expect(await sql`select 1 from ${sql(t)} where user_id = ${p.id}`, t).toHaveLength(0);
    }
    for (const t of ['conversations', 'messages', 'mentor_proposals']) {
      expect(await sql`select 1 from ${sql(t)} where user_id = ${p.id}`, t).toHaveLength(0);
    }
    const byEmail = await mentions(p.email);
    expect(byEmail).toEqual(nowhere(byEmail));

    for (const cookie of [p.cookie, second]) {
      expect((await call(cookie, { method: 'GET', url: '/me' })).statusCode).toBe(401);
      expect((await exportOf(cookie)).statusCode).toBe(401);
    }
    // The other player is untouched.
    expect({ id: await mentions(other.id), email: await mentions(other.email) }).toEqual(otherBefore);
    expect((await call(other.cookie, { method: 'GET', url: '/rules' })).json().rules).toHaveLength(2);
  });

  it('keeps the security trail under a pseudonym, account.delete event included', async () => {
    const p = await fullPlayer();
    const count = (await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, p.id))).length;
    expect((await deleteAccount(p.cookie, { confirm: PHRASE })).statusCode).toBe(204);

    const pseudonym = pseudonymFor(config.pseudonymKey, p.id);
    const trail = await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, pseudonym)).orderBy(asc(auditEvents.id));
    expect(trail).toHaveLength(count + 1);
    expect(trail.every((e) => e.actorId === pseudonym)).toBe(true);
    expect(trail.at(-1)).toMatchObject({ action: 'account.delete', actorKind: 'user', at: NOW });
  });

  it('crypto-shreds sealed data: a copied blob cannot be opened, even with the key ring', async () => {
    const p = await fullPlayer();
    // What a backup taken before the delete would hold.
    const backup = await db.select({ id: rules.id, sealed: rules.sealed }).from(rules).where(eq(rules.userId, p.id));
    expect(backup).toHaveLength(2);
    const ctx = (rowId: string) => ({ table: 'rules', userId: p.id, rowId });
    await expect(openFor(db, config.keyring, ctx(backup[0].id), backup[0].sealed)).resolves.toMatchObject(PEANUT);

    expect((await deleteAccount(p.cookie, { confirm: PHRASE })).statusCode).toBe(204);

    expect(await db.select().from(userKeys).where(eq(userKeys.userId, p.id))).toHaveLength(0);
    for (const row of backup) {
      await expect(openFor(db, config.keyring, ctx(row.id), row.sealed)).rejects.toThrow(/no data key/);
      // The ring keys alone open nothing: the blob was sealed with the user's own (now deleted) data key.
      expect(() => open(row.sealed, config.keyring.all)).toThrow();
    }
  });

  it('lets the same email start a fresh, empty account afterwards', async () => {
    const p = await fullPlayer();
    expect((await deleteAccount(p.cookie, { confirm: PHRASE })).statusCode).toBe(204);
    const cookie = await signIn(app, mailer, p.email);
    const me = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>();
    expect(me.id).not.toBe(p.id);
    const x = (await exportOf(cookie)).json();
    expect(x.rules).toEqual([]);
    expect(x.consents).toEqual([]);
    expect(x.profile).toBeNull();
  });

  it('is all or nothing: if pseudonymizing fails, nothing is deleted, and the log names no one', async () => {
    const logs = captureLogs();
    await app.close();
    app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: logs.logger });
    const p = await fullPlayer();
    const before = await mentions(p.id);
    await sql`create function fail_audit_update() returns trigger language plpgsql as $$
      begin raise exception 'simulated failure'; end $$`;
    await sql`create trigger fail_audit_update before update on audit_events for each row execute function fail_audit_update()`;
    try {
      const res = await deleteAccount(p.cookie, { confirm: PHRASE });
      expect(res.statusCode).toBe(500);
    } finally {
      await sql`drop trigger fail_audit_update on audit_events`;
      await sql`drop function fail_audit_update()`;
    }
    expect(await mentions(p.id)).toEqual(before);
    expect((await call(p.cookie, { method: 'GET', url: '/me' })).statusCode).toBe(200);
    expect(logs.text()).toContain('simulated failure');
    expect(logs.text()).not.toContain(p.email);
    expect(logs.text()).not.toContain(p.id);
    expect(logs.text()).not.toContain(config.pseudonymKey.bytes.toString('hex'));
  });

  it('refuses a text/plain body with 415 and deletes nothing', async () => {
    const p = await fullPlayer();
    const res = await call(p.cookie, {
      method: 'DELETE',
      url: '/me',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ confirm: PHRASE }),
    });
    expect(res.statusCode).toBe(415);
    expect((await call(p.cookie, { method: 'GET', url: '/me' })).statusCode).toBe(200);
  });
});

/** Waits until `n` backends in this database are blocked on a lock (of `kind`, if given). */
async function waitForLockWaiters(n: number, kind?: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and (${kind ?? null}::text is null or wait_event = ${kind ?? null})`;
    if (row.n >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${n} lock waiter(s)`);
}

describe('export and delete under concurrency', () => {
  it('an export racing a delete leaves no raw id in the audit trail', async () => {
    const p = await fullPlayer();
    // Pause the export after its audit insert: its next read (profiles) waits on this lock.
    const blocker = await sql.reserve();
    try {
      await blocker`begin`;
      await blocker`lock table profiles in access exclusive mode`;
      const exporting = exportOf(p.cookie);
      await waitForLockWaiters(1);
      const deleting = deleteAccount(p.cookie, { confirm: PHRASE });
      await waitForLockWaiters(2);
      await blocker`commit`;
      const [exp, del] = await Promise.all([exporting, deleting]);
      expect(exp.statusCode).toBe(200);
      expect(del.statusCode).toBe(204);
    } finally {
      await blocker`rollback`.catch(() => {});
      blocker.release();
    }
    const byId = await mentions(p.id);
    expect(byId).toEqual(nowhere(byId));
    const pseudonym = pseudonymFor(config.pseudonymKey, p.id);
    const actions = (await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, pseudonym)).orderBy(asc(auditEvents.id))).map(
      (e) => e.action,
    );
    expect(actions).toContain('account.export');
    expect(actions.at(-1)).toBe('account.delete');
  });

  it('an export after the delete has committed is refused with 401', async () => {
    const p = await fullPlayer();
    const blocker = await sql.reserve();
    try {
      // Hold the user row so the export waits on its lock, then delete underneath it.
      await blocker`begin`;
      await blocker`select 1 from users where id = ${p.id} for update`;
      const exporting = exportOf(p.cookie);
      await waitForLockWaiters(1);
      await blocker`delete from users where id = ${p.id}`;
      await blocker`commit`;
      expect((await exporting).statusCode).toBe(401);
    } finally {
      await blocker`rollback`.catch(() => {});
      blocker.release();
    }
    expect(await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, p.id))).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ action: 'account.export' })]),
    );
  });

  it('serializes sign-in link requests with the delete for the same email', async () => {
    const p = await fullPlayer();
    const blocker = await sql.reserve();
    try {
      await blocker`begin`;
      await blocker`select pg_advisory_xact_lock(${ADVISORY_LOCK.signInEmail}, hashtext(lower(${p.email})))`;
      const deleting = deleteAccount(p.cookie, { confirm: PHRASE });
      await waitForLockWaiters(1, 'advisory');
      const requesting = call(null, {
        method: 'POST',
        url: '/auth/request',
        payload: { email: p.email.toUpperCase() },
      });
      await waitForLockWaiters(2, 'advisory');
      await blocker`commit`;
      expect((await deleting).statusCode).toBe(204);
      expect((await requesting).statusCode).toBe(202);
    } finally {
      await blocker`rollback`.catch(() => {});
      blocker.release();
    }
  });
});

describe('export limits and caching', () => {
  it('sends Cache-Control: no-store on authenticated responses', async () => {
    const p = await fullPlayer();
    for (const url of ['/me/export', '/me', '/rules', '/profile', '/me/consents']) {
      const res = await call(p.cookie, { method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('no-store');
    }
    expect((await call(null, { method: 'GET', url: '/me' })).headers['cache-control']).toBe('no-store');
    // The sign-in response carries the email too.
    await call(null, { method: 'POST', url: '/auth/request', payload: { email: 'nostore@example.com' } });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent.at(-1)!.text)![1];
    const verify = await call(null, { method: 'POST', url: '/auth/verify', payload: { token, ageConfirmed: true } });
    expect(verify.statusCode).toBe(200);
    expect(verify.headers['cache-control']).toBe('no-store');
  });

  it('limits exports to 5 an hour per player (429 rate_limited)', async () => {
    const p = await fullPlayer();
    const other = await fullPlayer();
    for (let i = 0; i < 5; i++) expect((await exportOf(p.cookie)).statusCode).toBe(200);
    const res = await exportOf(p.cookie);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await exportOf(other.cookie)).statusCode).toBe(200);
  });

  it('totals usage beyond the 32-bit range', async () => {
    const p = await fullPlayer();
    await recordUsage(db, p.id, 'voice_tts', 2_000_000_000, 2_000_000_000);
    await recordUsage(db, p.id, 'voice_tts', 2_000_000_000, 2_000_000_000);
    const x = (await exportOf(p.cookie)).json();
    expect(x.usage).toContainEqual(
      expect.objectContaining({ feature: 'voice_tts', units: 4_000_000_000, costMicroUsd: 4_000_000_000 }),
    );
  });
});
