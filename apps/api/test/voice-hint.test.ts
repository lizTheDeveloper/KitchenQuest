// M7 C-13: the STT vocabulary hint. Without health_data it is the graph's major allergens only; with it, the player's
// rule targets come first, then the allergens, their pantry and this week's open market run. At most HINT_MAX_WORDS.
import { ALLERGEN_ROOTS, HINT_MAX_WORDS, parseUpstreamClientMsg } from '@kitchenquest/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import type { Db } from '../src/types.js';
import { sttHint } from '../src/voice/hint.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb } from './helpers/db.js';

const config = testConfig();
const catalog = defaultCatalog();
const NOW = new Date('2026-11-10T12:00:00Z');
const ALLERGENS = [...ALLERGEN_ROOTS].filter((id) => catalog.graph.has(id)).map((id) => catalog.graph.get(id).name);

let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;

beforeAll(async () => {
  ({ db, close: closeDb } = await testDb());
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false });
});
afterAll(async () => {
  await app?.close();
  await closeDb?.();
});

const call = (cookie: string, opts: InjectOptions) => app.inject({ ...opts, cookies: { kq_session: cookie } });
async function player(health: boolean) {
  const cookie = await signIn(app, mailer, `hint${++seq}@example.com`);
  if (health) expect((await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } })).statusCode).toBe(201);
  return { cookie, id: (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id };
}
const wordCount = (hint: string[]) => hint.reduce((n, e) => n + e.split(' ').length, 0);

describe('sttHint (C-13)', () => {
  test('without health_data: only major allergens; with it: rule targets first; ≤ HINT_MAX_WORDS', async () => {
    const plain = await player(false);
    const none = await sttHint(db, config.keyring, catalog, plain.id, NOW);
    expect(ALLERGENS.length).toBeGreaterThan(10);
    expect(none).toEqual(ALLERGENS);

    const p = await player(true);
    for (const id of ['cumin', 'coriander']) {
      const res = await call(p.cookie, { method: 'POST', url: '/rules', payload: { rule: { target: { kind: 'ingredient', ids: [id] }, type: 'avoid', severity: 'allergy' }, confirmed: true } });
      expect(res.statusCode, res.body).toBe(201);
    }
    const pantry = await call(p.cookie, { method: 'POST', url: '/pantry/changes', payload: { add: [{ name: 'Epazote!', ingredientId: null }], removeNames: [], removeIds: [], confirmed: true } });
    expect(pantry.statusCode, pantry.body).toBe(200);
    const hint = await sttHint(db, config.keyring, catalog, p.id, NOW);
    const ruleNames = ['cumin', 'coriander'].map((id) => catalog.graph.get(id).name.toLowerCase());
    expect(hint.slice(0, 2).sort()).toEqual([...ruleNames].sort());
    expect(hint.slice(2, 2 + ALLERGENS.length)).toEqual(ALLERGENS.filter((a) => !ruleNames.includes(a)));
    // a pantry name is cleaned (lower case, no punctuation) and comes after the allergens
    expect(hint.at(-1)).toBe('epazote');
    expect(wordCount(hint)).toBeLessThanOrEqual(HINT_MAX_WORDS);
    // what goes upstream passes core's strict parser
    expect(parseUpstreamClientMsg({ t: 'listen', id: 1, hint })).not.toBeNull();
  });

  test('the cap: a pantry of many names stops at HINT_MAX_WORDS words, rule targets and allergens kept', async () => {
    const p = await player(true);
    const add = Array.from({ length: 40 }, (_, i) => ({ name: `pickled thing number ${'x'.repeat(i % 5 + 1)}${i}`, ingredientId: null }));
    const res = await call(p.cookie, { method: 'POST', url: '/pantry/changes', payload: { add, removeNames: [], removeIds: [], confirmed: true } });
    expect(res.statusCode, res.body).toBe(200);
    const hint = await sttHint(db, config.keyring, catalog, p.id, NOW);
    expect(wordCount(hint)).toBeLessThanOrEqual(HINT_MAX_WORDS);
    expect(hint.slice(0, ALLERGENS.length)).toEqual(ALLERGENS);
    expect(hint.length).toBeGreaterThan(ALLERGENS.length);
    expect(new Set(hint).size).toBe(hint.length);
  });
});
