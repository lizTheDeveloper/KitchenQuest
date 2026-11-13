// M6 Step 6: stall rounds rewarded by core against the stall files loaded at boot; every round sealed at rest; a
// Protein Counter round needs health_data (Ruling 17); a health_data delete erases every round, grants kept.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProgressView, RewardGrant } from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog, defaultLoopContent, loadLoopContent } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { progressEvents, rewardGrants } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { catalogueFor } from '../src/progress/catalogue.js';
import { openEventBody } from '../src/progress/seal.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const config = testConfig();
const catalog = defaultCatalog();
const NOW = new Date('2026-11-10T12:00:00Z'); // a Tuesday
const TODAY = '2026-11-10';
const NEXT_WEEK = '2026-11-17';
const PARIPPU = 'india/kerala/parippu';
const NO_MEAT = { target: { kind: 'ingredient', ids: ['meat'] }, type: 'avoid', severity: 'preference' };
const NO_SOY = { target: { kind: 'ingredient', ids: ['soy'] }, type: 'avoid', severity: 'allergy' };

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
beforeEach(async () => {
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false });
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

async function player(opts: { consent?: boolean } = {}): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app, mailer, `market${++seq}@example.com`);
  const id = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  if (opts.consent !== false) await consent(cookie);
  return { cookie, id };
}
async function consent(cookie: string) {
  const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } });
  expect(res.statusCode, res.body).toBe(201);
}
const withdraw = (cookie: string, healthData: 'keep' | 'delete') => call(cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData } });
async function addRule(cookie: string, rule: unknown) {
  const res = await call(cookie, { method: 'POST', url: '/rules', payload: { rule, confirmed: true } });
  expect(res.statusCode, res.body).toBe(201);
}
async function post(cookie: string, events: unknown[]): Promise<Posted> {
  const res = await call(cookie, { method: 'POST', url: '/progress/events', payload: { events } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Posted>();
}
const view = async (cookie: string) => (await call(cookie, { method: 'GET', url: '/progress' })).json<{ view: ProgressView }>().view;
const eventRows = (userId: string) => db.select().from(progressEvents).where(eq(progressEvents.userId, userId));
const grantRows = (userId: string) => db.select().from(rewardGrants).where(eq(rewardGrants.userId, userId));

const round = (stall: string, answers: [string, number][], at = TODAY, id = randomUUID()) => ({
  id,
  kind: 'stall_round' as const,
  at,
  stall,
  answers: answers.map(([q, pick]) => ({ q, pick })),
});
/** Grants without their ids (`<eventId>#n`) and days, for comparing what an event earned. */
const earned = (gs: RewardGrant[]) => gs.map(({ id: _id, eventId: _e, isoDay: _d, ...g }) => g);

describe('stall rounds (M6 Step 6)', () => {
  it('stall_round: a correct first answer → 5 XP and the weekly stall stamp; the same again → nothing more; wrong → stamp only', async () => {
    const p = await player({ consent: false });
    const first = round('wen', [['wen-avocado-ripe', 0]]);
    const a = await post(p.cookie, [first]);
    expect(a.rejected).toEqual([]);
    expect(earned(a.accepted[0].grants)).toEqual([
      { kind: 'xp', amount: 5, reason: 'market_game' },
      { kind: 'stamp', stamp: 'market_game' },
    ]);
    expect(a.view).toMatchObject({ xp: 5, stamps: 1 });
    // The same question, right again, the same week: accepted, earns nothing (first-correct is once ever; one stamp a stall a week).
    const b = await post(p.cookie, [round('wen', [['wen-avocado-ripe', 0]])]);
    expect(b.accepted).toHaveLength(1);
    expect(b.accepted[0].grants).toEqual([]);
    // Another stall, a wrong answer: the stall's stamp for the week, no XP and nothing lowered.
    const c = await post(p.cookie, [round('spice', [['spice-sniff-cumin', 1]])]);
    expect(earned(c.accepted[0].grants)).toEqual([{ kind: 'stamp', stamp: 'market_game' }]);
    expect(c.view).toMatchObject({ xp: 5, stamps: 2 });
    // A new question at Wen the same week: its XP only, no second stamp.
    const d = await post(p.cookie, [round('wen', [['wen-pear-neck', 0], ['wen-avocado-ripe', 0]])]);
    expect(earned(d.accepted[0].grants)).toEqual([{ kind: 'xp', amount: 5, reason: 'market_game' }]);
    // The M5 date floor holds for rounds too: past today + 1 is bad_date, nothing stored.
    const late = round('wen', [['wen-lemon-juicy', 0]], NEXT_WEEK);
    expect((await post(p.cookie, [late])).rejected).toEqual([{ clientId: late.id, problems: ['bad_date'] }]);
    expect(await view(p.cookie)).toMatchObject({ xp: 10, stamps: 2 });
    expect(await eventRows(p.id)).toHaveLength(4);
  });

  it('a forged correct flag / an unknown question / a question the player\'s rules hide → rejected bad_event, nothing stored', async () => {
    const p = await player();
    await addRule(p.cookie, NO_SOY);
    const forged = [
      { ...round('wen', [['wen-avocado-ripe', 1]]), answers: [{ q: 'wen-avocado-ripe', pick: 1, correct: true }] },
      { ...round('wen', [['wen-avocado-ripe', 1]]), score: 5 },
      round('wen', [['wen-avocado-ripe', 4]]), // a pick past the options
      round('wen', [['wen-avocado-ripe', 0], ['wen-avocado-ripe', 1]]), // a question twice
      round('wen', []), // no answers
      round('wen', Array.from({ length: 11 }, (_, i): [string, number] => [`q${i}`, 0])), // past MAX_ROUND_ANSWERS
      round('fishmonger', [['wen-avocado-ripe', 0]]), // not a stall
      round('wen', [['wen-no-such-question', 0]]), // not a question of the stall
      round('wen', [['spice-sniff-cumin', 0]]), // another stall's question
      round('okafor-sato', [['os-mapo-tofu', 0]]), // tofu under a soy rule: never shown, so never answered
      round('bram', [['bram-pc-parmesan', 0]]), // a Protein Counter question while the rules don't exclude meat
    ];
    const res = await post(p.cookie, forged);
    expect(res.accepted).toEqual([]);
    // Shape problems are found before core's, so the order differs from the order sent: compare as sets.
    expect(res.rejected.map((r) => r.problems)).toEqual(forged.map(() => ['bad_event']));
    expect(res.rejected.map((r) => r.clientId).sort()).toEqual(forged.map((e) => e.id).sort());
    expect(await eventRows(p.id)).toEqual([]);
    expect(await grantRows(p.id)).toEqual([]);
    // A base Bram question once the rules exclude meat (the player sees the Protein Counter instead).
    await addRule(p.cookie, NO_MEAT);
    const base = round('bram', [['bram-sear-cut', 0]]);
    // And a Protein Counter question the rules hide (gelatin under "no meat").
    const gelatin = round('bram', [['bram-pc-gelatin', 0]]);
    expect((await post(p.cookie, [base, gelatin])).rejected).toEqual([
      { clientId: base.id, problems: ['bad_event'] },
      { clientId: gelatin.id, problems: ['bad_event'] },
    ]);
    expect(await eventRows(p.id)).toEqual([]);
  });

  it('Protein Counter round: stored with body {} and sealed non-null; progress_events has no plaintext "protein_counter" or question id', async () => {
    const p = await player();
    await addRule(p.cookie, NO_MEAT);
    const pc = round('bram', [['bram-pc-parmesan', 0], ['bram-pc-tempeh', 2]]);
    const base = round('wen', [['wen-avocado-ripe', 0]]);
    const res = await post(p.cookie, [pc, base]);
    expect(res.rejected).toEqual([]);
    expect(res.accepted.map((a) => a.clientId)).toEqual([pc.id, base.id]);
    const rows = await eventRows(p.id);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.kind).toBe('stall_round');
      expect(r.body).toEqual({});
      expect(r.sealed).toBeInstanceOf(Buffer);
    }
    for (const word of ['protein_counter', 'bram', 'wen', 'parmesan', 'tempeh', 'avocado', 'pick']) {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from progress_events r where position(${word} in r::text) > 0`;
      expect(n, word).toBe(0);
      const [{ m }] = await sql<{ m: number }[]>`select count(*)::int as m from reward_grants r where position(${word} in r::text) > 0`;
      expect(m, word).toBe(0);
    }
    // The seal is bound to its row: moved to the other row, it doesn't open.
    const [one, two] = rows;
    await expect(openEventBody(db, config.keyring, p.id, one.id, one.sealed!)).resolves.toHaveProperty('stall');
    await expect(openEventBody(db, config.keyring, p.id, two.id, one.sealed!)).rejects.toThrow();
    // The database refuses an unsealed round and a sealed event of another kind.
    await expect(sql`insert into progress_events (user_id, client_id, kind, at, body) values (${p.id}, ${randomUUID()}, 'stall_round', ${TODAY}, '{}')`).rejects.toThrow(/progress_events_sealed_check/);
    await expect(
      sql`insert into progress_events (user_id, client_id, kind, at, body, sealed) values (${p.id}, ${randomUUID()}, 'lesson', ${TODAY}, '{}', ${one.sealed})`,
    ).rejects.toThrow(/progress_events_sealed_check/);
    // Read back opened: the view counts them (5 XP each for parmesan and avocado; tempeh pick 2 is wrong).
    expect(await view(p.cookie)).toMatchObject({ xp: 10, stamps: 2 });
    // A replay of a stored round is a duplicate, found through the sealed history.
    expect((await post(p.cookie, [pc])).duplicate).toEqual([pc.id]);
  });

  it('Protein Counter round without health_data → rejected consent_required; with it → accepted', async () => {
    const p = await player();
    await addRule(p.cookie, NO_MEAT);
    expect((await withdraw(p.cookie, 'keep')).statusCode).toBe(204);
    const pc = round('bram', [['bram-pc-paneer', 0]]);
    const unknown = round('bram', [['bram-pc-no-such', 0]]); // fail closed: a question the catalogue doesn't hold counts as revealing
    const base = round('wen', [['wen-avocado-ripe', 0]]);
    const res = await post(p.cookie, [pc, unknown, base]);
    expect(res.rejected).toEqual([
      { clientId: pc.id, problems: ['consent_required'] },
      { clientId: unknown.id, problems: ['consent_required'] },
    ]);
    // A base round needs no consent (Ruling 17), and is sealed all the same.
    expect(res.accepted.map((a) => a.clientId)).toEqual([base.id]);
    const [stored] = await eventRows(p.id);
    expect(stored).toMatchObject({ kind: 'stall_round', body: {} });
    expect(stored.sealed).not.toBeNull();
    await consent(p.cookie);
    const again = await post(p.cookie, [pc]);
    expect(again.rejected).toEqual([]);
    expect(earned(again.accepted[0].grants)).toEqual([
      { kind: 'xp', amount: 5, reason: 'market_game' },
      { kind: 'stamp', stamp: 'market_game' },
    ]);
  });

  it('health_data withdraw-with-delete erases sealed stall rounds; XP, level and stamps unchanged (grants kept)', async () => {
    const p = await player();
    await addRule(p.cookie, NO_MEAT);
    const cooked = { id: randomUUID(), kind: 'cooked', at: TODAY, recipe: PARIPPU, planned: false };
    const res = await post(p.cookie, [
      round('bram', [['bram-pc-parmesan', 0], ['bram-pc-paneer', 0]]),
      round('wen', [['wen-avocado-ripe', 0], ['wen-pear-neck', 0]]),
      cooked,
    ]);
    expect(res.rejected).toEqual([]);
    const before = await view(p.cookie);
    expect(before.xp).toBeGreaterThanOrEqual(20); // four first-correct answers, and the cook's own
    const grantsBefore = await grantRows(p.id);
    expect((await withdraw(p.cookie, 'delete')).statusCode).toBe(204);
    // Every round is gone, base rounds too; the cook stays; no grant is touched.
    expect((await eventRows(p.id)).map((r) => r.kind)).toEqual(['cooked']);
    expect(await grantRows(p.id)).toEqual(grantsBefore);
    const after = await view(p.cookie);
    expect({ xp: after.xp, level: after.level, stamps: after.stamps }).toEqual({ xp: before.xp, level: before.level, stamps: before.stamps });
  });

  it('export shows the sealed round decrypted; DELETE /me leaves no progress_events row', async () => {
    const p = await player();
    const r = round('spice', [['spice-sniff-cumin', 0], ['spice-storage', 1]]);
    await post(p.cookie, [r]);
    const exp = await call(p.cookie, { method: 'GET', url: '/me/export' });
    expect(exp.statusCode, exp.body).toBe(200);
    const events = exp.json<{ progress: { events: unknown[] } }>().progress.events;
    expect(events).toEqual([{ ...r, createdAt: NOW.toISOString() }]);
    const del = await call(p.cookie, { method: 'DELETE', url: '/me', payload: { confirm: 'delete my account' } });
    expect(del.statusCode, del.body).toBe(204);
    expect(await eventRows(p.id)).toEqual([]);
    expect(await grantRows(p.id)).toEqual([]);
  });

  it('M7 Step 7 (M6 final M13): a Protein Counter round and a base round seal to the same length (one 1024-byte bucket) and open without the pad', async () => {
    const p = await player();
    await addRule(p.cookie, NO_MEAT);
    const pc = round('bram', [['bram-pc-parmesan', 0], ['bram-pc-tempeh', 2]]);
    const base = round('wen', [['wen-avocado-ripe', 0]]);
    const two = round('wen', [['wen-pear-neck', 0], ['wen-lemon-juicy', 0]]);
    expect((await post(p.cookie, [pc, base, two])).rejected).toEqual([]);
    const lengths = await sql<{ n: number }[]>`select octet_length(sealed)::int as n from progress_events where user_id = ${p.id} and kind = 'stall_round'`;
    expect(lengths).toHaveLength(3);
    expect(new Set(lengths.map((l) => l.n)).size).toBe(1);
    // AES-GCM adds the header, iv and tag to the 1024-byte plaintext: the padded JSON is exactly one bucket.
    for (const row of await eventRows(p.id)) {
      const body = await openEventBody(db, config.keyring, p.id, row.id, row.sealed!);
      expect(Object.keys(body)).not.toContain('_pad');
    }
    // They still read back whole: the view and the export are what was posted.
    expect(await view(p.cookie)).toMatchObject({ xp: 20 }); // parmesan, avocado, pear and lemon right first time
    const events = (await call(p.cookie, { method: 'GET', url: '/me/export' })).json<{ progress: { events: { id: string }[] } }>().progress.events;
    expect(events.find((e) => e.id === pc.id)).toEqual({ ...pc, createdAt: NOW.toISOString() });
  });

  it('M7 Step 7 (M6 final M12): recordedFacts\' two lookups use the new indexes (EXPLAIN), and behave as before', async () => {
    const p = await player({ consent: false });
    const imported = { id: randomUUID(), kind: 'imported', at: TODAY, technique: 'grains', tier: 'seen', firstAt: TODAY, lastUsedAt: TODAY, recipes: [] };
    const r = round('wen', [['wen-avocado-ripe', 0]]);
    const first = await call(p.cookie, { method: 'POST', url: '/progress/events', payload: { events: [r, imported], upload: true } });
    expect(first.statusCode, first.body).toBe(200);
    // Behaviour unchanged: the same ids again are duplicates; a second import of the technique is no new claim.
    const second = { ...imported, id: randomUUID() };
    const again = await call(p.cookie, { method: 'POST', url: '/progress/events', payload: { events: [r, second], upload: true } });
    expect(again.json<Posted>().duplicate).toEqual([r.id, second.id]);
    const plan = async (query: string, params: string[]): Promise<string> =>
      sql.begin(async (tx) => {
        await tx`set local enable_seqscan = off`;
        const rows = await tx.unsafe(`explain (format json) ${query}`, params);
        return JSON.stringify(rows);
      });
    // The exact shapes `recordedFacts` sends (progress/store.ts), with nothing to read from a meal log.
    const grants = await plan(`select "body"->>'eventId' from "reward_grants" where ("reward_grants"."user_id" = $1 and "reward_grants"."body"->>'eventId' in ($2, $3))`, [p.id, r.id, randomUUID()]);
    expect(grants).toContain('reward_grants_user_event_idx');
    const claims = await plan(`select "kind", "body"->>'technique', "meal_log_id" from "progress_events" where ("progress_events"."user_id" = $1 and ("progress_events"."kind" = 'imported' or false))`, [p.id]);
    expect(claims).toContain('progress_events_user_imported_idx');
  });

  it('M7 Step 7 (M6 fix review N1): every health_data delete gives the account a new erasure id, returned by GET /progress and POST /progress/events', async () => {
    const p = await player();
    const erasure = async () => (await call(p.cookie, { method: 'GET', url: '/progress' })).json<{ healthErasure: string | null }>().healthErasure;
    expect(await erasure()).toBeNull();
    await post(p.cookie, [round('wen', [['wen-avocado-ripe', 0]])]);
    expect((await withdraw(p.cookie, 'delete')).statusCode).toBe(204);
    const first = await erasure();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    // The same id until the next delete; a post answers with it too.
    expect(await erasure()).toBe(first);
    const posted = await call(p.cookie, { method: 'POST', url: '/progress/events', payload: { events: [round('wen', [['wen-pear-neck', 0]])] } });
    expect(posted.json<{ healthErasure: string | null }>().healthErasure).toBe(first);
    // A "keep" withdrawal erases nothing: no new id. A later delete ("delete health data now" or another withdrawal) does.
    await consent(p.cookie);
    expect((await withdraw(p.cookie, 'keep')).statusCode).toBe(204);
    expect(await erasure()).toBe(first);
    await consent(p.cookie);
    expect((await withdraw(p.cookie, 'delete')).statusCode).toBe(204);
    const second = await erasure();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    // Another player's erasure is never seen here.
    const q = await player();
    expect((await call(q.cookie, { method: 'GET', url: '/progress' })).json<{ healthErasure: string | null }>().healthErasure).toBeNull();
  });

  it('M7 Step 7 fix round 1 (I1): a post from a device that has not seen the current erasure id gets its stall rounds refused as erased; nothing of them is stored', async () => {
    const p = await player();
    await addRule(p.cookie, NO_MEAT);
    const postWith = (events: unknown[], erasure?: string | null) =>
      call(p.cookie, { method: 'POST', url: '/progress/events', payload: { events, ...(erasure === undefined ? {} : { erasure }) } });
    // Before any erasure, a post with no id (an older client, a new device) is accepted as before.
    expect((await postWith([round('wen', [['wen-avocado-ripe', 0]])])).json<Posted>().rejected).toEqual([]);
    // Device B, offline, plays a Protein Counter round and a base round; meanwhile device A deletes health data.
    const pc = round('bram', [['bram-pc-parmesan', 0]]);
    const base = round('wen', [['wen-pear-neck', 0]]);
    const cooked = { id: randomUUID(), kind: 'cooked', at: TODAY, recipe: PARIPPU, planned: false };
    expect((await withdraw(p.cookie, 'delete')).statusCode).toBe(204);
    await consent(p.cookie);
    const current = (await call(p.cookie, { method: 'GET', url: '/progress' })).json<{ healthErasure: string }>().healthErasure;
    // B comes back and uploads with the id it last saw (none): the rounds are refused, content-free; the cook is kept.
    for (const stale of [undefined, null, randomUUID()]) {
      const res = await postWith([pc, base, cooked], stale);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<Posted & { healthErasure: string }>();
      expect(body.rejected).toEqual([{ clientId: pc.id, problems: ['erased'] }, { clientId: base.id, problems: ['erased'] }]);
      expect(body.healthErasure).toBe(current);
    }
    expect((await eventRows(p.id)).map((r) => r.kind)).toEqual(['cooked']);
    // With the current id (B has erased its copy and plays again), a round is accepted.
    const fresh = round('wen', [['wen-lemon-juicy', 0]]);
    expect((await postWith([fresh], current)).json<Posted>().accepted.map((a) => a.clientId)).toEqual([fresh.id]);
    // The field is checked: anything but a string or null is a 400.
    expect((await postWith([], 7 as unknown as string)).statusCode).toBe(400);
  });

  it('Catalogue.market holds every boot-loaded stall, each question with its bank', () => {
    const loop = defaultLoopContent();
    expect([...loop.market.stalls.keys()].sort()).toEqual(['bram', 'okafor-sato', 'spice', 'wen']);
    expect(Object.keys(loop.market.seasonality)).toContain('pnw-usa');
    expect(Object.isFrozen(loop.market.stalls.get('wen'))).toBe(true);
    const bank = (stall: string, q: string) => cat.market?.get(stall)?.questions.get(q)?.variant;
    const cat = catalogueFor(new Map(), loop);
    expect(bank('bram', 'bram-pc-parmesan')).toBe('protein_counter');
    expect(bank('bram', 'bram-sear-cut')).toBe('base');
    expect(bank('wen', 'wen-pnw-11-squash')).toBe('seasonal');
  });
});

describe('boot validation of the stalls (M6 Step 6)', () => {
  const REPO = fileURLToPath(new URL('../../../', import.meta.url));
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kq-market-'));
    cpSync(join(REPO, 'data'), join(dir, 'data'), { recursive: true });
    cpSync(join(REPO, 'content'), join(dir, 'content'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const load = () => loadLoopContent(catalog, join(dir, 'data'), join(dir, 'content'));
  const edit = (rel: string, from: string, to: string) => {
    const path = join(dir, rel);
    const text = readFileSync(path, 'utf8');
    const next = text.replace(from, to);
    expect(next, `${rel} edit`).not.toBe(text);
    writeFileSync(path, next);
  };

  it('loads the repository stalls whole', () => {
    expect([...load().market.stalls.keys()]).toEqual(['bram', 'okafor-sato', 'spice', 'wen']);
  });

  it('boot refuses a stall file with an unknown contains id and names the file', () => {
    edit('content/market/wen.yaml', 'contains: [avocado]', 'contains: [no_such_food]');
    expect(load).toThrow(join(dir, 'content/market/wen.yaml'));
    expect(load).toThrow(/no_such_food/);
  });

  it.each([
    ['a seasonal question that disagrees with the table', 'content/market/wen.yaml', 'pnw-usa:\n    11:', 'nowhere-usa:\n    11:'],
    ['a bad season table', 'data/seasonality.yaml', 'id: pnw-usa', 'id: pnw'],
    ['a game the Bureau does not name', 'content/market/wen.yaml', 'game: ripeness', 'game: juggling'],
  ])('refuses %s, naming the file', (_label, rel, from, to) => {
    edit(rel, from, to);
    expect(load).toThrow(join(dir, rel));
  });

  it('refuses a question id at two stalls', () => {
    edit('content/market/spice.yaml', 'id: spice-sniff-cumin', 'id: wen-avocado-ripe');
    expect(load).toThrow(/wen-avocado-ripe/);
  });
});
