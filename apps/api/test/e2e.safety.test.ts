// Step 8: one scripted safety journey through the real app, real canon and real seed data.
import { check, parseRecipe, type Rule } from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { canonRecipes, entitlements, rules as rulesTable, users } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const config = testConfig();
const catalog = loadCatalog();
const NOW = new Date('2026-11-09T12:00:00Z');
const TODAY = '2026-11-09';
const SATURDAY = 6;
const COCONUT = { target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;

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
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false });
});
afterEach(async () => {
  await app?.close();
});

const call = (cookie: string | null, opts: InjectOptions) =>
  app.inject({ ...opts, ...(cookie ? { cookies: { kq_session: cookie } } : {}) });
/** For every table, how many rows mention `needle` in any column (row cast to text). */
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
const grantHealth = (cookie: string) =>
  call(cookie, {
    method: 'POST',
    url: '/me/consents',
    payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version },
  });

describe('end-to-end safety journey', () => {
  it('sign in, profile, search, confirmed rule, per-player checks, isolation, export, delete (free forever)', async () => {
    // 1. Sign in as a brand-new user with no entitlements (§16).
    const email = `e2e${++seq}-a@example.com`;
    const a = await signIn(app, mailer, email);
    const me = (await call(a, { method: 'GET', url: '/me' })).json<{ id: string; entitlements: unknown[] }>();
    expect(me.entitlements).toEqual([]);
    const [u] = await db.select().from(users).where(eq(users.id, me.id));
    expect(u.ageConfirmedAt).toEqual(NOW);
    expect(await db.select().from(entitlements).where(eq(entitlements.userId, me.id))).toEqual([]);

    // 2. Profile: market day Saturday.
    const prof = await call(a, { method: 'PUT', url: '/profile', payload: { marketDays: [SATURDAY] } });
    expect(prof.statusCode).toBe(200);
    expect(prof.json().marketDays).toEqual([SATURDAY]);

    // 3. Ingredient search finds coconut.
    const found = (await call(a, { method: 'GET', url: '/ingredients/search?q=coconut' })).json<{ results: { id: string }[] }>();
    expect(found.results.map((r) => r.id)).toContain('coconut');

    // 4. Safety rules need consent, then an explicit confirmation.
    const noConsent = await call(a, { method: 'POST', url: '/rules', payload: { rule: COCONUT, confirmed: true } });
    expect(noConsent.statusCode).toBe(403);
    expect(noConsent.json().error.code).toBe('consent_required');
    expect((await grantHealth(a)).statusCode).toBe(201);
    const unconfirmed = await call(a, { method: 'POST', url: '/rules', payload: { rule: COCONUT } });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error.code).toBe('confirmation_required');
    expect((await call(a, { method: 'GET', url: '/rules' })).json().rules).toEqual([]);
    const created = await call(a, { method: 'POST', url: '/rules', payload: { rule: COCONUT, confirmed: true } });
    expect(created.statusCode).toBe(201);
    const rule = created.json<{ rule: Rule & { id: string } }>().rule;

    // 5. Recipes: parippu is blocked with the disclaimer; every status equals core's own check.
    const list = (await call(a, { method: 'GET', url: '/recipes' })).json<{
      recipes: { slug: string; check: { status: string; severe: boolean; disclaimer: string | null } }[];
    }>().recipes;
    const canon = await db.select().from(canonRecipes);
    expect(list.length).toBe(canon.length);
    expect(list.length).toBeGreaterThan(0);
    const parippu = list.find((r) => r.slug === 'india/kerala/parippu')!;
    expect(parippu.check.status).toBe('blocked');
    expect(parippu.check.disclaimer).toEqual(expect.stringContaining("can't guarantee"));
    for (const r of list) {
      const row = canon.find((c) => c.slug === r.slug)!;
      const direct = check(parseRecipe(row.source), [rule], catalog.graph, [...catalog.substitutions], TODAY);
      expect(r.check).toEqual({ status: direct.status, severe: direct.severe, disclaimer: direct.disclaimer });
    }

    // 6. A second user sees none of this and gets ok for parippu.
    const b = await signIn(app, mailer, `e2e${++seq}-b@example.com`);
    expect((await call(b, { method: 'GET', url: '/rules' })).json()).toEqual({ rules: [] });
    expect((await call(b, { method: 'GET', url: `/rules/${rule.id}` })).statusCode).toBe(404);
    const bList = (await call(b, { method: 'GET', url: '/recipes' })).json<{ recipes: { slug: string; check: { status: string } }[] }>().recipes;
    expect(bList.find((r) => r.slug === 'india/kerala/parippu')!.check.status).toBe('ok');

    // 7. Export has the rule; delete removes everything.
    const exp = await call(a, { method: 'GET', url: '/me/export' });
    expect(exp.statusCode).toBe(200);
    expect(exp.json().rules).toEqual([expect.objectContaining({ ...COCONUT, id: rule.id })]);
    expect(await db.select().from(entitlements).where(eq(entitlements.userId, me.id))).toEqual([]); // still free
    const del = await call(a, { method: 'DELETE', url: '/me', payload: { confirm: 'delete my account' } });
    expect(del.statusCode).toBe(204);
    expect(await db.select().from(users).where(eq(users.id, me.id))).toEqual([]);
    expect(await db.select().from(rulesTable).where(eq(rulesTable.userId, me.id))).toEqual([]);
    const gone = await mentions(me.id);
    for (const t of ['consents', 'user_keys', 'sessions', 'entitlements', 'usage_events', 'self_read_counts', 'profiles', 'rules']) {
      expect(gone[t], `${t} still mentions the deleted user`).toBe(0);
    }
    expect((await mentions(email)).login_tokens).toBe(0);
    expect((await call(a, { method: 'GET', url: '/me' })).statusCode).toBe(401);
  });

  it('C-11: withdrawing consent stops rule writes; declining never blocks play', async () => {
    // Never consented: canon recipes and checks work with no stored rules.
    const c = await signIn(app, mailer, `e2e${++seq}-c@example.com`);
    const none = await call(c, { method: 'POST', url: '/rules', payload: { rule: COCONUT, confirmed: true } });
    expect(none.statusCode).toBe(403);
    expect(none.json().error.code).toBe('consent_required');
    expect((await call(c, { method: 'GET', url: '/rules' })).json()).toEqual({ rules: [] });
    const recipes = (await call(c, { method: 'GET', url: '/recipes' })).json<{ recipes: { check: { status: string } }[] }>().recipes;
    expect(recipes.length).toBeGreaterThan(0);
    for (const r of recipes) expect(r.check.status).toBe('ok');
    expect((await call(c, { method: 'GET', url: '/recipes/india/kerala/parippu' })).statusCode).toBe(200);

    // With consent: 201. Withdrawn: writes stop again.
    expect((await grantHealth(c)).statusCode).toBe(201);
    expect((await call(c, { method: 'POST', url: '/rules', payload: { rule: COCONUT, confirmed: true } })).statusCode).toBe(201);
    const w = await call(c, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } });
    expect(w.statusCode).toBe(204);
    expect((await call(c, { method: 'GET', url: '/rules' })).json().rules).toEqual([expect.objectContaining(COCONUT)]);
    const after = await call(c, { method: 'POST', url: '/rules', payload: { rule: COCONUT, confirmed: true } });
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe('consent_required');
    expect((await call(c, { method: 'GET', url: '/recipes' })).statusCode).toBe(200);
  });
});
