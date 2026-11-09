import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const config = testConfig();
const NOW = new Date('2026-11-09T12:00:00Z');
const { graph } = defaultCatalog();

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
});
afterAll(async () => {
  await closeDb?.();
});

const recipe = (title: string, extra = '', body = 'Stir @salt{1%tsp} into @water{500%ml}.') =>
  `---\ntitle: ${title}\ncountry: Testland\nregion: North\ncredit: Test\ncook: t\ndifficulty: 1\nskills: [heat-control]\nservings: 2\nlicense: CC-BY-SA-4.0\nstatus: draft\n${extra}---\n${body}\n`;

describe('syncCanon', () => {
  let dir: string;
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  beforeEach(async () => {
    await sql`delete from canon_recipes`;
    dir = mkdtempSync(join(tmpdir(), 'kq-canon-'));
    put('testland/north/a.cook', recipe('A', 'contributors: [Ada-L, bob]\n'));
    put('testland/north/b.cook', recipe('B'));
    put('testland/CONTRIBUTING.md', '# not a recipe');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rows = () => sql`select path, slug, title, country, region, status, content_hash, contributors from canon_recipes order by path`;

  it('adds, then reports unchanged, updated and removed', async () => {
    expect(await syncCanon(db, dir, graph)).toEqual({ added: 2, updated: 0, removed: 0, unchanged: 0 });
    const r = await rows();
    expect(r.map((x) => x.slug)).toEqual(['testland/north/a', 'testland/north/b']);
    expect(r[0]).toMatchObject({ path: 'testland/north/a.cook', title: 'A', country: 'Testland', region: 'North', status: 'draft' });
    expect(r[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // Stored exactly as written: case kept, order kept.
    expect(r[0]!.contributors).toEqual(['Ada-L', 'bob']);
    expect(r[1]!.contributors).toEqual([]);

    expect(await syncCanon(db, dir, graph)).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 2 });

    put('testland/north/b.cook', recipe('B2'));
    expect(await syncCanon(db, dir, graph)).toEqual({ added: 0, updated: 1, removed: 0, unchanged: 1 });
    expect((await rows())[1]!.title).toBe('B2');

    rmSync(join(dir, 'testland/north/b.cook'));
    expect(await syncCanon(db, dir, graph)).toEqual({ added: 0, updated: 0, removed: 1, unchanged: 1 });
    expect((await rows()).map((x) => x.slug)).toEqual(['testland/north/a']);
  });

  it('a row whose contributors differ from the file is updated even with the same source hash', async () => {
    await syncCanon(db, dir, graph);
    await sql`update canon_recipes set contributors = '{}' where slug = 'testland/north/a'`;
    expect(await syncCanon(db, dir, graph)).toEqual({ added: 0, updated: 1, removed: 0, unchanged: 1 });
    expect((await rows())[0]!.contributors).toEqual(['Ada-L', 'bob']);
  });

  it('a malformed file aborts everything, names the path, and leaves the table unchanged', async () => {
    await syncCanon(db, dir, graph);
    const before = await rows();
    put('testland/north/b.cook', recipe('B changed'));
    put('testland/north/c.cook', recipe('C'));
    rmSync(join(dir, 'testland/north/a.cook'));
    put('testland/north/z-bad.cook', 'no front matter at all @salt{}');
    await expect(syncCanon(db, dir, graph)).rejects.toThrow(/testland\/north\/z-bad\.cook/);
    expect(await rows()).toEqual(before);
  });

  it('refuses a recipe with an ingredient the graph does not know, naming the path', async () => {
    put('testland/north/c.cook', recipe('C', '', 'Add @unobtainium{1}.'));
    await expect(syncCanon(db, dir, graph)).rejects.toThrow(/testland\/north\/c\.cook.*unobtainium/);
    expect(await rows()).toEqual([]);
  });

  it('a bad contributors list fails without echoing the ids', async () => {
    put('testland/north/c.cook', recipe('C', 'contributors: [secret-handle, 7]\n'));
    const err = await syncCanon(db, dir, graph).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/testland\/north\/c\.cook/);
    expect((err as Error).message).not.toContain('secret-handle');
  });
});

describe('recipe endpoints', () => {
  let app: FastifyInstance;
  let mailer: CaptureMailer;
  let seq = 0;
  beforeAll(async () => {
    await sql`delete from canon_recipes`;
    await syncCanon(db, RECIPES_DIR, graph);
  });
  beforeEach(async () => {
    mailer = new CaptureMailer();
    app = await buildApp({ config, db, mailer, now: () => NOW, logger: false });
  });
  afterEach(async () => {
    await app?.close();
  });

  const call = (cookie: string | null, opts: InjectOptions) =>
    app.inject({ ...opts, ...(cookie ? { cookies: { kq_session: cookie } } : {}) });
  const user = () => signIn(app, mailer, `recipes${++seq}@example.com`);
  const withConsent = async () => {
    const cookie = await user();
    const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } });
    expect(res.statusCode).toBe(201);
    return cookie;
  };
  const addRule = async (cookie: string, rule: object) => {
    const res = await call(cookie, { method: 'POST', url: '/rules', payload: { rule, confirmed: true } });
    expect(res.statusCode).toBe(201);
  };
  const COCONUT = { target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };

  it('needs sign-in', async () => {
    expect((await call(null, { method: 'GET', url: '/recipes' })).statusCode).toBe(401);
    expect((await call(null, { method: 'GET', url: '/recipes/india/kerala/parippu' })).statusCode).toBe(401);
  });

  it('a player with no rules and no consent gets ok for every canon recipe, ordered by country then title', async () => {
    const res = await call(await user(), { method: 'GET', url: '/recipes' });
    expect(res.statusCode).toBe(200);
    const list = res.json().recipes;
    expect(list.map((r: { country: string }) => r.country)).toEqual(['India', 'Japan', 'Mexico']);
    expect(list.map((r: { slug: string }) => r.slug)).toEqual(['india/kerala/parippu', 'japan/osaka/onigiri', 'mexico/oaxaca/frijoles-de-olla']);
    for (const r of list) expect(r.check).toEqual({ status: 'ok', severe: false, disclaimer: null });
    expect(list[0]).toMatchObject({ title: expect.any(String), region: 'Kerala (Kochi)', status: 'draft' });
  });

  it('a severe coconut rule blocks parippu with the disclaimer, in the list and the detail', async () => {
    const cookie = await withConsent();
    await addRule(cookie, COCONUT);
    const list = (await call(cookie, { method: 'GET', url: '/recipes' })).json().recipes;
    const parippu = list.find((r: { slug: string }) => r.slug === 'india/kerala/parippu');
    expect(parippu.check.status).toBe('blocked');
    expect(parippu.check.severe).toBe(true);
    expect(parippu.check.disclaimer).toMatch(/can't guarantee/);
    const detail = (await call(cookie, { method: 'GET', url: '/recipes/india/kerala/parippu' })).json();
    expect(detail.check.status).toBe('blocked');
    expect(detail.check.disclaimer).toBe(parippu.check.disclaimer);
    expect(detail.check.findings.length).toBeGreaterThan(0);
    const others = list.filter((r: { slug: string }) => r.slug !== 'india/kerala/parippu');
    for (const r of others) expect(r.check.status).not.toBe('blocked'); // core may still say unverified
  });

  it("one player's rules never affect another player's checks", async () => {
    const a = await withConsent();
    await addRule(a, COCONUT);
    const b = await user();
    const detail = (await call(b, { method: 'GET', url: '/recipes/india/kerala/parippu' })).json();
    expect(detail.check.status).toBe('ok');
  });

  it('after a "keep" withdrawal the stored rules still apply; after "delete" they are gone', async () => {
    const cookie = await withConsent();
    await addRule(cookie, COCONUT);
    const w = await call(cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } });
    expect(w.statusCode).toBe(204);
    const kept = (await call(cookie, { method: 'GET', url: '/recipes/india/kerala/parippu' })).json();
    expect(kept.check.status).toBe('blocked');

    const other = await withConsent();
    await addRule(other, COCONUT);
    await call(other, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } });
    const gone = (await call(other, { method: 'GET', url: '/recipes/india/kerala/parippu' })).json();
    expect(gone.check.status).toBe('ok');
  });

  it('detail has the source, ingredients, meta and nutrition per serving, and no contributor ids', async () => {
    const res = await call(await user(), { method: 'GET', url: '/recipes/india/kerala/parippu' });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d).toMatchObject({ slug: 'india/kerala/parippu', title: expect.stringContaining('Parippu') });
    expect(d.meta).toMatchObject({ country: 'India', servings: 3, status: 'draft' });
    expect(d.meta).not.toHaveProperty('contributors');
    expect(d.source).toContain('split moong dal');
    expect(d.ingredients[0]).toMatchObject({ name: 'split moong dal' });
    expect(d.nutrition.perServing.energy_kcal).toBeGreaterThan(0);
    expect(d.nutrition.missing).toEqual([]);
    expect(Object.keys(d).sort()).toEqual(['check', 'ingredients', 'meta', 'nutrition', 'slug', 'source', 'title']);
  });

  it('an unknown slug is 404', async () => {
    const cookie = await user();
    for (const url of ['/recipes/nope', '/recipes/india/kerala/nope', '/recipes/india/kerala/parippu.cook', '/recipes/']) {
      const res = await call(cookie, { method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });
});
