// M5 Step 7: sealed margin notes (H-12, Ruling 9, health data) and a name-free Shared Table (H-13, Ruling 10).
import { createHash } from 'node:crypto';
import type { CheckResult, MarginNote, ParsedRecipe, SharedTally } from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { audit } from '../src/audit/audit.js';
import { BOOK_REQUESTS_PER_MINUTE } from '../src/book/routes.js';
import { createNoteIn } from '../src/book/notes-service.js';
import { defaultCatalog } from '../src/catalog.js';
import { grantConsent } from '../src/consent/ledger.js';
import { NOTICES } from '../src/consent/notices.js';
import { ADVISORY_LOCK } from '../src/db/advisory-locks.js';
import { auditEvents, marginNotes, sharedTable } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { createRecipeIndexSource } from '../src/recipes/recipe-index.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { captureLogs } from './helpers/logs.js';

const config = testConfig();
const catalog = defaultCatalog();
const NOW = new Date('2026-11-10T12:00:00Z');
const TODAY = '2026-11-10';
const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const PEANUT = { target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'allergy' };
const MARKET_EVENT = { id: '6f1c2b7e-0d3a-4c55-9b8e-1a2b3c4d5e6f', kind: 'market_run', at: '2026-11-09', weekStart: '2026-11-09' };

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
const build = async (logger: Parameters<typeof buildApp>[0]['logger'] = false) => {
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger });
};
beforeEach(async () => {
  await build();
});
afterEach(async () => {
  await app?.close();
});

const call = (cookie: string | null, opts: InjectOptions) => app.inject({ ...opts, ...(cookie ? { cookies: { kq_session: cookie } } : {}) });
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest();

async function player(opts: { consent?: boolean } = {}): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app, mailer, `book${++seq}@example.com`);
  const id = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  if (opts.consent !== false) {
    const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } });
    expect(res.statusCode).toBe(201);
  }
  return { cookie, id };
}

const noteOf = (over: Partial<MarginNote> = {}): MarginNote => ({ recipe: PARIPPU, ops: [{ op: 'add', name: 'lime' }], text: null, at: TODAY, ...over });
const OMIT = Symbol('omit confirmed');
const postNote = (cookie: string, note: unknown, confirmed: unknown = true, extra: object = {}) =>
  call(cookie, { method: 'POST', url: '/notes', payload: { note, ...(confirmed === OMIT ? {} : { confirmed }), ...extra } });
const listNotes = async (cookie: string) => {
  const res = await call(cookie, { method: 'GET', url: '/notes' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ notes: (MarginNote & { id: string })[] }>().notes;
};
const entryOf = (over: object = {}) => ({ cookedOn: TODAY, recipe: PARIPPU, frame: null, cookedFor: { count: 'two_to_three', who: 'family' }, ...over });
const postShared = (cookie: string, entry: unknown, confirmed: unknown = true) =>
  call(cookie, { method: 'POST', url: '/shared-table', payload: { entry, ...(confirmed === OMIT ? {} : { confirmed }) } });
const tally = async (cookie: string) => {
  const res = await call(cookie, { method: 'GET', url: '/shared-table/tally' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<SharedTally>();
};
const rowsMentioning = async (table: string, word: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} r where position(lower(${word}) in lower(r::text)) > 0`)[0].n;

describe('margin notes', () => {
  it('a margin note round-trips sealed: margin_notes.sealed holds no "oat milk"', async () => {
    const p = await player();
    const note = noteOf({ ops: [{ op: 'swap', from: 'split moong dal', to: 'oat milk' }], text: 'less salt, oat milk was lovely' });
    const res = await postNote(p.cookie, note);
    expect(res.statusCode, res.body).toBe(201);
    const saved = res.json<{ note: MarginNote & { id: string; check: CheckResult } }>().note;
    expect(saved).toMatchObject({ ...note, id: expect.any(String) });
    expect(saved.check.status).toBeDefined();
    expect(await listNotes(p.cookie)).toEqual([{ ...note, id: saved.id }]);
    const [stored] = await db.select().from(marginNotes).where(eq(marginNotes.userId, p.id));
    // I1 (fix round 1): the recipe is sealed too; no column holds the slug, so a dump can't read "a note on this dish".
    expect(Object.keys(stored).sort()).toEqual(['createdAt', 'id', 'sealed', 'userId']);
    for (const word of ['oat milk', 'oat', 'salt', 'lovely', 'swap', 'moong', 'parippu', 'kerala', 'india']) {
      expect(stored.sealed.toString('latin1').toLowerCase()).not.toContain(word);
      expect(await rowsMentioning('margin_notes', word), word).toBe(0);
      expect(await rowsMentioning('audit_events', word), word).toBe(0);
    }
    // The reads are counted per day (C-5), as a self-read 'notes'.
    const [{ n }] = await sql<{ n: number }[]>`select coalesce(sum(count), 0)::int as n from self_read_counts where user_id = ${p.id} and resource = 'notes'`;
    expect(n).toBe(1);
    // Delete: 204, then gone; another's id or a malformed one is a 404.
    const other = await player();
    expect((await call(other.cookie, { method: 'DELETE', url: `/notes/${saved.id}` })).statusCode).toBe(404);
    expect((await call(p.cookie, { method: 'DELETE', url: '/notes/not-a-uuid' })).statusCode).toBe(404);
    expect((await call(p.cookie, { method: 'DELETE', url: `/notes/${saved.id}` })).statusCode).toBe(204);
    expect(await listNotes(p.cookie)).toEqual([]);
    expect((await call(p.cookie, { method: 'DELETE', url: `/notes/${saved.id}` })).statusCode).toBe(404);
  });

  it('note needs confirmed: true and health_data v3 consent; a v2 grant → 403 consent_required', async () => {
    const p = await player();
    for (const confirmed of [OMIT, false, 'yes']) {
      const res = await postNote(p.cookie, noteOf(), confirmed);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('confirmation_required');
    }
    expect(NOTICES.health_data!.version).toBe('v3');
    const none = await player({ consent: false });
    const refused = await postNote(none.cookie, noteOf());
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({ code: 'consent_required', details: { purpose: 'health_data' } });
    // A grant under the v2 notice no longer counts (re-consent path): 403, and GET /me/consents asks again.
    const old = await player({ consent: false });
    await grantConsent(db, old.id, 'health_data', 'v2', sha('the v2 notice'), 'tap', new Date(NOW.getTime() - 60_000));
    const stale = await postNote(old.cookie, noteOf());
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('consent_required');
    expect((await call(old.cookie, { method: 'GET', url: '/me/consents' })).json().needsReconsent).toEqual(['health_data']);
    expect(await db.select().from(marginNotes).where(eq(marginNotes.userId, old.id))).toEqual([]);
    // Reading and deleting need no consent (kept data stays readable and deletable).
    expect(await listNotes(none.cookie)).toEqual([]);
  });

  it('note on a sacred recipe → 400; 21st note on one recipe → 400 too_many_notes; text 281 chars → 400', async () => {
    const p = await player();
    // No launch recipe is sacred: the service is given an index in which parippu is.
    const index = await createRecipeIndexSource().current(db);
    const sacred = new Map<string, ParsedRecipe>(index);
    const r = sacred.get(PARIPPU)!;
    sacred.set(PARIPPU, { ...r, meta: { ...r.meta, sacred: true } });
    const refused = db.transaction((tx) => createNoteIn(tx, { keyring: config.keyring, catalog, recipes: sacred }, p.id, noteOf(), NOW));
    await expect(refused).rejects.toMatchObject({ status: 400, code: 'bad_request', details: { problems: ['note: sacred recipes take no margin notes'] } });

    const long = await postNote(p.cookie, noteOf({ text: 'x'.repeat(281) }));
    expect(long.statusCode).toBe(400);
    expect(long.json().error.code).toBe('bad_request');
    expect((await postNote(p.cookie, noteOf({ text: 'x'.repeat(280) }))).statusCode).toBe(201);
    for (const bad of [noteOf({ recipe: 'nowhere/never/stone-soup' }), { ...noteOf(), who: 'Gran' }, noteOf({ ops: [], text: '  ' }), noteOf({ at: '2026-01-01' })]) {
      const res = await postNote(p.cookie, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    for (let i = 1; i < 20; i++) expect((await postNote(p.cookie, noteOf())).statusCode).toBe(201);
    const over = await postNote(p.cookie, noteOf());
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toMatchObject({ code: 'too_many_notes', details: { max: 20 } });
    // Another recipe still takes notes.
    expect((await postNote(p.cookie, noteOf({ recipe: ONIGIRI }))).statusCode).toBe(201);
    expect(await listNotes(p.cookie)).toHaveLength(21);
  });

  it('POST /notes returns checkWithNotes: "swap lentils → peanut" on a peanut-rule player → blocked with the finding', async () => {
    const p = await player();
    expect((await call(p.cookie, { method: 'POST', url: '/rules', payload: { rule: PEANUT, confirmed: true } })).statusCode).toBe(201);
    const first = await postNote(p.cookie, noteOf({ ops: [{ op: 'add', name: 'lime' }] }));
    expect(first.json().note.check.status).not.toBe('blocked');
    const res = await postNote(p.cookie, noteOf({ ops: [{ op: 'swap', from: 'split moong dal', to: 'peanut' }] }));
    expect(res.statusCode, res.body).toBe(201);
    const check = res.json<{ note: { check: CheckResult } }>().note.check;
    expect(check.status).toBe('blocked');
    expect(JSON.stringify(check)).toContain('peanut');
    // I2 (fix round 1): the check covers ALL the player's notes on the recipe, not only the new one: a harmless note
    // posted after the peanut swap still comes back blocked, with the finding.
    const later = await postNote(p.cookie, noteOf({ ops: [{ op: 'add', name: 'lime' }] }));
    expect(later.statusCode, later.body).toBe(201);
    const laterCheck = later.json<{ note: { check: CheckResult } }>().note.check;
    expect(laterCheck.status).toBe('blocked');
    expect(JSON.stringify(laterCheck)).toContain('peanut');
    // Unreadable text still counts for safety (Step 3 C1): a peanut named only in the words is checked too.
    const q = await player();
    expect((await call(q.cookie, { method: 'POST', url: '/rules', payload: { rule: PEANUT, confirmed: true } })).statusCode).toBe(201);
    const words = await postNote(q.cookie, noteOf({ recipe: ONIGIRI, ops: [], text: 'a spoon of peanut butter on the side was great' }));
    expect(words.statusCode, words.body).toBe(201);
    expect(words.json().note.check.status).toBe('blocked');
  });

  it('GET /notes returns the notes on every recipe; a ?recipe= query → 400, so nothing about food is in the URL (C32)', async () => {
    const p = await player();
    const a = (await postNote(p.cookie, noteOf())).json().note;
    const b = (await postNote(p.cookie, noteOf({ recipe: ONIGIRI, ops: [{ op: 'remove', name: 'umeboshi' }] }))).json().note;
    const notes = await listNotes(p.cookie);
    // Both carry the same (fixed) clock time, so their order is not asserted.
    expect(notes.map((n) => [n.recipe, n.id])).toEqual(
      expect.arrayContaining([
        [PARIPPU, a.id],
        [ONIGIRI, b.id],
      ]),
    );
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => !('check' in n))).toBe(true);
    for (const url of [`/notes?recipe=${encodeURIComponent(PARIPPU)}`, '/notes?x=1', '/notes?recipe=']) {
      const res = await call(p.cookie, { method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
    }
    // Another player's notes are never listed.
    expect(await listNotes((await player()).cookie)).toEqual([]);
  });

  it('withdraw health_data with delete removes margin notes (and plans, Step 6 ruling), keeps shared_table and progress', async () => {
    const p = await player();
    expect((await postNote(p.cookie, noteOf())).statusCode).toBe(201);
    expect((await postShared(p.cookie, entryOf())).statusCode).toBe(201);
    const plan = { weekStart: '2026-11-09', items: [{ day: 1, kind: 'dish', slug: ONIGIRI, servings: 2 }], hard: false, slot: 'unanswered' };
    expect((await call(p.cookie, { method: 'PUT', url: '/plans/2026-11-09', payload: { plan, confirmed: true } })).statusCode).toBe(200);
    expect((await call(p.cookie, { method: 'POST', url: '/progress/events', payload: { events: [MARKET_EVENT] } })).statusCode).toBe(200);
    const keep = await player();
    expect((await postNote(keep.cookie, noteOf())).statusCode).toBe(201);

    expect((await call(keep.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } })).statusCode).toBe(204);
    expect(await listNotes(keep.cookie)).toHaveLength(1);

    expect((await call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } })).statusCode).toBe(204);
    expect(await db.select().from(marginNotes).where(eq(marginNotes.userId, p.id))).toEqual([]);
    expect(await db.select().from(sharedTable).where(eq(sharedTable.userId, p.id))).toHaveLength(1);
    expect(await tally(p.cookie)).toEqual({ shared: 1, byRecipe: { [PARIPPU]: 1 } });
    expect(await sql`select 1 from meal_plans where user_id = ${p.id}`).toHaveLength(0);
    expect(await sql`select 1 from progress_events where user_id = ${p.id}`).toHaveLength(1);
    expect((await sql`select 1 from reward_grants where user_id = ${p.id}`).length).toBeGreaterThan(0);
  });

  it('lock order: a note write waits on notes: (after the user row), and so a racing 21st note is refused', async () => {
    const p = await player();
    for (let i = 0; i < 19; i++) expect((await postNote(p.cookie, noteOf())).statusCode).toBe(201);
    const holder = await sql.reserve();
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(${ADVISORY_LOCK.book}, hashtext(${p.id}))`;
      const racing = [postNote(p.cookie, noteOf()), postNote(p.cookie, noteOf())];
      // Both wait on notes: while it is held.
      await new Promise((r) => setTimeout(r, 300));
      const waiting = await sql<{ n: number }[]>`select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = ${ADVISORY_LOCK.book} and not granted`;
      expect(waiting[0].n).toBe(2);
      await holder`commit`;
      const codes = (await Promise.all(racing)).map((r) => r.statusCode).sort();
      expect(codes).toEqual([201, 400]);
    } finally {
      holder.release();
    }
    expect(await db.select().from(marginNotes).where(eq(marginNotes.userId, p.id))).toHaveLength(20);
  });

  it('takes the local date within a day of UTC; a note dated outside it is refused', async () => {
    const p = await player();
    expect((await postNote(p.cookie, noteOf({ at: '2026-11-11' }), true, { today: '2026-11-11' })).statusCode).toBe(201);
    expect((await postNote(p.cookie, noteOf(), true, { today: '2026-11-13' })).statusCode).toBe(400);
    expect((await postNote(p.cookie, noteOf({ at: '2026-11-05' }))).statusCode).toBe(400);
    expect((await postNote(p.cookie, noteOf({ at: '2026-11-10T08:30:00+05:30' }))).statusCode).toBe(201);
  });

  it(`limits book requests to ${BOOK_REQUESTS_PER_MINUTE} a minute per player (429 rate_limited)`, async () => {
    const p = await player();
    for (let i = 0; i < BOOK_REQUESTS_PER_MINUTE; i++) expect((await call(p.cookie, { method: 'GET', url: '/shared-table/tally' })).statusCode).toBe(200);
    const res = await call(p.cookie, { method: 'GET', url: '/notes' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('C-9: a note POST leaves no note text in captured logs', async () => {
    const logs = captureLogs();
    await app.close();
    await build(logs.logger);
    const p = await player();
    const res = await postNote(p.cookie, noteOf({ ops: [{ op: 'swap', from: 'split moong dal', to: 'oat milk' }], text: 'secret-grandma-trick' }));
    expect(res.statusCode).toBe(201);
    expect((await postShared(p.cookie, entryOf())).statusCode).toBe(201);
    expect((await postShared(p.cookie, { ...entryOf(), name: 'Samwise' })).statusCode).toBe(400);
    await listNotes(p.cookie);
    expect(logs.text().length).toBeGreaterThan(0);
    expect(logs.text()).not.toMatch(/oat milk|secret-grandma-trick|moong|parippu|Samwise|family/i);
  });
});

describe('Cooked for Someone (the Shared Table)', () => {
  it('needs confirmed: true; stores a sealed row with no name and no consent needed (contract basis)', async () => {
    const p = await player({ consent: false });
    for (const confirmed of [OMIT, false]) expect((await postShared(p.cookie, entryOf(), confirmed)).statusCode).toBe(400);
    const res = await postShared(p.cookie, entryOf());
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json<{ id: string }>();
    const [stored] = await db.select().from(sharedTable).where(eq(sharedTable.userId, p.id));
    expect(stored).toMatchObject({ id, cookedOn: TODAY });
    for (const word of ['family', 'two_to_three', 'parippu']) expect(await rowsMentioning('shared_table', word), word).toBe(0);
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, p.id));
    expect(audits.map((a) => a.action)).toContain('shared_table.create');
    expect((await call((await player()).cookie, { method: 'DELETE', url: `/shared-table/${id}` })).statusCode).toBe(404);
    expect((await call(p.cookie, { method: 'DELETE', url: `/shared-table/${id}` })).statusCode).toBe(204);
    expect(await tally(p.cookie)).toEqual({ shared: 0, byRecipe: {} });
  });

  it('shared-table rejects any string field: { who: "Sam" } and { name: … } → 400; nothing stored', async () => {
    const p = await player();
    const bad: unknown[] = [
      entryOf({ cookedFor: { count: 'one', who: 'Sam' } }),
      { ...entryOf(), name: 'Sam' },
      entryOf({ cookedFor: { count: 'one', who: null, name: 'Sam' } }),
      entryOf({ cookedFor: { count: 'Sam and Alex', who: null } }),
      entryOf({ cookedFor: { count: 3, who: null } }),
      entryOf({ recipe: 'Sam' }),
      entryOf({ recipe: null, frame: 'Sam' }),
      entryOf({ recipe: null, frame: null }),
      entryOf({ recipe: PARIPPU, frame: 'fried-rice' }),
      entryOf({ cookedOn: 'Sam' }),
      entryOf({ cookedOn: '2026-11-11' }),
      entryOf({ cookedOn: '2026-11-01' }),
      entryOf({ note: 'Gran loved it' }),
      'Sam',
    ];
    for (const entry of bad) {
      const res = await postShared(p.cookie, entry);
      expect(res.statusCode, JSON.stringify(entry)).toBe(400);
      expect(res.body).not.toContain('Sam');
      expect(res.body).not.toContain('Gran');
    }
    expect(await db.select().from(sharedTable).where(eq(sharedTable.userId, p.id))).toEqual([]);
    expect(await rowsMentioning('audit_events', 'Sam')).toBe(0);
    // M2 (fix round 1): an unknown top-level body key is refused without being echoed (R-19).
    for (const [url, payload] of [
      ['/shared-table', { entry: entryOf(), confirmed: true, Samwise: 'Gran' }],
      ['/notes', { note: noteOf(), confirmed: true, Samwise: 'Gran' }],
    ] as const) {
      const res = await call(p.cookie, { method: 'POST', url, payload });
      expect(res.statusCode, url).toBe(400);
      expect(res.body, url).not.toMatch(/Samwise|Gran/);
    }
    expect(await db.select().from(sharedTable).where(eq(sharedTable.userId, p.id))).toEqual([]);
    // A frame is a valid dish too.
    expect((await postShared(p.cookie, entryOf({ recipe: null, frame: 'fried-rice' }))).statusCode).toBe(201);
  });

  it('tally counts meals shared in total and per recipe, ignores just_me, and exposes no list (C21)', async () => {
    const p = await player();
    for (const e of [
      entryOf({ cookedFor: { count: 'one', who: 'partner' } }),
      entryOf({ cookedFor: { count: 'four_plus', who: null }, cookedOn: '2026-11-08' }),
      entryOf({ recipe: ONIGIRI, cookedFor: { count: 'two_to_three', who: 'friends' } }),
      entryOf({ recipe: ONIGIRI, cookedFor: { count: 'just_me', who: null } }),
      entryOf({ recipe: null, frame: 'green-sauce', cookedFor: { count: 'one', who: 'neighbours' } }),
    ]) {
      expect((await postShared(p.cookie, e)).statusCode).toBe(201);
    }
    const t = await tally(p.cookie);
    expect(t).toEqual({ shared: 4, byRecipe: { [PARIPPU]: 2, [ONIGIRI]: 1 } });
    expect(Object.keys(t).sort()).toEqual(['byRecipe', 'shared']);
    expect(JSON.stringify(t)).not.toMatch(/partner|friends|neighbours|2026|just_me|green-sauce/);
    expect(await tally((await player()).cookie)).toEqual({ shared: 0, byRecipe: {} });
  });

  it('M1 (fix round 1): Shared Table writes are serialized under the shared daily write cap (199 seeded + 5 racing → one more)', async () => {
    const p = await player();
    const at = new Date(NOW.getTime() - 3_600_000);
    for (let i = 0; i < 199; i++) await audit(db, { actorKind: 'user', actorId: p.id, subjectUserId: p.id, action: 'shared_table.create' }, at);
    const codes = (await Promise.all(Array.from({ length: 5 }, () => postShared(p.cookie, entryOf())))).map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 429, 429, 429, 429]);
    expect(await db.select().from(sharedTable).where(eq(sharedTable.userId, p.id))).toHaveLength(1);
  });

  it('notes and shared entries never create a progress_event or reward_grant', async () => {
    const p = await player();
    expect((await postNote(p.cookie, noteOf())).statusCode).toBe(201);
    expect((await postShared(p.cookie, entryOf())).statusCode).toBe(201);
    expect((await postShared(p.cookie, entryOf({ cookedFor: { count: 'four_plus', who: 'guests' } }))).statusCode).toBe(201);
    expect(await sql`select 1 from progress_events where user_id = ${p.id}`).toHaveLength(0);
    expect(await sql`select 1 from reward_grants where user_id = ${p.id}`).toHaveLength(0);
    const view = (await call(p.cookie, { method: 'GET', url: '/progress' })).json();
    const fresh = (await call((await player()).cookie, { method: 'GET', url: '/progress' })).json();
    expect(view).toEqual(fresh);
  });
});
