import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { IngredientGraph, check, parseRecipe, DISCLAIMER } from '@kitchenquest/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { loggableError } from '../src/errors.js';
import { captureLogs } from './helpers/logs.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const config = testConfig();
const NOW = new Date('2026-11-09T12:00:00Z');
const catalog = defaultCatalog();
const { graph } = catalog;

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
    expect(r[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
    // Stored exactly as written: case kept, order kept.
    expect(r[0].contributors).toEqual(['Ada-L', 'bob']);
    expect(r[1].contributors).toEqual([]);

    expect(await syncCanon(db, dir, graph)).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 2 });

    put('testland/north/b.cook', recipe('B2'));
    expect(await syncCanon(db, dir, graph)).toEqual({ added: 0, updated: 1, removed: 0, unchanged: 1 });
    expect((await rows())[1].title).toBe('B2');

    rmSync(join(dir, 'testland/north/b.cook'));
    expect(await syncCanon(db, dir, graph)).toEqual({ added: 0, updated: 0, removed: 1, unchanged: 1 });
    expect((await rows()).map((x) => x.slug)).toEqual(['testland/north/a']);
  });

  it('a row whose contributors differ from the file is updated even with the same source hash', async () => {
    await syncCanon(db, dir, graph);
    await sql`update canon_recipes set contributors = '{}' where slug = 'testland/north/a'`;
    expect(await syncCanon(db, dir, graph)).toEqual({ added: 0, updated: 1, removed: 0, unchanged: 1 });
    expect((await rows())[0].contributors).toEqual(['Ada-L', 'bob']);
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

  it('refuses a directory with no recipes and leaves the canon alone', async () => {
    await syncCanon(db, dir, graph);
    const before = await rows();
    const empty = mkdtempSync(join(tmpdir(), 'kq-empty-'));
    try {
      await expect(syncCanon(db, empty, graph)).rejects.toThrow(/no \.cook files/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect(await rows()).toEqual(before);
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
    expect(parippu.check.disclaimer).toBe(DISCLAIMER);
    const detail = (await call(cookie, { method: 'GET', url: '/recipes/india/kerala/parippu' })).json();
    expect(detail.check.status).toBe('blocked');
    expect(detail.check.disclaimer).toBe(parippu.check.disclaimer);
    expect(detail.check.disclaimer).toBe("Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels.");
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
    expect(d.source).toContain('split moong dal');
    expect(d.ingredients[0]).toMatchObject({ name: 'split moong dal' });
    expect(d.nutrition.perServing.energy_kcal).toBeGreaterThan(0);
    expect(d.nutrition.missing).toEqual([]);
    expect(Object.keys(d).sort()).toEqual(['check', 'ingredients', 'meta', 'nutrition', 'slug', 'source', 'title']);
  });

  it('detail check equals core check run directly with the same rules and date (parity)', async () => {
    const cookie = await withConsent();
    await addRule(cookie, COCONUT);
    const api = (await call(cookie, { method: 'GET', url: '/recipes/india/kerala/parippu' })).json();
    const rule = { ...COCONUT, id: (await call(cookie, { method: 'GET', url: '/rules' })).json().rules[0].id };
    const source = readFileSync(join(RECIPES_DIR, 'india/kerala/parippu.cook'), 'utf8');
    const direct = check(parseRecipe(source), [rule as never], graph, [...catalog.substitutions], '2026-11-09');
    expect(api.check).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  it('meta omits contributors while source keeps the file as written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kq-contrib-'));
    mkdirSync(join(dir, 't/n'), { recursive: true });
    writeFileSync(join(dir, 't/n/c.cook'), recipe('C', 'contributors: [Ada-L]\n'));
    try {
      await syncCanon(db, dir, graph);
      const d = (await call(await user(), { method: 'GET', url: '/recipes/t/n/c' })).json();
      expect(d.meta).not.toHaveProperty('contributors');
      expect(d.source).toContain('contributors: [Ada-L]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await syncCanon(db, RECIPES_DIR, graph);
    }
  });

  it('stored rules that no longer validate give 409 rules_need_review, no check, nothing in the logs', async () => {
    const cookie = await withConsent();
    await addRule(cookie, COCONUT);
    const logs = captureLogs();
    const small = IngredientGraph.fromData({ ingredients: [{ id: 'salt', name: 'salt' }] });
    const other = await buildApp({ config, db, mailer, now: () => NOW, logger: logs.logger, catalog: { graph: small, substitutions: [] } });
    try {
      for (const url of ['/recipes', '/recipes/india/kerala/parippu']) {
        const res = await other.inject({ method: 'GET', url, cookies: { kq_session: cookie } });
        expect(res.statusCode, url).toBe(409);
        expect(res.json()).toEqual({ error: { code: 'rules_need_review', message: 'Some of your saved rules need review.' } });
        expect(res.body).not.toMatch(/ok|coconut/);
      }
    } finally {
      await other.close();
    }
    expect(logs.text()).not.toMatch(/coconut/);
  });

  it('core rule and substitution error messages never reach the log serializer output', () => {
    for (const msg of ['Invalid rules: rule 1: unknown id "coconut"', 'Invalid substitutions: Substitution "a" -> "b"']) {
      const out = loggableError(new Error(msg));
      expect(JSON.stringify(out)).not.toMatch(/coconut|"a"/);
      expect(out.message).toBe('Invalid rules or substitutions (details withheld)');
    }
  });

  describe('?date= (the player\'s local date)', () => {
    const LATE = new Date('2026-12-02T01:00:00Z');
    const phased = { ...COCONUT, phase: { start: '2026-11-01', end: '2026-12-01' } };
    const at = async (now: Date) => buildApp({ config, db, mailer, now: () => now, logger: false });

    it('a rule ending 12-01 still applies on the player\'s date 12-01 when server UTC is 12-02', async () => {
      const cookie = await withConsent();
      await addRule(cookie, phased);
      const late = await at(LATE);
      try {
        const get = (q: string) => late.inject({ method: 'GET', url: `/recipes/india/kerala/parippu${q}`, cookies: { kq_session: cookie } });
        expect((await get('?date=2026-12-01')).json().check.status).toBe('blocked');
        expect((await get('')).json().check.status).toBe('ok'); // default: server UTC date, after the phase
        const list = await late.inject({ method: 'GET', url: '/recipes?date=2026-12-01', cookies: { kq_session: cookie } });
        expect(list.json().recipes.find((r: { slug: string }) => r.slug === 'india/kerala/parippu').check.status).toBe('blocked');
      } finally {
        await late.close();
      }
    });

    it('rejects dates outside one day of server UTC, and malformed ones, with 400', async () => {
      const cookie = await user();
      for (const q of ['2026-11-07', '2026-11-11', '2026-02-30', '11/09/2026', '']) {
        for (const base of ['/recipes', '/recipes/india/kerala/parippu']) {
          const res = await call(cookie, { method: 'GET', url: `${base}?date=${encodeURIComponent(q)}` });
          expect(res.statusCode, `${base} ${q}`).toBe(400);
        }
      }
      for (const q of ['2026-11-08', '2026-11-09', '2026-11-10']) {
        expect((await call(cookie, { method: 'GET', url: `/recipes?date=${q}` })).statusCode, q).toBe(200);
      }
    });
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
