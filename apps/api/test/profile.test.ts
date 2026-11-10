import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { eq } from 'drizzle-orm';
import { profiles } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testEnv } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const config = loadConfig({
  ...testEnv,
  APP_ORIGIN: 'https://play.kitchenquest.test',
});

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
});
afterAll(async () => {
  await closeDb?.();
});
beforeEach(async () => {
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => new Date('2026-03-01T12:00:00Z'), logger: false });
});
afterEach(async () => {
  await app?.close();
});

const user = () => signIn(app, mailer, `cook${++seq}@example.com`);
const get = (cookie: string) => app.inject({ method: 'GET', url: '/profile', cookies: { kq_session: cookie } });
const put = (cookie: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: '/profile', cookies: { kq_session: cookie }, payload: payload as object });

const EMPTY = { marketDays: [], mealsPerWeek: null, country: null, region: null, mealWindows: [] };

describe('profile', () => {
  it('requires auth', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const res = await app.inject({ method, url: '/profile', ...(method === 'PUT' ? { payload: {} } : {}) });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    }
  });

  it('first GET returns defaults', async () => {
    const res = await get(await user());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(EMPTY);
  });

  it('PUT then GET round-trips; omitted fields are unchanged', async () => {
    const c = await user();
    const full = {
      marketDays: [6, 0],
      mealsPerWeek: 14,
      country: 'NZ',
      region: 'Wellington',
      mealWindows: [{ name: 'lunch', start: '12:00', end: '13:30' }],
    };
    const res = await put(c, full);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(full);
    expect((await get(c)).json()).toEqual(full);

    const partial = await put(c, { country: 'AU', mealsPerWeek: null });
    expect(partial.json()).toEqual({ ...full, country: 'AU', mealsPerWeek: null });
    expect((await put(c, {})).json()).toEqual({ ...full, country: 'AU', mealsPerWeek: null });
  });

  it('PUT before any GET creates the profile', async () => {
    const res = await put(await user(), { region: 'Bavaria' });
    expect(res.json()).toEqual({ ...EMPTY, region: 'Bavaria' });
  });

  it("users can't see each other's profile", async () => {
    const a = await user();
    const b = await user();
    await put(a, { country: 'NZ', marketDays: [1] });
    expect((await get(b)).json()).toEqual(EMPTY);
    await put(b, { country: 'DE' });
    expect((await get(a)).json()).toMatchObject({ country: 'NZ', marketDays: [1] });
  });

  const w = (o: object = {}) => ({ name: 'lunch', start: '12:00', end: '13:00', ...o });
  const invalid: [string, object, string][] = [
    ['marketDays duplicate', { marketDays: [1, 1] }, 'marketDays'],
    ['marketDays out of range', { marketDays: [7] }, 'marketDays.0'],
    ['marketDays negative', { marketDays: [-1] }, 'marketDays.0'],
    ['marketDays non-integer', { marketDays: [1.5] }, 'marketDays.0'],
    ['mealsPerWeek too high', { mealsPerWeek: 43 }, 'mealsPerWeek'],
    ['mealsPerWeek negative', { mealsPerWeek: -1 }, 'mealsPerWeek'],
    ['mealsPerWeek fractional', { mealsPerWeek: 2.5 }, 'mealsPerWeek'],
    ['country too long', { country: 'x'.repeat(81) }, 'country'],
    ['region too long', { region: 'x'.repeat(81) }, 'region'],
    ['more than 8 windows', { mealWindows: Array.from({ length: 9 }, () => w()) }, 'mealWindows'],
    ['bad time format', { mealWindows: [w({ start: '9:00' })] }, 'mealWindows.0.start'],
    ['time 24:00', { mealWindows: [w({ end: '24:00' })] }, 'mealWindows.0.end'],
    ['start equals end', { mealWindows: [w({ start: '12:00', end: '12:00' })] }, 'mealWindows.0.end'],
    ['start after end', { mealWindows: [w({ start: '14:00', end: '13:00' })] }, 'mealWindows.0.end'],
    // N-7: a window name is one of a fixed set, never free text (it could reveal a fast or a condition).
    ['free-text name', { mealWindows: [w({ name: 'Ramadan suhoor' })] }, 'mealWindows.0.name'],
    ['name in another case', { mealWindows: [w({ name: 'Lunch' })] }, 'mealWindows.0.name'],
    ['empty name', { mealWindows: [w({ name: '' })] }, 'mealWindows.0.name'],
    ['non-string name', { mealWindows: [w({ name: 3 })] }, 'mealWindows.0.name'],
    ['missing name', { mealWindows: [{ start: '12:00', end: '13:00' }] }, 'mealWindows.0.name'],
  ];
  it.each(invalid)('rejects %s with 400 naming the field', async (_n, body, path) => {
    const c = await user();
    const res = await put(c, body);
    expect(res.statusCode).toBe(400);
    const err = res.json().error;
    expect(err.code).toBe('bad_request');
    expect(err.details.map((d: { path: string }) => d.path)).toContain(path);
    expect((await get(c)).json()).toEqual(EMPTY); // nothing stored
  });

  it('accepts boundary values', async () => {
    const body = {
      marketDays: [0, 1, 2, 3, 4, 5, 6],
      mealsPerWeek: 42,
      country: 'x'.repeat(80),
      mealWindows: Array.from({ length: 8 }, () => w({ name: 'other', start: '00:00', end: '23:59' })),
    };
    expect((await put(await user(), body)).statusCode).toBe(200);
  });

  it('accepts every meal-window name in the fixed set', async () => {
    const names = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];
    const mealWindows = names.map((name) => w({ name }));
    const res = await put(await user(), { mealWindows });
    expect(res.statusCode).toBe(200);
    expect(res.json().mealWindows).toEqual(mealWindows);
  });

  it('reads a stored name outside the fixed set as "other", in GET /profile and the export', async () => {
    const cookie = await user();
    const id = (await app.inject({ method: 'GET', url: '/me', cookies: { kq_session: cookie } })).json().id as string;
    await get(cookie);
    // A row written before names became a fixed set (N-7).
    await db
      .update(profiles)
      .set({ mealWindows: [{ name: 'Ramadan suhoor', start: '04:00', end: '04:30' }, w({ name: 'dinner' })] })
      .where(eq(profiles.userId, id));
    const expected = [{ name: 'other', start: '04:00', end: '04:30' }, w({ name: 'dinner' })];
    expect((await get(cookie)).json().mealWindows).toEqual(expected);
    const exported = await app.inject({ method: 'GET', url: '/me/export', cookies: { kq_session: cookie } });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().profile.mealWindows).toEqual(expected);
    expect(exported.body).not.toContain('Ramadan');
  });

  it('a user deleted after sign-in check gets 401, not 500, on GET and PUT (M-2)', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const cookie = await user();
      const id = (await app.inject({ method: 'GET', url: '/me', cookies: { kq_session: cookie } })).json().id as string;
      const blocker = await sql.reserve();
      try {
        // An account delete in flight: the request passes requireUser, then the delete commits.
        await blocker`begin`;
        await blocker`delete from users where id = ${id}`;
        const res = method === 'GET' ? get(cookie) : put(cookie, { mealsPerWeek: 3 });
        for (let i = 0; ; i++) {
          const [w] = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`;
          if (w.n >= 1) break;
          if (i > 300) throw new Error('the request never waited on the delete');
          await new Promise((r) => setTimeout(r, 10));
        }
        await blocker`commit`;
        const done = await res;
        expect(done.statusCode, method).toBe(401);
        expect(done.json().error.code).toBe('unauthorized');
      } finally {
        await blocker`rollback`.catch(() => {});
        blocker.release();
      }
    }
  });
});
