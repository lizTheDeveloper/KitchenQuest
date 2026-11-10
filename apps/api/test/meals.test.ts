// M4 Step 5: sealed meal logs (H-7, C-23), health_data consent, explicit yes.
import { MEAL_DESCRIPTION_MAX, MEAL_SLOTS } from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { NOTICES } from '../src/consent/notices.js';
import { auditEvents, MEAL_LOG_SLOTS, mealLogs, pantryItems, selfReadCounts } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { validateMeal } from '../src/meals/service.js';
import { mealSlotsOn } from '../src/meals/store.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { captureLogs } from './helpers/logs.js';

const config = testConfig();
const NOW = new Date('2026-11-09T12:00:00Z');
const TODAY = '2026-11-09';
const SLUG = 'testland/north/stew';

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
  await sql`insert into canon_recipes (path, slug, title, country, status, source, content_hash)
            values ('recipes/testland/north/stew.cook', ${SLUG}, 'Stew', 'testland', 'tested', 'x', 'h')`;
});
afterAll(async () => {
  await closeDb?.();
});
beforeEach(async () => {
  mailer = new CaptureMailer();
  let tick = 0;
  app = await buildApp({ config, db, mailer, ai: null, now: () => new Date(NOW.getTime() + tick++), logger: false });
});
afterEach(async () => {
  await app?.close();
});

const call = (cookie: string | null, opts: InjectOptions) =>
  app.inject({ ...opts, ...(cookie ? { cookies: { kq_session: cookie } } : {}) });

const grantHealth = async (cookie: string) => {
  const res = await call(cookie, {
    method: 'POST',
    url: '/me/consents',
    payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version },
  });
  expect(res.statusCode).toBe(201);
};

const signedIn = () => signIn(app, mailer, `meals${++seq}@example.com`);
const player = async () => {
  const cookie = await signedIn();
  await grantHealth(cookie);
  return cookie;
};
const userIdOf = async (cookie: string) => (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
const stored = async (userId: string) => (await db.select().from(mealLogs).where(eq(mealLogs.userId, userId))).length;

const TOAST = { eatenOn: TODAY, slot: 'breakfast', item: { kind: 'free', description: 'toast with peanut butter' } };
const STEW = { eatenOn: TODAY, slot: 'dinner', item: { kind: 'dish', slug: SLUG, servings: 1.5 } };

const post = (cookie: string, payload: unknown) => call(cookie, { method: 'POST', url: '/meals', payload: payload as object });
const list = (cookie: string, from = TODAY, to = TODAY) => call(cookie, { method: 'GET', url: `/meals?from=${from}&to=${to}` });
const del = (cookie: string, id: string) => call(cookie, { method: 'DELETE', url: `/meals/${id}` });

describe('meal logs', () => {
  it('a meal log round-trips sealed: the column holds no plaintext', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    const res = await post(c, { meal: TOAST, confirmed: true });
    expect(res.statusCode).toBe(201);
    const { meal } = res.json<{ meal: { id: string } }>();
    expect(meal).toEqual({ ...TOAST, id: expect.any(String) });
    const dish = await post(c, { meal: STEW, confirmed: true });
    expect(dish.statusCode).toBe(201);

    const got = await list(c);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual({ meals: [{ ...TOAST, id: meal.id }, { ...STEW, id: dish.json().meal.id }] });

    const raw = await sql<{ sealed: Buffer; eaten_on: string; slot: string }[]>`select sealed, eaten_on::text, slot from meal_logs where user_id = ${uid}`;
    expect(raw).toHaveLength(2);
    for (const r of raw) {
      expect(r.sealed.toString('latin1')).not.toMatch(/peanut|toast|stew|testland/i);
      expect(r.eaten_on).toBe(TODAY);
    }
    // Date and slot stay plain (C-23); the prompt context reads them without opening anything.
    expect(await mealSlotsOn(db, config.keyring, uid, TODAY)).toEqual(['breakfast', 'dinner']);
    expect(await mealSlotsOn(db, config.keyring, uid, '2026-11-08')).toEqual([]);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, uid));
    expect(events.filter((e) => e.action === 'meals.create').map((e) => e.target)).toEqual([meal.id, dish.json().meal.id]);
  });

  it('trims a free description before it is sealed', async () => {
    const c = await player();
    const res = await post(c, { meal: { ...TOAST, item: { kind: 'free', description: '  porridge  ' } }, confirmed: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().meal.item).toEqual({ kind: 'free', description: 'porridge' });
  });

  it('meal needs confirmed: true and health_data consent', async () => {
    const noConsent = await signedIn();
    const uid = await userIdOf(noConsent);
    for (const payload of [{ meal: TOAST }, { meal: TOAST, confirmed: false }, { meal: TOAST, confirmed: 'yes' }]) {
      const res = await post(noConsent, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('confirmation_required');
    }
    const res = await post(noConsent, { meal: TOAST, confirmed: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('consent_required');
    expect(await stored(uid)).toBe(0);
    expect((await call(null, { method: 'POST', url: '/meals', payload: { meal: TOAST, confirmed: true } })).statusCode).toBe(401);
  });

  it('meal validation', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    const bad = [
      { ...STEW, item: { kind: 'dish', slug: 'nowhere/none', servings: 1 } },
      { ...STEW, item: { kind: 'dish', slug: SLUG, servings: 0 } },
      { ...STEW, item: { kind: 'dish', slug: SLUG, servings: 11 } },
      { ...TOAST, item: { kind: 'free', description: 'x'.repeat(MEAL_DESCRIPTION_MAX + 1) } },
      { ...TOAST, item: { kind: 'free', description: '   ' } },
      { ...TOAST, eatenOn: '2026-11-11' },
      { ...TOAST, eatenOn: '2026-11-01' },
      { ...TOAST, eatenOn: '2026-02-30' },
      { ...TOAST, slot: 'elevenses' },
      { ...TOAST, extra: 'peanut' },
      { ...TOAST, item: { kind: 'free', description: 'toast', note: 'peanut' } },
      'toast',
    ];
    for (const meal of bad) {
      const res = await post(c, { meal, confirmed: true });
      expect(res.statusCode, JSON.stringify(meal)).toBe(400);
      expect(res.json().error.code, JSON.stringify(meal)).toBe('bad_request');
      expect(res.json().error.details.problems.length, JSON.stringify(meal)).toBeGreaterThan(0);
    }
    expect(await stored(uid)).toBe(0);
  });

  it('validateMeal: the window is [today − 7, today + 1]; servings [0.25, 10]; description 1–200', () => {
    const slugs = new Set([SLUG]);
    const ok = (meal: unknown) => validateMeal(meal, TODAY, slugs);
    expect(ok({ ...TOAST, eatenOn: '2026-11-02' })).toEqual([]);
    expect(ok({ ...TOAST, eatenOn: '2026-11-10' })).toEqual([]);
    expect(ok({ ...TOAST, eatenOn: '2026-11-01' })).not.toEqual([]);
    expect(ok({ ...TOAST, eatenOn: '2026-11-11' })).not.toEqual([]);
    expect(ok({ ...STEW, item: { ...STEW.item, servings: 0.25 } })).toEqual([]);
    expect(ok({ ...STEW, item: { ...STEW.item, servings: 10 } })).toEqual([]);
    expect(ok({ ...STEW, item: { ...STEW.item, servings: 0.24 } })).not.toEqual([]);
    expect(ok({ ...STEW, item: { ...STEW.item, servings: Number.NaN } })).not.toEqual([]);
    expect(ok({ ...STEW, item: { ...STEW.item, servings: '1' } })).not.toEqual([]);
    expect(ok({ ...TOAST, item: { kind: 'free', description: 'x'.repeat(MEAL_DESCRIPTION_MAX) } })).toEqual([]);
    expect(ok({ ...TOAST, item: { kind: 'free', description: ` ${'x'.repeat(MEAL_DESCRIPTION_MAX)} ` } })).toEqual([]);
    expect(ok({ ...TOAST, item: { kind: 'snack' } })).not.toEqual([]);
    expect(ok(null)).not.toEqual([]);
  });

  it('the table slot check is core MEAL_SLOTS', () => {
    expect([...MEAL_LOG_SLOTS]).toEqual([...MEAL_SLOTS]);
  });

  it("another user's meal id → 404 on delete", async () => {
    const a = await player();
    const b = await player();
    const id = (await post(a, { meal: TOAST, confirmed: true })).json().meal.id as string;
    expect((await del(b, id)).statusCode).toBe(404);
    expect((await del(b, 'not-a-uuid')).statusCode).toBe(404);
    expect((await list(a)).json().meals).toHaveLength(1);
    expect((await del(a, id)).statusCode).toBe(204);
    expect((await list(a)).json().meals).toEqual([]);
    expect((await del(a, id)).statusCode).toBe(404);
  });

  it('withdrawing (keep) stops logging; kept meals stay readable and deletable', async () => {
    const c = await player();
    const id = (await post(c, { meal: TOAST, confirmed: true })).json().meal.id as string;
    const w = await call(c, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } });
    expect(w.statusCode).toBe(204);
    expect((await post(c, { meal: TOAST, confirmed: true })).statusCode).toBe(403);
    expect((await list(c)).json().meals).toHaveLength(1);
    expect((await del(c, id)).statusCode).toBe(204);
  });

  it('withdraw health_data with delete removes meal logs, keeps pantry', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    expect((await post(c, { meal: TOAST, confirmed: true })).statusCode).toBe(201);
    const pantry = await call(c, {
      method: 'POST',
      url: '/pantry/changes',
      payload: { add: [{ name: 'Milk', ingredientId: null }], removeNames: [], removeIds: [], confirmed: true },
    });
    expect(pantry.statusCode).toBe(200);
    const w = await call(c, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } });
    expect(w.statusCode).toBe(204);
    expect(await stored(uid)).toBe(0);
    expect(await db.select().from(pantryItems).where(eq(pantryItems.userId, uid))).toHaveLength(1);
    expect((await call(c, { method: 'GET', url: '/pantry' })).json().items).toEqual([expect.objectContaining({ name: 'Milk' })]);
  });

  it('GET /meals: a range of at most 31 days, from ≤ to, counted as a self-read', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    expect((await post(c, { meal: { ...TOAST, eatenOn: '2026-11-03' }, confirmed: true })).statusCode).toBe(201);
    expect((await post(c, { meal: TOAST, confirmed: true })).statusCode).toBe(201);
    expect((await list(c, '2026-11-04', '2026-11-09')).json().meals).toEqual([expect.objectContaining({ eatenOn: TODAY })]);
    expect((await list(c, '2026-10-10', '2026-11-09')).json().meals).toHaveLength(2);
    for (const [from, to] of [
      ['2026-10-09', '2026-11-09'],
      ['2026-11-09', '2026-11-08'],
      ['2026-11-9', '2026-11-09'],
      ['2026-02-30', '2026-03-01'],
    ]) {
      const res = await list(c, from, to);
      expect(res.statusCode, `${from}..${to}`).toBe(400);
    }
    expect((await call(c, { method: 'GET', url: '/meals' })).statusCode).toBe(400);
    expect((await call(null, { method: 'GET', url: `/meals?from=${TODAY}&to=${TODAY}` })).statusCode).toBe(401);
    const reads = await db.select().from(selfReadCounts).where(eq(selfReadCounts.userId, uid));
    expect(reads).toEqual([{ userId: uid, resource: 'meals', day: TODAY, count: 2 }]);
  });
});

describe('log redaction (C-9)', () => {
  it('C-9: a meal POST leaves no "peanut" in the captured logs', async () => {
    const logs = captureLogs();
    const logged = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: logs.logger });
    try {
      const cookie = await signIn(logged, mailer, `mlogs${++seq}@example.com`);
      const cookies = { kq_session: cookie };
      const consent = await logged.inject({
        method: 'POST',
        url: '/me/consents',
        cookies,
        payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version },
      });
      expect(consent.statusCode).toBe(201);
      const res = await Promise.all([
        logged.inject({ method: 'POST', url: '/meals', cookies, payload: { meal: TOAST, confirmed: true } }),
        logged.inject({ method: 'POST', url: '/meals', cookies, payload: { meal: { ...TOAST, slot: 'peanut' }, confirmed: true } }),
        logged.inject({ method: 'POST', url: '/meals', cookies, payload: { meal: { ...TOAST, peanut: 1 }, confirmed: true } }),
        logged.inject({ method: 'POST', url: '/meals', cookies, payload: { meal: TOAST } }),
      ]);
      expect(res.map((r) => r.statusCode)).toEqual([201, 400, 400, 400]);
      expect((await logged.inject({ method: 'GET', url: `/meals?from=${TODAY}&to=${TODAY}`, cookies })).statusCode).toBe(200);
      expect((await logged.inject({ method: 'DELETE', url: `/meals/${res[0].json().meal.id}`, cookies })).statusCode).toBe(204);
      expect(logs.lines().length).toBeGreaterThan(5);
      expect(logs.text()).not.toMatch(/peanut|toast/i);
    } finally {
      await logged.close();
    }
  });
});
