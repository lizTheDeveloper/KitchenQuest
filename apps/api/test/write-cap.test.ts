// M4 Step 12 (Step 5 review carry): a per-player daily cap on meal logs and loosening rule edits.
// It never blocks adding, removing or tightening a rule (never rule 1).
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { NOTICES } from '../src/consent/notices.js';
import { auditEvents } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { atLeastAsStrict } from '../src/rules/service.js';
import type { StoredRule } from '../src/rules/store.js';
import type { Db } from '../src/types.js';
import { WRITES_PER_DAY } from '../src/usage/write-cap.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb } from './helpers/db.js';

const config = testConfig();
const NOW = new Date('2026-11-09T12:00:00Z');
const TODAY = '2026-11-09';
const HOUR = 3_600_000;

let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let clock: number;
let seq = 0;

beforeAll(async () => {
  ({ db, close: closeDb } = await testDb());
});
afterAll(async () => {
  await closeDb?.();
});
beforeEach(async () => {
  mailer = new CaptureMailer();
  clock = NOW.getTime();
  app = await buildApp({ config, db, mailer, ai: null, now: () => new Date(clock), logger: false });
});
afterEach(async () => {
  await app?.close();
});

const call = (cookie: string, opts: InjectOptions) => app.inject({ ...opts, cookies: { kq_session: cookie } });

async function player() {
  const cookie = await signIn(app, mailer, `cap${++seq}@example.com`);
  const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } });
  expect(res.statusCode).toBe(201);
  const userId = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  return { cookie, userId };
}

/** `n` audited writes of `action`, `ago` ms before now (the cap counts the audit trail). */
async function pastWrites(userId: string, action: string, n: number, ago = HOUR) {
  const at = new Date(clock - ago);
  await db.insert(auditEvents).values(Array.from({ length: n }, () => ({ at, actorKind: 'user', actorId: userId, subjectUserId: userId, action, target: 'x' })));
}

const TOAST = { eatenOn: TODAY, slot: 'breakfast', item: { kind: 'free', description: 'toast' } };
const logMeal = (cookie: string) => call(cookie, { method: 'POST', url: '/meals', payload: { meal: TOAST, confirmed: true } });
const rule = (ids: string[], severity: string) => ({ target: { kind: 'ingredient', ids }, type: 'avoid', severity });
const addRule = (cookie: string, r: object) => call(cookie, { method: 'POST', url: '/rules', payload: { rule: r, confirmed: true } });
const putRule = (cookie: string, id: string, r: object) => call(cookie, { method: 'PUT', url: `/rules/${id}`, payload: { rule: r, confirmed: true } });

describe('the daily write cap', () => {
  it(`meal logs: the ${WRITES_PER_DAY + 1}st in a day is a 429 with retry-after; a day later it works again`, async () => {
    const p = await player();
    await pastWrites(p.userId, 'meals.create', WRITES_PER_DAY - 1);
    expect((await logMeal(p.cookie)).statusCode).toBe(201);
    const capped = await logMeal(p.cookie);
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toMatchObject({ error: { code: 'rate_limited', details: { retryAfterSeconds: expect.any(Number) } } });
    expect(Number(capped.headers['retry-after'])).toBeGreaterThan(0);
    // The capped player can still delete what they logged.
    const meals = (await call(p.cookie, { method: 'GET', url: `/meals?from=${TODAY}&to=${TODAY}` })).json<{ meals: { id: string }[] }>().meals;
    expect((await call(p.cookie, { method: 'DELETE', url: `/meals/${meals[0].id}` })).statusCode).toBe(204);
    clock += 24 * HOUR;
    expect((await logMeal(p.cookie)).statusCode).toBe(201);
  });

  it('is per player: another player is not capped', async () => {
    const a = await player();
    const b = await player();
    await pastWrites(a.userId, 'meals.create', WRITES_PER_DAY);
    expect((await logMeal(a.cookie)).statusCode).toBe(429);
    expect((await logMeal(b.cookie)).statusCode).toBe(201);
  });

  it('never blocks a rule from being added, removed or made stricter; a loosening edit is capped', async () => {
    const p = await player();
    await pastWrites(p.userId, 'rules.update', WRITES_PER_DAY);
    await pastWrites(p.userId, 'rules.create', WRITES_PER_DAY);
    const created = await addRule(p.cookie, rule(['peanut'], 'allergy'));
    expect(created.statusCode).toBe(201);
    const id = created.json<{ rule: { id: string } }>().rule.id;
    expect((await putRule(p.cookie, id, rule(['peanut'], 'anaphylactic'))).statusCode).toBe(200);
    expect((await putRule(p.cookie, id, rule(['peanut', 'sesame'], 'anaphylactic'))).statusCode).toBe(200);
    const looser = await putRule(p.cookie, id, rule(['peanut'], 'intolerance'));
    expect(looser.statusCode).toBe(429);
    expect(looser.json().error.code).toBe('rate_limited');
    expect((await putRule(p.cookie, id, rule(['sesame'], 'anaphylactic'))).statusCode).toBe(429);
    expect((await call(p.cookie, { method: 'DELETE', url: `/rules/${id}` })).statusCode).toBe(204);
  });

  it('atLeastAsStrict: same or wider targets, no milder severity, same phase', () => {
    const r = (ids: string[], severity: StoredRule['severity'], extra: Partial<StoredRule> = {}) =>
      ({ target: { kind: 'ingredient', ids }, type: 'avoid', severity, ...extra }) as StoredRule;
    expect(atLeastAsStrict(r(['peanut'], 'allergy'), r(['peanut'], 'allergy'))).toBe(true);
    expect(atLeastAsStrict(r(['peanut'], 'allergy'), r(['peanut', 'sesame'], 'anaphylactic'))).toBe(true);
    expect(atLeastAsStrict(r(['peanut'], 'allergy'), r(['peanut'], 'preference'))).toBe(false);
    expect(atLeastAsStrict(r(['peanut', 'sesame'], 'allergy'), r(['peanut'], 'allergy'))).toBe(false);
    expect(atLeastAsStrict(r(['peanut'], 'allergy'), r(['peanut'], 'allergy', { phase: { start: '2026-11-01' } }))).toBe(false);
  });
});
