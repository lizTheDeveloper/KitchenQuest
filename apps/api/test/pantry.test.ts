// M4 Step 5: the sealed pantry (H-11). Account-only: no health_data consent, but an explicit flag.
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import type { Tx } from '../src/consent/ledger.js';
import { auditEvents, pantryItems, selfReadCounts } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { MAX_PANTRY_ITEMS, restorePantryIn } from '../src/pantry/service.js';
import { loadPantry } from '../src/pantry/store.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { captureLogs } from './helpers/logs.js';

const config = testConfig();
const NOW = new Date('2026-11-09T12:00:00Z');

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
  let tick = 0;
  app = await buildApp({ config, db, mailer, ai: null, now: () => new Date(NOW.getTime() + tick++), logger: false });
});
afterEach(async () => {
  await app?.close();
});

const call = (cookie: string | null, opts: InjectOptions) =>
  app.inject({ ...opts, ...(cookie ? { cookies: { kq_session: cookie } } : {}) });

const player = () => signIn(app, mailer, `pantry${++seq}@example.com`);
const userIdOf = async (cookie: string) => (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;

interface Item {
  id: string;
  name: string;
  ingredientId: string | null;
}
interface Change {
  add?: { name: string; ingredientId: string | null }[];
  removeNames?: string[];
  removeIds?: string[];
}
const OMIT = Symbol('omit confirmed');
const change = (cookie: string | null, c: Change, confirmed: unknown = true) =>
  call(cookie, {
    method: 'POST',
    url: '/pantry/changes',
    payload: { add: c.add ?? [], removeNames: c.removeNames ?? [], removeIds: c.removeIds ?? [], ...(confirmed === OMIT ? {} : { confirmed }) },
  });
const items = async (cookie: string) => (await call(cookie, { method: 'GET', url: '/pantry' })).json<{ items: Item[] }>().items;
const item = (name: string, ingredientId: string | null = null) => ({ name, ingredientId });

describe('pantry', () => {
  it('adds sealed items with no consent: the column holds no plaintext; GET counts a self-read', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    const res = await change(c, { add: [item('Oat milk'), item('Peanut butter', 'peanut')] });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Item[]; removed: Item[] }>();
    expect(body.removed).toEqual([]);
    expect(body.items.map(({ name, ingredientId }) => ({ name, ingredientId })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      item('Oat milk'),
      item('Peanut butter', 'peanut'),
    ]);
    expect(await items(c)).toEqual(expect.arrayContaining(body.items));
    const raw = await sql<{ sealed: Buffer }[]>`select sealed from pantry_items where user_id = ${uid}`;
    expect(raw).toHaveLength(2);
    for (const r of raw) expect(r.sealed.toString('latin1')).not.toMatch(/peanut|oat/i);
    const reads = await db.select().from(selfReadCounts).where(eq(selfReadCounts.userId, uid));
    expect(reads).toEqual([{ userId: uid, resource: 'pantry', day: '2026-11-09', count: 1 }]);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, uid));
    expect(events.filter((e) => e.action.startsWith('pantry.')).map((e) => e.action)).toEqual(['pantry.change']);
  });

  it('needs a session and confirmed: true; nothing stored without it', async () => {
    expect((await change(null, { add: [item('Milk')] })).statusCode).toBe(401);
    expect((await call(null, { method: 'GET', url: '/pantry' })).statusCode).toBe(401);
    const c = await player();
    for (const confirmed of [OMIT, false, 'true']) {
      const res = await change(c, { add: [item('Milk')] }, confirmed);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('confirmation_required');
    }
    expect(await items(c)).toEqual([]);
  });

  it('validates names, ingredient ids and the body shape', async () => {
    const c = await player();
    const bad: unknown[] = [
      { add: [item('')], removeNames: [], removeIds: [] },
      { add: [item('   ')], removeNames: [], removeIds: [] },
      { add: [item('x'.repeat(81))], removeNames: [], removeIds: [] },
      { add: [item('Kiwi', 'kiwi_not_in_graph')], removeNames: [], removeIds: [] },
      { add: [{ name: 'Milk' }], removeNames: [], removeIds: [] },
      { add: [{ ...item('Milk'), note: 'x' }], removeNames: [], removeIds: [] },
      { add: [], removeNames: [], removeIds: [], extra: 1 },
      { add: [] },
    ];
    for (const payload of bad) {
      const res = await call(c, { method: 'POST', url: '/pantry/changes', payload: { ...(payload as object), confirmed: true } });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    expect(await items(c)).toEqual([]);
    // An 80-character name, trimmed, is fine.
    const ok = await change(c, { add: [item(` ${'x'.repeat(80)} `)] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items[0].name).toBe('x'.repeat(80));
  });

  it(`pantry add, remove by name, cap at ${MAX_PANTRY_ITEMS} under concurrency`, async () => {
    const c = await player();
    const filler = Array.from({ length: MAX_PANTRY_ITEMS - 1 }, (_, i) => item(`thing ${i}`));
    expect((await change(c, { add: filler })).statusCode).toBe(200);
    const [a, b] = await Promise.all([change(c, { add: [item('Rice')] }), change(c, { add: [item('Beans')] })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const refused = a.statusCode === 400 ? a : b;
    expect(refused.json().error).toMatchObject({ code: 'too_many_items', details: { max: MAX_PANTRY_ITEMS } });
    expect(await items(c)).toHaveLength(MAX_PANTRY_ITEMS);
    // At the cap, a remove and an add in one change still fits.
    const swap = await change(c, { add: [item('Lentils')], removeNames: ['thing 0'] });
    expect(swap.statusCode).toBe(200);
    expect(swap.json().removed).toEqual([expect.objectContaining({ name: 'thing 0' })]);
    expect(swap.json().items).toHaveLength(MAX_PANTRY_ITEMS);
    expect((await change(c, { add: [item('Oats')] })).statusCode).toBe(400);
  });

  it('"milk" removes the item named Milk; an unmatched name changes nothing', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    const added = (await change(c, { add: [item('Milk'), item('Eggs')] })).json<{ items: Item[] }>().items;
    const before = (await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, uid))).length;
    const none = await change(c, { removeNames: ['kiwi'], removeIds: ['00000000-0000-4000-8000-000000000000', 'nope'] });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ items: added, removed: [] });
    // Nothing changed, so nothing is audited.
    expect((await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, uid))).length).toBe(before);
    const res = await change(c, { removeNames: ['  MILK '] });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toEqual([added.find((i) => i.name === 'Milk')]);
    expect(res.json().items).toEqual([added.find((i) => i.name === 'Eggs')]);
  });

  it('a name that resolves in the graph also removes items with that ingredient id', async () => {
    const c = await player();
    const graph = defaultCatalog().graph;
    expect(graph.resolve('milk')).toBe('milk');
    await change(c, { add: [item('Semi-skimmed', 'milk'), item('Oat drink')] });
    const res = await change(c, { removeNames: ['milk'] });
    expect(res.json().removed).toEqual([expect.objectContaining({ name: 'Semi-skimmed', ingredientId: 'milk' })]);
    expect((await items(c)).map((i) => i.name)).toEqual(['Oat drink']);
  });

  it('undo by id never removes a same-name item that was already there', async () => {
    const c = await player();
    const a = (await change(c, { add: [item('milk')] })).json<{ items: Item[] }>().items[0];
    const after = (await change(c, { add: [item('milk')] })).json<{ items: Item[] }>().items;
    const b = after.find((i) => i.id !== a.id)!;
    const undo = await change(c, { removeIds: [b.id] });
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toEqual({ items: [a], removed: [b] });
  });

  it("another player's ids are never touched", async () => {
    const a = await player();
    const b = await player();
    const mine = (await change(a, { add: [item('Milk')] })).json<{ items: Item[] }>().items[0];
    const res = await change(b, { removeIds: [mine.id], removeNames: ['milk'] });
    expect(res.json()).toEqual({ items: [], removed: [] });
    expect(await items(a)).toEqual([mine]);
  });

  it('restorePantryIn puts removed items back and drops the added ids', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    await change(c, { add: [item('Milk'), item('Eggs')] });
    const res = (await change(c, { add: [item('Bread')], removeNames: ['milk'] })).json<{ items: Item[]; removed: Item[] }>();
    const bread = res.items.find((i) => i.name === 'Bread')!;
    await db.transaction((tx: Tx) =>
      restorePantryIn(
        tx,
        { keyring: config.keyring, catalog: defaultCatalog() },
        uid,
        res.removed.map(({ name, ingredientId }) => ({ name, ingredientId })),
        [bread.id],
        NOW,
      ),
    );
    expect((await loadPantry(db, config.keyring, uid)).map((i) => i.name).sort()).toEqual(['Eggs', 'Milk']);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, uid));
    expect(events.at(-1)?.action).toBe('pantry.restore');
  });

  it('C-9: a pantry change leaves no item names in the captured logs', async () => {
    const logs = captureLogs();
    const logged = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: logs.logger });
    try {
      const cookies = { kq_session: await signIn(logged, mailer, `plogs${++seq}@example.com`) };
      const send = (payload: object) => logged.inject({ method: 'POST', url: '/pantry/changes', cookies, payload });
      const res = await Promise.all([
        send({ add: [item('Peanut butter')], removeNames: [], removeIds: [], confirmed: true }),
        send({ add: [item('Peanut butter', 'peanut-x')], removeNames: [], removeIds: [], confirmed: true }),
        send({ add: [item('Peanut butter')], removeNames: ['peanut'], removeIds: [] }),
      ]);
      expect(res.map((r) => r.statusCode)).toEqual([200, 400, 400]);
      expect((await logged.inject({ method: 'GET', url: '/pantry', cookies })).statusCode).toBe(200);
      expect(logs.lines().length).toBeGreaterThan(3);
      expect(logs.text()).not.toMatch(/peanut/i);
    } finally {
      await logged.close();
    }
  });
});

describe('pantry rows', () => {
  it('stores one row per item, owned by the player', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    await change(c, { add: [item('Milk')] });
    const rows = await db.select().from(pantryItems).where(eq(pantryItems.userId, uid));
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });
});
