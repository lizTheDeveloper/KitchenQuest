// M4 Step 8: the write guard — tap confirm, reject, undo; locks and races on real Postgres.
import {
  buildMealCard,
  buildPantryCard,
  buildProfileCard,
  buildRuleCard,
  type ConfirmResponse,
  type ProposalCard,
  type RuleCard,
} from '@kitchenquest/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { PROPOSAL_TTL_MS, UNDO_WINDOW_MS } from '../src/mentor/constants.js';
import { createProposal } from '../src/mentor/proposals.js';
import { confirmProposalIn } from '../src/mentor/writes.js';
import { ApiError } from '../src/errors.js';
import { MAX_PANTRY_ITEMS } from '../src/pantry/service.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { captureLogs } from './helpers/logs.js';

const config = testConfig();
const catalog = defaultCatalog();
const NOW = new Date('2026-11-10T18:00:00Z');
const TODAY = '2026-11-10';

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let clock: number;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
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

async function grantHealth(cookie: string) {
  const res = await call(cookie, {
    method: 'POST',
    url: '/me/consents',
    payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version },
  });
  expect(res.statusCode).toBe(201);
}

async function player(health = true) {
  const cookie = await signIn(app, mailer, `confirm${++seq}@example.com`);
  if (health) await grantHealth(cookie);
  const userId = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  return { cookie, userId };
}

const ruleCard = (term: string, severity: 'anaphylactic' | 'allergy' | 'intolerance' | 'preference'): RuleCard => {
  const r = buildRuleCard({ term, severity }, catalog.graph, catalog.ruleTerms);
  if (!r.ok) throw new Error(`no card for ${term}`);
  return r.card;
};
const PEANUT = () => ruleCard('peanut', 'anaphylactic');

async function seed(userId: string, card: ProposalCard): Promise<string> {
  return (
    await db.transaction((tx) =>
      createProposal(tx, config.keyring, { userId, conversationId: null, turnSeq: null, card }, new Date(clock)),
    )
  ).proposalId;
}

const confirm = (cookie: string, id: string, payload: object = { channel: 'tap' }) =>
  call(cookie, { method: 'POST', url: `/mentor/proposals/${id}/confirm`, payload });
const reject = (cookie: string, id: string) =>
  call(cookie, { method: 'POST', url: `/mentor/proposals/${id}/reject`, payload: {} });
const undo = (cookie: string, id: string) =>
  call(cookie, { method: 'POST', url: `/mentor/writes/${id}/undo`, payload: {} });

const count = async (table: string, userId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where user_id = ${userId}`)[0].n;
const proposal = async (id: string) =>
  (
    await sql<{ status: string; channel: string | null; write_ref: string | null; undo_sealed: Buffer | null }[]>`
    select status, channel, write_ref, undo_sealed from mentor_proposals where id = ${id}`
  )[0];
const lineOf = (trigger: string, vars: Record<string, string> = {}) => ({ kind: 'line', line: { trigger, vars } });
const rulesOf = async (cookie: string) =>
  (await call(cookie, { method: 'GET', url: '/rules' })).json<{ rules: { severity: string }[] }>().rules;
const pantryOf = async (cookie: string) =>
  (await call(cookie, { method: 'GET', url: '/pantry' })).json<{ items: { id: string; name: string }[] }>().items;
async function addPantry(cookie: string, names: string[]) {
  const res = await call(cookie, {
    method: 'POST',
    url: '/pantry/changes',
    payload: {
      add: names.map((name) => ({ name, ingredientId: null })),
      removeNames: [],
      removeIds: [],
      confirmed: true,
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ items: { id: string; name: string }[] }>().items;
}

describe('confirm by tap', () => {
  test('tap confirms a severe rule; exactly one rule even when tapped twice at once', async () => {
    const p = await player();
    const id = await seed(p.userId, PEANUT());
    const [a, b] = await Promise.all([confirm(p.cookie, id), confirm(p.cookie, id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.code).toBe('proposal_closed');
    expect(await count('rules', p.userId)).toBe(1);
    expect(await proposal(id)).toMatchObject({ status: 'confirmed', channel: 'tap' });
    const won = (a.statusCode === 200 ? a : b).json<ConfirmResponse>();
    expect(won.parts).toEqual([lineOf('rule.stamped', { ingredient: 'peanut' }), lineOf('rule.severe_label_reminder')]);
    expect(won.trail).toEqual({
      id,
      origin: 'server',
      kind: 'rule',
      summary: 'peanut, a severe allergy',
      undoUntil: new Date(clock + UNDO_WINDOW_MS).toISOString(),
    });
    expect((await proposal(id)).write_ref).not.toBeNull();
  });

  test('fix round 5 (H2): a tap that names the current conversation writes only a card from that conversation', async () => {
    const p = await player();
    const [c1, c2] = await Promise.all([1, 2].map(async () => (await sql<{ id: string }[]>`insert into conversations (user_id) values (${p.userId}) returning id`)[0].id));
    const card = buildProfileCard({ marketDays: [6] });
    const inC1 = (
      await db.transaction((tx) => createProposal(tx, config.keyring, { userId: p.userId, conversationId: c1, turnSeq: 1, card }, new Date(clock)))
    ).proposalId;
    const loose = await seed(p.userId, card); // no conversation (forgotten, or never had one)
    // From an earlier conversation, after a clear (null), or with no conversation at all: closed, nothing written.
    for (const [id, conversationId] of [[inC1, c2], [inC1, null], [loose, c1], [loose, null]] as const) {
      const res = await confirm(p.cookie, id, { channel: 'tap', conversationId });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('proposal_closed');
    }
    expect(await proposal(inC1)).toMatchObject({ status: 'open', write_ref: null });
    // The same card, tapped in its own conversation, is written; a tap that names none is unchanged (no check).
    expect((await confirm(p.cookie, inC1, { channel: 'tap', conversationId: c1 })).statusCode).toBe(200);
    expect((await confirm(p.cookie, loose)).statusCode).toBe(200);
  });

  // M7 Step 6 (Ruling 12): a spoken yes is held to the typed yes's rule: never a severe card.
  test.each(['typed_yes', 'spoken_yes'] as const)('the guard itself: a %s on a severe card → 400 tap_required, the card stays open (§7.6)', async (channel) => {
    const p = await player();
    for (const card of [PEANUT(), ruleCard('sesame', 'allergy')]) {
      const id = await seed(p.userId, card);
      const err = await db
        .transaction((tx) =>
          confirmProposalIn(
            tx,
            { keyring: config.keyring, catalog },
            p.userId,
            id,
            channel,
            undefined,
            new Date(clock),
          ),
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 400, code: 'tap_required' });
      expect(await proposal(id)).toMatchObject({ status: 'open' });
    }
    // Even a severe card whose stored flag alone says severe.
    const garlic = await seed(p.userId, ruleCard('garlic', 'intolerance'));
    await sql`update mentor_proposals set severe = true where id = ${garlic}`;
    const err = await db
      .transaction((tx) =>
        confirmProposalIn(
          tx,
          { keyring: config.keyring, catalog },
          p.userId,
          garlic,
          channel,
          undefined,
          new Date(clock),
        ),
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'tap_required' });
    expect(await count('rules', p.userId)).toBe(0);
  });

  test('channel typed_yes over HTTP → 400, nothing written; the body is strict', async () => {
    const p = await player();
    const id = await seed(p.userId, ruleCard('garlic', 'intolerance'));
    for (const payload of [
      { channel: 'typed_yes' },
      // M7 Step 6: a spoken yes exists only inside runTurn too.
      { channel: 'spoken_yes' },
      {},
      { channel: 'tap', extra: 1 },
      { channel: 'tap', edits: { severity: 'mild' } },
      { channel: 'tap', edits: { note: 'x' } },
    ]) {
      const res = await confirm(p.cookie, id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    expect(await count('rules', p.userId)).toBe(0);
    expect(await proposal(id)).toMatchObject({ status: 'open', channel: null });
  });

  test("another user's proposal → 404; expired (PROPOSAL_TTL_MS + 1) → 409 proposal_closed; purged or malformed → 404", async () => {
    const p = await player();
    const q = await player();
    const id = await seed(p.userId, PEANUT());
    const other = await confirm(q.cookie, id);
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe('not_found');
    expect((await confirm(p.cookie, 'not-a-uuid')).statusCode).toBe(404);
    clock += PROPOSAL_TTL_MS + 1;
    const late = await confirm(p.cookie, id);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('proposal_closed');
    // The purge (retention job, or the next createProposal) removes the row: a late tap is then a 404.
    await seed(p.userId, ruleCard('garlic', 'intolerance'));
    expect(await proposal(id)).toBeUndefined();
    expect((await confirm(p.cookie, id)).statusCode).toBe(404);
    expect(await count('rules', p.userId)).toBe(0);
  });

  test('no health_data at confirm → 403, proposal stays open; after granting, the same tap works', async () => {
    const p = await player(false);
    const id = await seed(p.userId, PEANUT());
    const res = await confirm(p.cookie, id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'consent_required', details: { purpose: 'health_data' } });
    expect(await proposal(id)).toMatchObject({ status: 'open' });
    await grantHealth(p.cookie);
    expect((await confirm(p.cookie, id)).statusCode).toBe(200);
    expect(await count('rules', p.userId)).toBe(1);
  });

  test('profile and pantry cards need no consent', async () => {
    const p = await player(false);
    const prof = await seed(p.userId, buildProfileCard({ marketDays: [6] }));
    const res = await confirm(p.cookie, prof);
    expect(res.statusCode).toBe(200);
    expect(res.json<ConfirmResponse>().parts).toEqual([lineOf('schedule.set', { summary: 'market day Saturday' })]);
    const pan = await seed(p.userId, buildPantryCard({ add: ['rice', 'lentils'], remove: [] }, catalog.graph));
    const r2 = await confirm(p.cookie, pan);
    expect(r2.statusCode).toBe(200);
    expect(r2.json<ConfirmResponse>().parts).toEqual([lineOf('pantry.added', { items: 'rice and lentils' })]);
    expect((await pantryOf(p.cookie)).map((i) => i.name).sort()).toEqual(['lentils', 'rice']);
  });

  test('deleted account → 401', async () => {
    const p = await player();
    const id = await seed(p.userId, PEANUT());
    expect(
      (await call(p.cookie, { method: 'DELETE', url: '/me', payload: { confirm: 'delete my account' } })).statusCode,
    ).toBe(204);
    const res = await confirm(p.cookie, id);
    expect(res.statusCode).toBe(401);
  });

  test('severity edit to intolerance writes an intolerance rule; an edit on any other card → 400', async () => {
    const p = await player();
    const id = await seed(p.userId, PEANUT());
    const res = await confirm(p.cookie, id, { channel: 'tap', edits: { severity: 'intolerance' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<ConfirmResponse>().parts).toEqual([lineOf('rule.stamped', { ingredient: 'peanut' })]);
    expect((await rulesOf(p.cookie)).map((r) => r.severity)).toEqual(['intolerance']);
    const meal = await seed(p.userId, buildMealCard({ eatenOn: TODAY, slot: 'lunch', description: 'toast' }));
    const bad = await confirm(p.cookie, meal, { channel: 'tap', edits: { severity: 'allergy' } });
    expect(bad.statusCode).toBe(400);
    expect(await proposal(meal)).toMatchObject({ status: 'open' });
  });

  test('a meal card logs, with the slot word and the estimate note', async () => {
    const p = await player();
    const snack = await seed(p.userId, buildMealCard({ eatenOn: TODAY, slot: 'snack', description: 'toast' }));
    const r = await confirm(p.cookie, snack);
    expect(r.json<ConfirmResponse>().parts).toEqual([
      lineOf('log.logged', { meal: 'a snack' }),
      lineOf('log.estimate_note'),
    ]);
    const other = await seed(p.userId, buildMealCard({ eatenOn: TODAY, slot: 'other', description: 'soup' }));
    expect((await confirm(p.cookie, other)).json<ConfirmResponse>().parts[0]).toEqual(
      lineOf('log.logged', { meal: 'meal' }),
    );
    expect(await count('meal_logs', p.userId)).toBe(2);
  });

  test('a validation refusal from the service is a 400 and the card stays open', async () => {
    const p = await player();
    const old = await seed(p.userId, buildMealCard({ eatenOn: '2026-10-01', slot: 'lunch', description: 'toast' }));
    const res = await confirm(p.cookie, old);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.problems.length).toBeGreaterThan(0);
    expect(await proposal(old)).toMatchObject({ status: 'open' });
    expect(await count('meal_logs', p.userId)).toBe(0);
  });
});

describe('reject', () => {
  test('reject closes the card, writes nothing; a second reject or a tap after → 409', async () => {
    const p = await player();
    const id = await seed(p.userId, PEANUT());
    const r = await reject(p.cookie, id);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ parts: [lineOf('rule.not_quite')] });
    expect(await proposal(id)).toMatchObject({ status: 'rejected', channel: null });
    expect((await reject(p.cookie, id)).json().error.code).toBe('proposal_closed');
    expect((await confirm(p.cookie, id)).json().error.code).toBe('proposal_closed');
    expect(await count('rules', p.userId)).toBe(0);
    const meal = await seed(p.userId, buildMealCard({ eatenOn: TODAY, slot: 'lunch', description: 'toast' }));
    expect((await reject(p.cookie, meal)).json()).toEqual({ parts: [lineOf('card.rejected')] });
    const q = await player();
    expect((await reject(q.cookie, meal)).statusCode).toBe(404);
  });
});

describe('undo', () => {
  test('undo within 5 minutes removes the rule; at 5 min + 1 ms → 409 undo_window_closed', async () => {
    const p = await player();
    const id = await seed(p.userId, PEANUT());
    expect((await confirm(p.cookie, id)).statusCode).toBe(200);
    clock += UNDO_WINDOW_MS;
    const u = await undo(p.cookie, id);
    expect(u.statusCode).toBe(200);
    expect(u.json()).toEqual({ parts: [lineOf('rule.voided', { ingredient: 'peanut' })], undone: true });
    expect(await count('rules', p.userId)).toBe(0);
    // markDecided keeps channel and write_ref on 'undone' (COALESCE) and clears the undo payload.
    expect(await proposal(id)).toMatchObject({ status: 'undone', channel: 'tap', undo_sealed: null });
    expect((await proposal(id)).write_ref).not.toBeNull();
    expect((await undo(p.cookie, id)).json().error.code).toBe('proposal_closed');

    const id2 = await seed(p.userId, ruleCard('garlic', 'intolerance'));
    expect((await confirm(p.cookie, id2)).statusCode).toBe(200);
    clock += UNDO_WINDOW_MS + 1;
    const late = await undo(p.cookie, id2);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('undo_window_closed');
    expect(await count('rules', p.userId)).toBe(1);
  });

  test('an open card is not undoable (409); a vanished or foreign one answers undo.nothing, never a 500', async () => {
    const p = await player();
    const q = await player();
    const id = await seed(p.userId, PEANUT());
    expect((await undo(p.cookie, id)).json().error.code).toBe('proposal_closed');
    expect((await confirm(p.cookie, id)).statusCode).toBe(200);
    expect((await undo(q.cookie, id)).json()).toEqual({ parts: [lineOf('undo.nothing')], undone: false });
    expect((await undo(p.cookie, 'nope')).json()).toEqual({ parts: [lineOf('undo.nothing')], undone: false });
    // Forgotten (the proposal row is deleted with the conversations): nothing to undo, the rule stays.
    expect((await call(p.cookie, { method: 'DELETE', url: '/mentor/conversations' })).statusCode).toBe(204);
    const u = await undo(p.cookie, id);
    expect(u.statusCode).toBe(200);
    expect(u.json()).toEqual({ parts: [lineOf('undo.nothing')], undone: false });
    expect(await count('rules', p.userId)).toBe(1);
  });

  test('undo needs no consent: after a "keep" withdrawal the rule can still be undone', async () => {
    const p = await player();
    const id = await seed(p.userId, PEANUT());
    expect((await confirm(p.cookie, id)).statusCode).toBe(200);
    expect(
      (await call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } }))
        .statusCode,
    ).toBe(204);
    expect((await undo(p.cookie, id)).statusCode).toBe(200);
    expect(await count('rules', p.userId)).toBe(0);
  });

  test('a rule already deleted from the rules screen: the undo still holds', async () => {
    const p = await player();
    const id = await seed(p.userId, PEANUT());
    expect((await confirm(p.cookie, id)).statusCode).toBe(200);
    const ruleId = (await proposal(id)).write_ref!;
    expect((await call(p.cookie, { method: 'DELETE', url: `/rules/${ruleId}` })).statusCode).toBe(204);
    expect((await undo(p.cookie, id)).statusCode).toBe(200);
    expect(await proposal(id)).toMatchObject({ status: 'undone' });
  });

  test('profile undo restores the previous market days; pantry undo restores the milk', async () => {
    const p = await player();
    expect(
      (await call(p.cookie, { method: 'PUT', url: '/profile', payload: { marketDays: [2], mealsPerWeek: 5 } }))
        .statusCode,
    ).toBe(200);
    const prof = await seed(p.userId, buildProfileCard({ marketDays: [6] }));
    expect((await confirm(p.cookie, prof)).statusCode).toBe(200);
    const profile = async () =>
      (await call(p.cookie, { method: 'GET', url: '/profile' })).json<{
        marketDays: number[];
        mealsPerWeek: number | null;
      }>();
    expect(await profile()).toMatchObject({ marketDays: [6], mealsPerWeek: 5 });
    // A change made after the confirm to a key the card did not touch survives the undo.
    expect((await call(p.cookie, { method: 'PUT', url: '/profile', payload: { mealsPerWeek: 9 } })).statusCode).toBe(
      200,
    );
    expect((await undo(p.cookie, prof)).json()).toEqual({ parts: [lineOf('undo')], undone: true });
    expect(await profile()).toMatchObject({ marketDays: [2], mealsPerWeek: 9 });

    const [milk] = await addPantry(p.cookie, ['milk']);
    const card = { ...buildPantryCard({ add: ['eggs'], remove: ['milk'] }, catalog.graph), removeIds: [milk.id] };
    // Another "milk" added after the card was proposed is not on the card, so it stays.
    const laterMilk = (await addPantry(p.cookie, ['Milk'])).find((i) => i.name === 'Milk')!;
    const pan = await seed(p.userId, card);
    const c = await confirm(p.cookie, pan);
    expect(c.json<ConfirmResponse>().parts).toEqual([
      lineOf('pantry.added', { items: 'eggs' }),
      lineOf('pantry.removed', { items: 'milk' }),
    ]);
    expect((await pantryOf(p.cookie)).map((i) => i.id)).toContain(laterMilk.id);
    expect((await pantryOf(p.cookie)).map((i) => i.name).sort()).toEqual(['Milk', 'eggs']);
    expect((await undo(p.cookie, pan)).json()).toEqual({ parts: [lineOf('undo')], undone: true });
    expect((await pantryOf(p.cookie)).map((i) => i.name).sort()).toEqual(['Milk', 'milk']);
  });

  test('undo restores the pre-confirm value even when the patched key was edited since (fix round 1, M2)', async () => {
    const p = await player(false);
    expect((await call(p.cookie, { method: 'PUT', url: '/profile', payload: { marketDays: [2] } })).statusCode).toBe(
      200,
    );
    const prof = await seed(p.userId, buildProfileCard({ marketDays: [6] }));
    expect((await confirm(p.cookie, prof)).statusCode).toBe(200);
    expect((await call(p.cookie, { method: 'PUT', url: '/profile', payload: { marketDays: [3] } })).statusCode).toBe(
      200,
    );
    expect((await undo(p.cookie, prof)).json()).toEqual({ parts: [lineOf('undo')], undone: true });
    expect((await call(p.cookie, { method: 'GET', url: '/profile' })).json()).toMatchObject({ marketDays: [2] });
  });

  test('a pantry undo past the item cap says so plainly and changes nothing; it works once there is room', async () => {
    const p = await player(false);
    const [milk] = await addPantry(p.cookie, ['milk']);
    const pan = await seed(p.userId, {
      ...buildPantryCard({ add: [], remove: ['milk'] }, catalog.graph),
      removeIds: [milk.id],
    });
    expect((await confirm(p.cookie, pan)).statusCode).toBe(200);
    await addPantry(
      p.cookie,
      Array.from({ length: MAX_PANTRY_ITEMS }, (_, i) => `item ${i}`),
    );
    const full = await undo(p.cookie, pan);
    expect(full.statusCode).toBe(200);
    expect(full.json()).toEqual({ parts: [lineOf('pantry.undo_full')], undone: false });
    expect(await proposal(pan)).toMatchObject({ status: 'confirmed' });
    expect(await count('pantry_items', p.userId)).toBe(MAX_PANTRY_ITEMS);
    const room = await call(p.cookie, {
      method: 'POST',
      url: '/pantry/changes',
      payload: { add: [], removeNames: ['item 0'], removeIds: [], confirmed: true },
    });
    expect(room.statusCode).toBe(200);
    expect((await undo(p.cookie, pan)).json()).toEqual({ parts: [lineOf('undo')], undone: true });
    expect((await pantryOf(p.cookie)).map((i) => i.name)).toContain('milk');
  });

  test('a meal undo deletes the log', async () => {
    const p = await player();
    const id = await seed(p.userId, buildMealCard({ eatenOn: TODAY, slot: 'lunch', description: 'toast' }));
    expect((await confirm(p.cookie, id)).statusCode).toBe(200);
    expect((await undo(p.cookie, id)).json()).toEqual({ parts: [lineOf('undo')], undone: true });
    expect(await count('meal_logs', p.userId)).toBe(0);
  });
});

describe('audit and logs', () => {
  test('audit events are content-free; no player content in the logs', async () => {
    const logs = captureLogs();
    await app.close();
    app = await buildApp({ config, db, mailer, ai: null, now: () => new Date(clock), logger: logs.logger });
    const p = await player();
    const id = await seed(p.userId, PEANUT());
    expect((await confirm(p.cookie, id)).statusCode).toBe(200);
    expect((await undo(p.cookie, id)).statusCode).toBe(200);
    const rej = await seed(p.userId, ruleCard('garlic', 'intolerance'));
    expect((await reject(p.cookie, rej)).statusCode).toBe(200);
    const rows = await sql<
      { action: string; target: string | null }[]
    >`select action, target from audit_events where subject_user_id = ${p.userId} and action like 'mentor.%' order by at, action`;
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { action: 'mentor.confirm', target: id },
        { action: 'mentor.undo', target: id },
        { action: 'mentor.reject', target: rej },
      ]),
    );
    const all = JSON.stringify(await sql`select * from audit_events`);
    expect(all).not.toMatch(/peanut|garlic/i);
    expect(logs.text()).not.toMatch(/peanut|garlic/i);
  });
});

describe('races on two connections', () => {
  test('confirm and a health_data withdraw-with-delete, at once, never deadlock (20 repetitions)', async () => {
    const p = await player();
    for (let i = 0; i < 20; i++) {
      const id = await seed(
        p.userId,
        i % 2 === 0 ? PEANUT() : buildMealCard({ eatenOn: TODAY, slot: 'lunch', description: 'toast' }),
      );
      const [c, w] = await Promise.all([
        confirm(p.cookie, id),
        call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } }),
      ]);
      expect(
        [
          [200, 204],
          [403, 204],
          [404, 204],
        ],
        `rep ${i}: ${c.body}`,
      ).toContainEqual([c.statusCode, w.statusCode]);
      expect(await count('rules', p.userId)).toBe(0);
      expect(await count('meal_logs', p.userId)).toBe(0);
      expect(await count('mentor_proposals', p.userId)).toBe(0);
      await grantHealth(p.cookie);
    }
  });

  test('confirm and forget, at once: the write and the card go together or the tap finds nothing', async () => {
    const p = await player();
    for (let i = 0; i < 10; i++) {
      const id = await seed(p.userId, ruleCard('garlic', 'intolerance'));
      const before = await count('rules', p.userId);
      const [c, f] = await Promise.all([
        confirm(p.cookie, id),
        call(p.cookie, { method: 'DELETE', url: '/mentor/conversations' }),
      ]);
      expect(
        [
          [200, 204],
          [404, 204],
        ],
        `rep ${i}`,
      ).toContainEqual([c.statusCode, f.statusCode]);
      expect(await count('rules', p.userId)).toBe(before + (c.statusCode === 200 ? 1 : 0));
      expect(await count('mentor_proposals', p.userId)).toBe(0);
      // The confirmed rule (if any) is the player's to keep; clear it for the next round.
      await sql`delete from rules where user_id = ${p.userId}`;
    }
  });

  test('undo and a health_data withdraw-with-delete, at once, never deadlock (20 repetitions, rule and meal)', async () => {
    const p = await player();
    for (let i = 0; i < 20; i++) {
      const id = await seed(
        p.userId,
        i % 2 === 0
          ? ruleCard('garlic', 'intolerance')
          : buildMealCard({ eatenOn: TODAY, slot: 'lunch', description: 'toast' }),
      );
      expect((await confirm(p.cookie, id)).statusCode).toBe(200);
      const [u, w] = await Promise.all([
        undo(p.cookie, id),
        call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } }),
      ]);
      expect(w.statusCode, `rep ${i}: ${w.body}`).toBe(204);
      expect(u.statusCode, `rep ${i}: ${u.body}`).toBe(200);
      // Undo first (the write reversed) or the withdraw first (nothing left to undo).
      expect([true, false]).toContain(u.json<{ undone: boolean }>().undone);
      expect(await count('rules', p.userId)).toBe(0);
      expect(await count('meal_logs', p.userId)).toBe(0);
      expect(await count('mentor_proposals', p.userId)).toBe(0);
      await grantHealth(p.cookie);
    }
  });

  test('confirm and undo of the same card, at once: never a 500; the end state is consistent', async () => {
    const p = await player();
    for (let i = 0; i < 10; i++) {
      const id = await seed(p.userId, ruleCard('garlic', 'intolerance'));
      const [c, u] = await Promise.all([confirm(p.cookie, id), undo(p.cookie, id)]);
      expect(c.statusCode).toBe(200);
      expect([200, 409]).toContain(u.statusCode);
      const st = (await proposal(id)).status;
      expect(st).toBe(u.statusCode === 200 ? 'undone' : 'confirmed');
      expect(await count('rules', p.userId)).toBe(st === 'undone' ? 0 : 1);
      await sql`delete from rules where user_id = ${p.userId}`;
    }
  });
});
