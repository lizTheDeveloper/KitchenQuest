// M5 Step 12: nothing earned is taken back (spec §6, never rule 6, Rulings 6 and 7, Review Focus 2). Grants survive a
// meal undo, a margin-note delete, a Shared Table delete, a health_data withdrawal with "delete", a rule that blocks a
// cooked dish, a rewards.yaml with higher thresholds loaded at a second boot, and a re-upload of a device log. Every
// derived value (XP, level, stamps, trust, technique tier, quests) stays ≥ what it was, and the grant rows themselves
// are unchanged. No code path updates a grant (a database trigger refuses it) or deletes one (a grep over
// apps/api/src; only the account-delete cascade removes grants).
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProgressEvent, ProgressView, RewardsData } from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog, defaultLoopContent, type LoopContent } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { rewardGrants } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const config = testConfig();
const catalog = defaultCatalog();
const NOW = new Date('2026-11-10T12:00:00Z');
const TODAY = '2026-11-10';
const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const DAY_MS = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance | null = null;
const mailer = new CaptureMailer();
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
  await syncCanon(db, RECIPES_DIR, catalog.graph, NOW);
});
afterAll(async () => {
  await closeDb?.();
});
afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(loop?: LoopContent): Promise<FastifyInstance> {
  await app?.close();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false, ...(loop ? { loop } : {}) });
  return app;
}
const call = (cookie: string, opts: InjectOptions) => app!.inject({ ...opts, cookies: { kq_session: cookie } });

async function player(): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app!, mailer, `keep${++seq}@example.com`);
  const id = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } });
  expect(res.statusCode).toBe(201);
  return { cookie, id };
}
async function post(cookie: string, events: ProgressEvent[], upload?: true) {
  const res = await call(cookie, { method: 'POST', url: '/progress/events', payload: { events, ...(upload ? { upload } : {}) } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ accepted: { clientId: string }[]; duplicate: string[]; rejected: { clientId: string; problems: string[] }[] }>();
}
const view = async (cookie: string) => (await call(cookie, { method: 'GET', url: '/progress' })).json<{ view: ProgressView }>().view;
const grantRows = async (userId: string) =>
  (await db.select().from(rewardGrants).where(eq(rewardGrants.userId, userId))).map((g) => JSON.stringify(g)).sort();
async function logMeal(cookie: string, eatenOn = TODAY): Promise<string> {
  const res = await call(cookie, { method: 'POST', url: '/meals', payload: { meal: { eatenOn, slot: 'lunch', item: { kind: 'dish', slug: PARIPPU, servings: 1 } }, confirmed: true } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ meal: { id: string } }>().meal.id;
}

const eid = (): string => randomUUID();
const cooked = (recipe: string, at: string): ProgressEvent => ({ id: eid(), kind: 'cooked', at, recipe, planned: true });
/** A rich past: Leela's quest, cooks across six weeks (trust 2+, level 2+), a market run and two meal logs today. */
async function playAWhile(cookie: string): Promise<ProgressEvent[]> {
  const start = addDays(TODAY, -42);
  const events: ProgressEvent[] = [
    ...Array.from({ length: 6 }, (_, i): ProgressEvent => ({ id: eid(), kind: 'quest_step', at: start, quest: 'leela-tempering', step: i + 1 })),
    { id: eid(), kind: 'quest_done', at: start, quest: 'leela-tempering' },
  ];
  for (let w = 0; w < 6; w++) {
    const at = addDays(start, w * 7);
    events.push(cooked(PARIPPU, at), cooked(ONIGIRI, at), cooked(FRIJOLES, at), { id: eid(), kind: 'lesson', at, recipe: FRIJOLES });
  }
  events.push({ id: eid(), kind: 'market_run', at: addDays(TODAY, -1), weekStart: addDays(TODAY, -1) });
  const lunch = await logMeal(cookie);
  const dinner = await logMeal(cookie);
  events.push({ id: eid(), kind: 'meal_logged', at: TODAY, minute: 720, mealLogId: lunch }, { id: eid(), kind: 'meal_logged', at: TODAY, minute: 1140, mealLogId: dinner });
  // Older events go up as the sign-in upload would send them (C14); the live window takes today's.
  const r = await post(cookie, events, true);
  expect(r.rejected).toEqual([]);
  return events;
}

const RANK = { seen: 0, tried: 1, yours: 2 } as const;
/** `after` shows nothing lower than `before`, on every value the player sees. */
function expectNoLower(before: ProgressView, after: ProgressView, label: string) {
  expect(after.xp, `${label}: xp`).toBeGreaterThanOrEqual(before.xp);
  expect(after.level, `${label}: level`).toBeGreaterThanOrEqual(before.level);
  expect(after.stamps, `${label}: stamps`).toBeGreaterThanOrEqual(before.stamps);
  for (const [cook, t] of Object.entries(before.trust)) expect(after.trust[cook] ?? 0, `${label}: trust ${cook}`).toBeGreaterThanOrEqual(t);
  for (const [id, r] of Object.entries(before.toolkit.techniques)) {
    expect(after.toolkit.techniques[id], `${label}: technique ${id}`).toBeDefined();
    expect(RANK[after.toolkit.techniques[id].tier], `${label}: tier ${id}`).toBeGreaterThanOrEqual(RANK[r.tier]);
  }
  for (const q of before.questsDone) expect(after.questsDone, `${label}: quest ${q}`).toContain(q);
}

describe('grants survive (spec §6)', () => {
  it('meal undo, note delete, Shared Table delete, health_data delete, a blocking rule, retuned thresholds at a second boot and a device re-upload', async () => {
    await boot();
    const p = await player();
    const events = await playAWhile(p.cookie);
    const first = await view(p.cookie);
    expect(first.level, 'the past earned a level').toBeGreaterThanOrEqual(2);
    expect(first.trust.leela, 'and trust').toBeGreaterThanOrEqual(2);
    expect(first.stamps).toBeGreaterThanOrEqual(2);
    expect(first.toolkit.techniques.tempering?.tier).toBeDefined();
    const grants = await grantRows(p.id);
    let last = first;
    const step = async (label: string) => {
      const now = await view(p.cookie);
      expectNoLower(first, now, label);
      expectNoLower(last, now, label);
      expect(await grantRows(p.id), `${label}: grant rows`).toEqual(grants);
      last = now;
    };

    // A meal undo: DELETE /meals/:id.
    const meals = events.filter((e): e is Extract<ProgressEvent, { kind: 'meal_logged' }> => e.kind === 'meal_logged');
    expect((await call(p.cookie, { method: 'DELETE', url: `/meals/${meals[0].mealLogId}` })).statusCode).toBe(204);
    await step('meal undo');

    // A margin note written, then deleted.
    const note = await call(p.cookie, { method: 'POST', url: '/notes', payload: { note: { recipe: PARIPPU, ops: [{ op: 'add', name: 'lime' }], text: null, at: TODAY }, confirmed: true, today: TODAY } });
    expect(note.statusCode, note.body).toBe(201);
    expect((await call(p.cookie, { method: 'DELETE', url: `/notes/${note.json<{ note: { id: string } }>().note.id}` })).statusCode).toBe(204);
    await step('note delete');

    // Cooked for Someone, recorded then deleted.
    const shared = await call(p.cookie, { method: 'POST', url: '/shared-table', payload: { entry: { cookedOn: TODAY, recipe: PARIPPU, frame: null, cookedFor: { count: 'two_to_three', who: 'family' } }, confirmed: true, today: TODAY } });
    expect(shared.statusCode, shared.body).toBe(201);
    expect((await call(p.cookie, { method: 'DELETE', url: `/shared-table/${shared.json<{ id: string }>().id}` })).statusCode).toBe(204);
    await step('shared table delete');

    // A rule that blocks a cooked dish: coconut blocks parippu, which was cooked six times.
    const rule = await call(p.cookie, { method: 'POST', url: '/rules', payload: { rule: { target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' }, confirmed: true } });
    expect(rule.statusCode).toBe(201);
    const card = await call(p.cookie, { method: 'GET', url: `/recipes/${PARIPPU}?date=${TODAY}` });
    expect(card.json<{ check: { status: string } }>().check.status).toBe('blocked');
    await step('blocking rule');

    // health_data withdrawn with "delete": meal-log events and notes go; grants stay (Ruling I2, [lawyer]).
    expect((await call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } })).statusCode).toBe(204);
    await step('health_data delete');

    // A second boot with a rewards.yaml whose thresholds are all higher: levels and trust once granted are kept.
    const base = defaultLoopContent();
    const harder: RewardsData = {
      ...base.rewards,
      levels: base.rewards.levels.map((l) => l * 10),
      trust: { ...base.rewards.trust, weeks_for_level: base.rewards.trust.weeks_for_level.map((w) => w * 10) },
    };
    await boot({ ...base, rewards: harder });
    await step('higher thresholds at a second boot');

    // A re-upload of the whole device log: every event is a duplicate; nothing earned twice, nothing lowered.
    const again = await post(p.cookie, events, true);
    expect(again.accepted).toEqual([]);
    await step('device re-upload');
  });
});

/** Every source file under apps/api/src. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? sourceFiles(f) : f.endsWith('.ts') ? [f] : [];
  });
}
/** A write that changes or removes a grant: drizzle's update/delete on rewardGrants, or SQL on reward_grants. */
const MUTATES_GRANTS = /\.(update|delete)\(\s*rewardGrants\b|\b(update|delete\s+from|truncate)\s+"?reward_grants\b/i;

describe('reward_grants is append-only', () => {
  it('the grep bites on a planted update or delete', () => {
    for (const t of ['await tx.update(rewardGrants).set({ amount: 0 })', 'db.delete( rewardGrants ).where(x)', "sql`UPDATE reward_grants SET amount = 0`", 'sql`delete from "reward_grants"`', 'truncate reward_grants']) {
      expect(MUTATES_GRANTS.test(t), t).toBe(true);
    }
    for (const t of ['tx.insert(rewardGrants).values(g)', 'db.select().from(rewardGrants)', '-- reward_grants is append-only']) expect(MUTATES_GRANTS.test(t), t).toBe(false);
  });

  it('no code path in apps/api/src updates or deletes a grant', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => /rewardGrants/.test(readFileSync(f, 'utf8'))).length, 'the grep reads the files that use the table').toBeGreaterThan(0);
    expect(files.filter((f) => MUTATES_GRANTS.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f))).toEqual([]);
  });

  it('the database refuses an UPDATE of a grant; the account-delete cascade still removes them', async () => {
    await boot();
    const p = await player();
    await post(p.cookie, [cooked(PARIPPU, TODAY)]);
    const before = await grantRows(p.id);
    expect(before.length).toBeGreaterThan(0);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_trigger where tgname = 'reward_grants_append_only' and not tgisinternal`;
    expect(n).toBe(1);
    await expect(sql`update reward_grants set body = '{}'::jsonb where user_id = ${p.id}`).rejects.toThrow(/reward_grants is append-only: UPDATE/);
    await expect(sql`update reward_grants set kind = kind where user_id = ${p.id}`).rejects.toThrow(/append-only/);
    expect(await grantRows(p.id)).toEqual(before);
    expect((await call(p.cookie, { method: 'DELETE', url: '/me', payload: { confirm: 'delete my account' } })).statusCode).toBe(204);
    expect(await grantRows(p.id)).toEqual([]);
  });
});
