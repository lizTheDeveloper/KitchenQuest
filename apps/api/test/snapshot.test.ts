// M6 Step 7 (Ruling 18; M5 m12): the sealed progress snapshot is a cache of the C15 fold, never a record. It is written
// under progress: once the tail passes SNAPSHOT_EVERY, read with the events after it, dropped by a database trigger on
// any progress event delete (meal-log cascade, health_data delete), ignored on a catalogue or rewards change and on a
// blob that won't open, exported decrypted and deleted with the account. It never changes a derived value.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactHistory, deriveProgress, SNAPSHOT_EVERY, type ProgressEvent, type ProgressView, type RewardGrant } from '@kitchenquest/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog, defaultLoopContent, type LoopContent } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import * as schema from '../src/db/schema.js';
import { progressEvents, progressSnapshots } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { deleteMealLogIn } from '../src/meals/service.js';
import { catalogueFor } from '../src/progress/catalogue.js';
import { progressViewOf } from '../src/progress/service.js';
import { catalogueHash, loadHistoryWithSnapshot } from '../src/progress/snapshot.js';
import { loadFullHistory, type Tx } from '../src/progress/store.js';
import { createRecipeIndexSource } from '../src/recipes/recipe-index.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { openFor } from '../src/crypto/userkeys.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { captureLogs } from './helpers/logs.js';

const config = testConfig();
const catalog = defaultCatalog();
const loop = defaultLoopContent();
const NOW = new Date('2026-11-10T12:00:00Z');
const TODAY = '2026-11-10';
const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const NO_MEAT = { target: { kind: 'ingredient', ids: ['meat'] }, type: 'avoid', severity: 'preference' };
const DAY_MS = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
  await syncCanon(db, RECIPES_DIR, catalog.graph, NOW);
});
afterAll(async () => {
  await closeDb?.();
});
async function boot(opts: { loop?: LoopContent; logger?: ReturnType<typeof captureLogs>['logger'] } = {}) {
  await app?.close();
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: opts.logger ?? false, ...(opts.loop ? { loop: opts.loop } : {}) });
}
beforeEach(async () => {
  await boot();
});
afterEach(async () => {
  await app?.close();
});

const call = (cookie: string | null, opts: InjectOptions) => app.inject({ ...opts, ...(cookie ? { cookies: { kq_session: cookie } } : {}) });
interface Posted {
  accepted: { clientId: string; grants: RewardGrant[] }[];
  duplicate: string[];
  rejected: { clientId: string; problems: string[] }[];
  view: ProgressView;
}
async function player(): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app, mailer, `snapshot${++seq}@example.com`);
  const id = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } });
  expect(res.statusCode, res.body).toBe(201);
  return { cookie, id };
}
async function post(cookie: string, events: unknown[]): Promise<Posted> {
  const res = await call(cookie, { method: 'POST', url: '/progress/events', payload: { events } });
  expect(res.statusCode, res.body).toBe(200);
  const r = res.json<Posted>();
  expect(r.rejected).toEqual([]);
  return r;
}
const view = async (cookie: string) => {
  const res = await call(cookie, { method: 'GET', url: '/progress' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ view: ProgressView }>().view;
};
async function logMeal(cookie: string, eatenOn = TODAY): Promise<string> {
  const res = await call(cookie, { method: 'POST', url: '/meals', payload: { meal: { eatenOn, slot: 'lunch', item: { kind: 'free', description: 'soup' } }, confirmed: true } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ meal: { id: string } }>().meal.id;
}
async function addRule(cookie: string, rule: unknown) {
  const res = await call(cookie, { method: 'POST', url: '/rules', payload: { rule, confirmed: true } });
  expect(res.statusCode, res.body).toBe(201);
}
const snapshotRow = async (userId: string) => (await db.select().from(progressSnapshots).where(eq(progressSnapshots.userId, userId)))[0];
const eventCount = async (userId: string) => (await db.select({ id: progressEvents.id }).from(progressEvents).where(eq(progressEvents.userId, userId))).length;

const RECIPES = [PARIPPU, ONIGIRI, FRIJOLES];
/** `n` accepted filler events (lessons and cooks over the last days, at most 150 a day, well under the 200 cap). */
function filler(n: number, startDay = 0): ProgressEvent[] {
  return Array.from({ length: n }, (_, i): ProgressEvent => {
    const at = addDays(TODAY, -(startDay + Math.floor(i / 150)));
    const recipe = RECIPES[i % RECIPES.length];
    return i % 2 === 0 ? { id: randomUUID(), kind: 'lesson', at, recipe } : { id: randomUUID(), kind: 'cooked', at, recipe, planned: false };
  });
}
async function postAll(cookie: string, events: unknown[]) {
  for (let i = 0; i < events.length; i += 100) await post(cookie, events.slice(i, i + 100));
}
const round = (stall: string, answers: [string, number][], at = TODAY) => ({ id: randomUUID(), kind: 'stall_round' as const, at, stall, answers: answers.map(([q, pick]) => ({ q, pick })) });
const leelaQuest = (at = TODAY): ProgressEvent[] => [
  ...Array.from({ length: 6 }, (_, i): ProgressEvent => ({ id: randomUUID(), kind: 'quest_step', at, quest: 'leela-tempering', step: i + 1 })),
  { id: randomUUID(), kind: 'quest_done', at, quest: 'leela-tempering' },
];

/**
 * A player past the threshold: a meal-log event, a Protein Counter round and a base round, Leela's quest, then filler
 * up to SNAPSHOT_EVERY + 1 events, so the last post writes the snapshot.
 */
async function heavyPlayer() {
  const p = await player();
  await addRule(p.cookie, NO_MEAT);
  const mealId = await logMeal(p.cookie);
  const head: unknown[] = [
    { id: randomUUID(), kind: 'meal_logged', at: TODAY, minute: 720, mealLogId: mealId },
    round('bram', [['bram-pc-parmesan', 0]]),
    round('wen', [['wen-avocado-ripe', 0]]),
    ...leelaQuest(addDays(TODAY, -4)),
  ];
  await post(p.cookie, head);
  await postAll(p.cookie, filler(SNAPSHOT_EVERY + 1 - head.length));
  expect(await eventCount(p.id)).toBe(SNAPSHOT_EVERY + 1);
  return { ...p, mealId };
}

const cat = async () => catalogueFor(await createRecipeIndexSource().current(db), loop);
const RANK = { seen: 0, tried: 1, yours: 2 } as const;
function expectNoLower(lower: ProgressView, higher: ProgressView) {
  expect(higher.xp).toBeGreaterThanOrEqual(lower.xp);
  expect(higher.level).toBeGreaterThanOrEqual(lower.level);
  expect(higher.stamps).toBeGreaterThanOrEqual(lower.stamps);
  for (const [cook, t] of Object.entries(lower.trust)) expect(higher.trust[cook] ?? 0).toBeGreaterThanOrEqual(t);
  for (const [id, r] of Object.entries(lower.toolkit.techniques)) expect(RANK[higher.toolkit.techniques[id]?.tier ?? 'seen']).toBeGreaterThanOrEqual(RANK[r.tier]);
  for (const q of lower.questsDone) expect(higher.questsDone).toContain(q);
}

describe('progress snapshot (M6 Step 7, Ruling 18)', () => {
  it('after SNAPSHOT_EVERY+1 events a sealed snapshot exists; progress_snapshots.sealed holds no slug or question id in plaintext', async () => {
    const p = await player();
    await addRule(p.cookie, NO_MEAT);
    await post(p.cookie, [round('bram', [['bram-pc-parmesan', 0]]), round('wen', [['wen-avocado-ripe', 0]])]);
    await postAll(p.cookie, filler(SNAPSHOT_EVERY - 2));
    // Exactly SNAPSHOT_EVERY events: no snapshot yet.
    expect(await eventCount(p.id)).toBe(SNAPSHOT_EVERY);
    expect(await snapshotRow(p.id)).toBeUndefined();
    await post(p.cookie, filler(1, 5));
    const row = await snapshotRow(p.id);
    expect(row).toBeDefined();
    const [{ last }] = await sql<{ last: number }[]>`select max(seq)::int as last from progress_events where user_id = ${p.id}`;
    expect(row!.uptoSeq).toBe(last);
    expect(row!.catalogueHash).toBe(catalogueHash(await cat(), loop.rewards, loop.thresholds));
    for (const word of ['parippu', 'onigiri', 'india/kerala', 'leela', 'bram', 'parmesan', 'wen-avocado', 'protein', 'cookedOn', 'marketAnswered', '"xp"']) {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from progress_snapshots r where position(${word} in r::text) > 0 or position(convert_to(${word}, 'UTF8') in r.sealed) > 0`;
      expect(n, word).toBe(0);
    }
    // Opened with the player's key under its own AAD, it is core's snapshot of the whole fold.
    const opened = await openFor<{ view: ProgressView; facts: unknown }>(db, config.keyring, { table: 'progress_snapshots', userId: p.id, rowId: p.id }, row!.sealed);
    expect(opened.view).toEqual(await view(p.cookie));
    expect(opened.view.marketAnswered).toHaveProperty('bram-pc-parmesan');
    // Under another row's AAD (another player's id) it does not open.
    await expect(openFor(db, config.keyring, { table: 'progress_snapshots', userId: p.id, rowId: randomUUID() }, row!.sealed)).rejects.toThrow();
  });

  it('GET /progress with a snapshot reads only the tail (spy on the select) and returns the same view as a full read', async () => {
    const p = await heavyPlayer();
    const tail = [...filler(3, 6), round('wen', [['wen-pear-neck', 0]])];
    await post(p.cookie, tail);
    const c = await cat();
    const hash = catalogueHash(c, loop.rewards, loop.thresholds);
    // A drizzle instance on the same client that records every query it sends.
    const queries: { query: string; params: unknown[] }[] = [];
    const spied = drizzle(sql, { schema, logger: { logQuery: (query, params) => queries.push({ query, params }) } }) as unknown as Db;
    const fromSnapshot = await spied.transaction(async (tx: Tx) => {
      queries.length = 0;
      const history = await loadHistoryWithSnapshot(tx, config.keyring, p.id, c, hash);
      return { history, queries: [...queries] };
    });
    expect(fromSnapshot.history.base).not.toBeNull();
    expect(fromSnapshot.history.events.map((e) => e.id)).toEqual(tail.map((e) => e.id));
    // The only read of progress_events is the tail, by seq; grants are read only for the tail's event rows.
    const eventReads = fromSnapshot.queries.filter((q) => /from "progress_events"/.test(q.query));
    expect(eventReads).toHaveLength(1);
    expect(eventReads[0].query).toMatch(/"progress_events"\."seq" > \$2/);
    const grantReads = fromSnapshot.queries.filter((q) => /from "reward_grants"/.test(q.query));
    expect(grantReads).toHaveLength(1);
    expect(grantReads[0].query).toMatch(/"reward_grants"\."event_id" in/);
    // The same view as the full read, through the route and directly.
    const full = deriveProgress(await loadFullHistory(db, config.keyring, p.id), c);
    expect(deriveProgress(fromSnapshot.history, c)).toEqual(full);
    expect(await view(p.cookie)).toEqual(full);
    expect(await db.transaction((tx: Tx) => progressViewOf(tx, config.keyring, p.id, c, { rewards: loop.rewards, thresholds: loop.thresholds }))).toEqual(full);
    // And what a next event earns is the same from either history (a replayed id is a duplicate through the snapshot).
    const replay = await post(p.cookie, [tail[0], ...filler(1, 7)]);
    expect(replay.duplicate).toEqual([tail[0].id]);
    expect(replay.accepted).toHaveLength(1);
    expect(replay.view).toEqual(deriveProgress(await loadFullHistory(db, config.keyring, p.id), c));
  });

  it('DELETE /meals/:id (cascade) drops the snapshot in the same transaction; the next read rebuilds; XP unchanged', async () => {
    const p = await heavyPlayer();
    const before = await view(p.cookie);
    expect(await snapshotRow(p.id)).toBeDefined();
    // Inside one transaction: the meal log's delete cascades to its event, and the trigger drops the snapshot there and
    // then; rolled back, both come back.
    await expect(
      db.transaction(async (tx: Tx) => {
        await deleteMealLogIn(tx, p.id, p.mealId, NOW);
        expect(await tx.select().from(progressSnapshots).where(eq(progressSnapshots.userId, p.id))).toEqual([]);
        expect((await tx.select().from(progressEvents).where(eq(progressEvents.mealLogId, p.mealId))).length).toBe(0);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await snapshotRow(p.id)).toBeDefined();
    // Through the route.
    expect((await call(p.cookie, { method: 'DELETE', url: `/meals/${p.mealId}` })).statusCode).toBe(204);
    expect(await snapshotRow(p.id)).toBeUndefined();
    const after = await view(p.cookie);
    expect(after.xp).toBe(before.xp);
    expectNoLower(before, after);
    expect(after).toEqual(deriveProgress(await loadFullHistory(db, config.keyring, p.id), await cat()));
    // The next post rebuilds it from the ledgers (more than SNAPSHOT_EVERY events since the start).
    await post(p.cookie, filler(1, 8));
    const rebuilt = (await snapshotRow(p.id))!;
    expect(rebuilt).toBeDefined();
    const c = await cat();
    const full = await loadFullHistory(db, config.keyring, p.id);
    // Rebuilt without the erased event: the fold of what the ledgers hold now, its id still seen through its grant.
    const opened = await openFor<{ view: ProgressView; facts: unknown }>(db, config.keyring, { table: 'progress_snapshots', userId: p.id, rowId: p.id }, rebuilt.sealed);
    expect(opened).toEqual(compactHistory(full, 0, c).base);
    expect(full.events.some((e) => e.kind === 'meal_logged')).toBe(false);
    expect(JSON.stringify(opened.facts)).not.toContain(p.mealId);
    const final = await view(p.cookie);
    expectNoLower(after, final);
    expect(final).toEqual(deriveProgress(full, c));
  });

  it('health_data withdraw-with-delete drops the snapshot; sealed stall rounds erased; view ≥ before', async () => {
    const p = await heavyPlayer();
    const before = await view(p.cookie);
    expect(await snapshotRow(p.id)).toBeDefined();
    // consent/health-data.ts needs no code for it: its delete of the meal_logged and stall_round events fires the trigger.
    expect((await call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } })).statusCode).toBe(204);
    expect(await snapshotRow(p.id)).toBeUndefined();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from progress_events where user_id = ${p.id} and kind in ('stall_round', 'meal_logged')`;
    expect(n).toBe(0);
    const after = await view(p.cookie);
    expectNoLower(before, after);
    expect(after.xp).toBe(before.xp);
    expect(after.stamps).toBe(before.stamps);
  });

  it('a rewards.yaml retune changes catalogue_hash → snapshot ignored and rebuilt; no derived value drops', async () => {
    const p = await heavyPlayer();
    const before = await view(p.cookie);
    const old = (await snapshotRow(p.id))!;
    const retuned: LoopContent = { ...loop, rewards: { ...loop.rewards, xp: { ...loop.rewards.xp, lesson: loop.rewards.xp.lesson + 7, cook: 1 } } };
    await boot({ loop: retuned });
    const c = catalogueFor(await createRecipeIndexSource().current(db), retuned);
    const hash = catalogueHash(c, retuned.rewards, retuned.thresholds);
    expect(hash).not.toBe(old.catalogueHash);
    // A different hash: the read ignores the snapshot (the full read) and gives the same view (grants are fixed).
    expect((await loadHistoryWithSnapshot(db, config.keyring, p.id, c, hash)).base).toBeNull();
    const read = await view(p.cookie);
    expect(read).toEqual(before);
    // The next post rewrites it under the new hash; nothing drops.
    await post(p.cookie, filler(2, 9));
    const fresh = (await snapshotRow(p.id))!;
    expect(fresh.catalogueHash).toBe(hash);
    expect(fresh.uptoSeq).toBeGreaterThan(old.uptoSeq);
    const after = await view(p.cookie);
    expectNoLower(before, after);
    expect(after).toEqual(deriveProgress(await loadFullHistory(db, config.keyring, p.id), c));
    // The thresholds are in the hash too.
    expect(catalogueHash(c, retuned.rewards, { ...retuned.thresholds, rustyAfterDays: 121 })).not.toBe(hash);
  });

  it('a snapshot that fails to unseal is deleted and the full read is used', async () => {
    const logs = captureLogs();
    await boot({ logger: logs.logger });
    const p = await heavyPlayer();
    const before = await view(p.cookie);
    // Flip a byte of the ciphertext: it no longer opens.
    await sql`update progress_snapshots set sealed = set_byte(sealed, length(sealed) - 1, (get_byte(sealed, length(sealed) - 1) + 1) % 256) where user_id = ${p.id}`;
    expect(await view(p.cookie)).toEqual(before);
    expect(await snapshotRow(p.id)).toBeUndefined();
    const text = logs.text();
    expect(text).toMatch(/progress snapshot unreadable/);
    expect(text).not.toMatch(/parippu|onigiri|bram|parmesan|wen-|leela/i);
    // A snapshot under another player's AAD (copied over) is unreadable too, on the post path as well.
    const q = await heavyPlayer();
    const other = (await snapshotRow(q.id))!;
    await post(q.cookie, filler(1, 10));
    await sql`update progress_snapshots set sealed = ${other.sealed} where user_id = ${q.id}`;
    const r = await heavyPlayer();
    await sql`update progress_snapshots set sealed = ${other.sealed} where user_id = ${r.id}`;
    const rBefore = deriveProgress(await loadFullHistory(db, config.keyring, r.id), await cat());
    expect((await post(r.cookie, filler(1, 11))).view.xp).toBeGreaterThanOrEqual(rBefore.xp);
    // Replaced on that post (a full read past the threshold), and it opens again.
    const replaced = (await snapshotRow(r.id))!;
    expect(replaced.sealed.equals(other.sealed)).toBe(false);
    await expect(openFor(db, config.keyring, { table: 'progress_snapshots', userId: r.id, rowId: r.id }, replaced.sealed)).resolves.toHaveProperty('view');
  });

  it('export has progress.snapshot decrypted; DELETE /me leaves no progress_snapshots row', async () => {
    const empty = await player();
    expect((await call(empty.cookie, { method: 'GET', url: '/me/export' })).json<{ progress: { snapshot: unknown } }>().progress.snapshot).toBeNull();
    const p = await heavyPlayer();
    const row = (await snapshotRow(p.id))!;
    const x = (await call(p.cookie, { method: 'GET', url: '/me/export' })).json<{
      progress: { view: ProgressView; snapshot: { uptoSeq: number; catalogueHash: string; createdAt: string; view: ProgressView; facts: unknown } };
    }>();
    expect(x.progress.snapshot).toMatchObject({ uptoSeq: row.uptoSeq, catalogueHash: row.catalogueHash, createdAt: NOW.toISOString() });
    expect(x.progress.snapshot.view).toEqual(x.progress.view);
    expect(x.progress.snapshot.facts).toHaveProperty('ids');
    expect((await call(p.cookie, { method: 'DELETE', url: '/me', payload: { confirm: 'delete my account' } })).statusCode).toBe(204);
    expect(await sql`select 1 from progress_snapshots where user_id = ${p.id}`).toHaveLength(0);
  });

  it('concurrent POST /progress/events (two connections) → one consistent snapshot, lock order holds', async () => {
    const p = await player();
    await postAll(p.cookie, filler(SNAPSHOT_EVERY - 10));
    expect(await snapshotRow(p.id)).toBeUndefined();
    // Two posts at once, each taking the tail past the threshold: both succeed (no deadlock), and one snapshot remains.
    const [a, b] = await Promise.all([post(p.cookie, filler(20, 12)), post(p.cookie, filler(20, 14))]);
    expect(a.accepted).toHaveLength(20);
    expect(b.accepted).toHaveLength(20);
    const rows = await db.select().from(progressSnapshots).where(eq(progressSnapshots.userId, p.id));
    expect(rows).toHaveLength(1);
    // The posts ran one after the other under progress:. The first to commit took the tail past SNAPSHOT_EVERY and
    // wrote the snapshot at its newest event; the second then had a tail of 20 and wrote nothing.
    const order = await sql<{ client_id: string; seq: number }[]>`select client_id, seq::int from progress_events where user_id = ${p.id} order by seq`;
    expect(order).toHaveLength(SNAPSHOT_EVERY + 30);
    expect(rows[0].uptoSeq).toBe(order[SNAPSHOT_EVERY + 9].seq);
    const c = await cat();
    const opened = await openFor<{ view: ProgressView; facts: unknown }>(db, config.keyring, { table: 'progress_snapshots', userId: p.id, rowId: p.id }, rows[0].sealed);
    const full = await loadFullHistory(db, config.keyring, p.id);
    // It is exactly the fold of the events up to upto_seq (and their grants), the C15 base.
    const prefix = new Set(order.filter((o) => o.seq <= rows[0].uptoSeq).map((o) => o.client_id));
    expect(opened).toEqual(compactHistory({ events: full.events.filter((e) => prefix.has(e.id)), grants: full.grants.filter((g) => prefix.has(g.eventId)), base: null }, 0, c).base);
    expect(await view(p.cookie)).toEqual(deriveProgress(full, c));
  });
});

describe('every event delete relies on the trigger (Ruling 18)', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));
  const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') || p.endsWith('.sql') ? [p] : [];
    });

  it('each delete(progressEvents) in apps/api/src runs in a transaction, and the trigger is never disabled', () => {
    const hits = files(SRC).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ f: relative(SRC, f), i, line }))
        .filter((h) => /\.delete\(progressEvents\)/.test(h.line)),
    );
    // The one direct delete: the health_data erase, which runs inside the withdraw's transaction (a `tx`).
    expect(hits.map((h) => h.f)).toEqual(['consent/health-data.ts']);
    for (const h of hits) expect(readFileSync(join(SRC, h.f), 'utf8').split('\n').slice(Math.max(0, h.i - 3), h.i + 1).join('\n'), h.f).toMatch(/\btx\b/);
    // No raw SQL deletes events either, and nothing anywhere disables a trigger.
    for (const f of files(SRC)) expect(readFileSync(f, 'utf8'), f).not.toMatch(/delete\s+from\s+"?progress_events/i);
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    for (const f of [...files(SRC), ...files(MIGRATIONS), ...files(join(repo, 'apps/api/scripts'))]) expect(readFileSync(f, 'utf8'), f).not.toMatch(/disable\s+trigger/i);
  });

  it('the trigger is in the database, AFTER DELETE FOR EACH ROW on progress_events', async () => {
    const rows = await sql<{ tgname: string; tgenabled: string; action_timing: string; event_manipulation: string; action_orientation: string }[]>`
      select t.tgname, t.tgenabled, i.action_timing, i.event_manipulation, i.action_orientation
      from pg_trigger t join information_schema.triggers i on i.trigger_name = t.tgname
      where t.tgname = 'progress_events_drop_snapshot'`;
    expect(rows).toEqual([{ tgname: 'progress_events_drop_snapshot', tgenabled: 'O', action_timing: 'AFTER', event_manipulation: 'DELETE', action_orientation: 'ROW' }]);
  });
});
