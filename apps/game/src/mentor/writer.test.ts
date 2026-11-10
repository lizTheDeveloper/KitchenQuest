import { describe, expect, test } from 'vitest';
import { buildMealCard, buildPantryCard, buildProfileCard, buildRuleCard, UNDO_WINDOW_MS, validateRules, type ProposalCard, type Rule } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { ApiResult } from '../api/types';
import { content, graph } from '../content';
import { buildRecipeCard } from '../recipes/card-model';
import { activeRules, RULES_INVALID_MESSAGE } from '../recipes/rules';
import { createStore, type PlayerState } from '../state/store';
import { createDialogue } from './dialogue';
import type { LocalCardView, PanItem, ServerCardView } from './reply';
import { createCardWriter, partsToItems, type WriteOutcome } from './writer';

const T0 = new Date('2026-11-10T12:00:00Z');
const ok = <T>(data: T, status = 200): ApiResult<T> => ({ ok: true, status, data });
const fail = (status: number, code: string, details?: unknown): ApiResult<never> =>
  ({ ok: false, status, error: { code, message: '', ...(details === undefined ? {} : { details }) } });

type Handler = (...args: unknown[]) => Promise<ApiResult<unknown>> | ApiResult<unknown>;
function fakeClient(script: Partial<Record<keyof ApiClient, Handler>>) {
  const calls: { name: string; args: unknown[] }[] = [];
  const client = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => {
      calls.push({ name, args });
      const f = script[name as keyof ApiClient];
      return f ? Promise.resolve(f(...args)) : Promise.reject(new Error(`unexpected call: ${name}`));
    },
  }) as ApiClient;
  return { client, calls };
}

const ruleCard = (term: string, severity: 'allergy' | 'intolerance' | null): ProposalCard => {
  const r = buildRuleCard({ term, severity }, graph, content.ruleTerms);
  if (!r.ok) throw new Error(term);
  return r.card;
};
const local = (card: ProposalCard, localId = 'L1'): LocalCardView => ({ origin: 'local', localId, card, issuedTurn: 1 });
const server = (card: ProposalCard, proposalId = 'P1'): ServerCardView => ({ origin: 'server', proposalId, expiresAt: '2026-11-10T12:30:00Z', card, issuedTurn: 1 });
const said = (items: PanItem[]) => items.flatMap((i) => (i.kind === 'said' ? [i.said.trigger] : []));

function setup(script: Partial<Record<keyof ApiClient, Handler>>, patch: Partial<PlayerState> = {}) {
  const store = createStore(null);
  store.update((s) => ({ ...s, ...patch }));
  let now = T0;
  const { client, calls } = fakeClient(script);
  const writer = createCardWriter({ client, store, dialogue: createDialogue(content.pan), graph, ruleTerms: content.ruleTerms, now: () => now });
  return { store, calls, writer, later: (ms: number) => { now = new Date(T0.getTime() + ms); } };
}
const signedIn: Partial<PlayerState> = { account: { email: 'cook@example.com' }, accountRules: [] };
const milk = () => ruleCard('milk', 'intolerance');

describe('card writer', () => {
  test('signed out: stamping writes a valid rule to localRules', async () => {
    const { store, calls, writer } = setup({});
    const out: WriteOutcome = await writer.confirm(local(ruleCard('sesame', 'allergy')), 'tap');
    expect(calls).toEqual([]);
    expect(out.ok).toBe(true);
    const rules = store.get().localRules;
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rules[0]).toMatchObject({ target: { ids: ['sesame'] }, severity: 'allergy', type: 'avoid' });
    expect(validateRules(rules, graph)).toEqual([]);
    if (out.ok) {
      expect(out.trail).toMatchObject({ id: rules[0].id, origin: 'local', kind: 'rule', summary: 'sesame, an allergy' });
      expect(Date.parse(out.trail.undoUntil) - T0.getTime()).toBe(UNDO_WINDOW_MS);
    }
    expect(said(out.items)).toEqual(['rule.stamped', 'rule.severe_label_reminder']);
  });

  test('signed out: a rule the graph rejects is never stored', async () => {
    const { store, writer } = setup({});
    const card = ruleCard('sesame', 'allergy');
    if (card.kind !== 'rule') throw new Error();
    const bad: ProposalCard = { ...card, rule: { ...card.rule, target: { kind: 'ingredient', ids: ['not_an_id'] } } };
    const out = await writer.confirm(local(bad), 'tap');
    expect(out).toMatchObject({ ok: false, reason: 'invalid' });
    expect(store.get().localRules).toEqual([]);
  });

  test('signed in: stamping calls createRule with confirmed true, then refreshes account rules', async () => {
    const saved: Rule = { id: 'r9', target: { kind: 'ingredient', ids: ['milk'] }, type: 'avoid', severity: 'intolerance' };
    const { store, calls, writer } = setup({
      createRule: () => ok({ rule: saved }, 201),
      me: () => ok({ id: 'u1', email: 'cook@example.com', entitlements: [] }),
      listRules: () => ok({ rules: [saved] }),
    }, signedIn);
    const out = await writer.confirm(local(milk()), 'typed_yes');
    expect(calls.map((c) => c.name)).toEqual(['createRule', 'me', 'listRules']);
    expect(calls[0].args[1]).toBe(true);
    expect(calls[0].args[0]).toEqual({ target: { kind: 'ingredient', ids: ['milk'] }, type: 'avoid', severity: 'intolerance' });
    expect(store.get().accountRules).toEqual([saved]);
    expect(store.get().localRules).toEqual([]);
    expect(out).toMatchObject({ ok: true, trail: { id: 'r9', origin: 'local', kind: 'rule' } });
  });

  test('severe + typed_yes never calls the API', async () => {
    const { calls, writer, store } = setup({}, signedIn);
    const out = await writer.confirm(local(ruleCard('sesame', 'allergy')), 'typed_yes');
    expect(out).toMatchObject({ ok: false, reason: 'tap_required' });
    expect(said(out.items)).toEqual(['rule.tap_needed']);
    // A server card too, and a severity edit that makes a card severe.
    expect((await writer.confirm(server(ruleCard('sesame', 'allergy')), 'typed_yes')).ok).toBe(false);
    // A typed yes to a server card is never sent as a tap: the server's own turn handles it.
    expect(await writer.confirm(server(milk(), 'P2'), 'typed_yes')).toMatchObject({ ok: false, reason: 'tap_required' });
    expect((await writer.confirm(local(milk(), 'L2'), 'typed_yes', { severity: 'anaphylactic' }))).toMatchObject({ ok: false, reason: 'tap_required' });
    expect(calls).toEqual([]);
    expect(store.get().localRules).toEqual([]);
  });

  test('server cards: confirm sends a tap with the edits and maps the parts; the model text part is dropped (R9)', async () => {
    const trail = { id: 'P1', origin: 'server' as const, kind: 'rule' as const, summary: 'milk, an intolerance', undoUntil: '2026-11-10T12:05:00Z' };
    const { calls, writer } = setup({
      confirmProposal: () => ok({ trail, parts: [{ kind: 'line', line: { trigger: 'rule.stamped', vars: { ingredient: 'milk' } } }, { kind: 'text', text: 'It is saved and safe!' }] }),
    }, signedIn);
    const out = await writer.confirm(server(milk()), 'tap', { severity: 'allergy' });
    expect(calls).toEqual([{ name: 'confirmProposal', args: ['P1', { severity: 'allergy' }] }]);
    expect(out).toMatchObject({ ok: true, trail });
    expect(said(out.items)).toEqual(['rule.stamped']);
    expect(JSON.stringify(out.items)).not.toContain('safe!');
  });

  test('403 → a consent item; the card stays open', async () => {
    let n = 0;
    const meal = buildMealCard({ eatenOn: '2026-11-10', slot: 'breakfast', description: 'toast' });
    const { calls, writer } = setup({
      createMeal: () => (++n === 1 ? fail(403, 'consent_required', { purpose: 'health_data' }) : ok({ meal: { ...meal.meal, id: 'm1' } }, 201)),
    }, signedIn);
    const card = local(meal);
    const first = await writer.confirm(card, 'tap');
    expect(first).toMatchObject({ ok: false, reason: 'consent_required' });
    expect(first.items).toContainEqual({ kind: 'consent', purpose: 'health_data' });
    expect(said(first.items)).toEqual(['consent.health_first']);
    // Still open: after consent, the same card writes.
    const second = await writer.confirm(card, 'tap');
    expect(second).toMatchObject({ ok: true, trail: { id: 'm1', kind: 'meal' } });
    expect(calls.map((c) => c.name)).toEqual(['createMeal', 'createMeal']);
    expect(calls[1].args).toEqual([meal.meal, true]);
  });

  test('HTTP mapping: 409 proposal_closed → closed, status 0 → network', async () => {
    const { writer } = setup({ confirmProposal: () => fail(409, 'proposal_closed') }, signedIn);
    expect(await writer.confirm(server(milk()), 'tap')).toMatchObject({ ok: false, reason: 'closed' });
    const offline = setup({ confirmProposal: () => fail(0, 'network') }, signedIn);
    expect(await offline.writer.confirm(server(milk()), 'tap')).toMatchObject({ ok: false, reason: 'network' });
  });

  test('a double confirm makes one call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const trail = { id: 'P1', origin: 'server' as const, kind: 'rule' as const, summary: 's', undoUntil: '2026-11-10T12:05:00Z' };
    const { calls, writer } = setup({ confirmProposal: async () => { await gate; return ok({ trail, parts: [] }); } }, signedIn);
    const card = server(milk());
    const a = writer.confirm(card, 'tap');
    const b = writer.confirm(card, 'tap');
    expect(await b).toMatchObject({ ok: false, reason: 'closed' });
    release();
    expect((await a).ok).toBe(true);
    expect(await writer.confirm(card, 'tap')).toMatchObject({ ok: false, reason: 'closed' });
    expect(calls).toHaveLength(1);
    // A turned-down card is closed too.
    expect(await writer.reject(local(milk(), 'L7'))).toEqual(expect.any(Array));
    expect(await writer.confirm(local(milk(), 'L7'), 'tap')).toMatchObject({ ok: false, reason: 'closed' });
  });

  test('signed out: a meal needs an account', async () => {
    const { calls, writer } = setup({});
    const out = await writer.confirm(local(buildMealCard({ eatenOn: '2026-11-10', slot: 'lunch', description: 'dal' })), 'tap');
    expect(out).toMatchObject({ ok: false, reason: 'needs_account' });
    expect(said(out.items)).toEqual(['log.needs_account']);
    expect(calls).toEqual([]);
  });

  test('reject: local says the line; server calls rejectProposal', async () => {
    const { calls, writer } = setup({ rejectProposal: () => ok({ parts: [{ kind: 'line', line: { trigger: 'card.rejected', vars: {} } }] }) }, signedIn);
    expect(said(await writer.reject(local(milk())))).toEqual(['rule.not_quite']);
    expect(said(await writer.reject(local(buildProfileCard({ marketDays: [6] }), 'L2')))).toEqual(['card.rejected']);
    expect(said(await writer.reject(server(buildProfileCard({ marketDays: [6] }))))).toEqual(['card.rejected']);
    expect(calls.map((c) => c.name)).toEqual(['rejectProposal']);
  });

  test('signed out profile and pantry go to the store, and undo puts them back', async () => {
    const { store, writer } = setup({}, { localPantry: [{ id: 'e1', name: 'eggs', ingredientId: 'egg' }] });
    const p = await writer.confirm(local(buildProfileCard({ marketDays: [6] })), 'tap');
    expect(store.get().localProfile).toMatchObject({ marketDays: [6], mealWindows: [] });
    expect(said(p.items)).toEqual(['schedule.set']);
    const pantry = await writer.confirm(local(buildPantryCard({ add: ['rice'], remove: ['eggs'] }, graph), 'L2'), 'tap');
    expect(store.get().localPantry.map((i) => i.name)).toEqual(['rice']);
    expect(said(pantry.items)).toEqual(['pantry.added', 'pantry.removed']);
    if (!pantry.ok || !p.ok) throw new Error('expected writes');
    expect(said(await writer.undo(pantry.trail))).toEqual(['undo']);
    expect(store.get().localPantry).toEqual([{ id: 'e1', name: 'eggs', ingredientId: 'egg' }]);
    expect(said(await writer.undo(p.trail))).toEqual(['undo']);
    expect(store.get().localProfile).toBeNull();
  });

  test('signed in pantry and profile: undo sends the reverse change by id', async () => {
    const before = [{ id: 'old-rice', name: 'rice', ingredientId: 'rice' }, { id: 'e1', name: 'eggs', ingredientId: 'egg' }];
    const profile = { marketDays: [2], mealsPerWeek: null, country: null, region: null, mealWindows: [] };
    const { calls, writer } = setup({
      changePantry: (change) => {
        const c = change as { removeIds: string[] };
        return c.removeIds.length > 0
          ? ok({ items: before, removed: [], addedIds: [] })
          : ok({ items: [before[0], { id: 'new-rice', name: 'rice', ingredientId: 'rice' }], removed: [before[1]], addedIds: ['new-rice'] });
      },
      getProfile: () => ok(profile),
      putProfile: (patch) => ok({ ...profile, ...(patch as object) }),
    }, signedIn);
    const card = buildPantryCard({ add: ['rice'], remove: ['eggs'] }, graph);
    const pantry = await writer.confirm(local(card), 'tap');
    if (!pantry.ok) throw new Error('expected a write');
    // The route names the rows it added (fix round 1): no read of the pantry first.
    expect(calls.map((c) => c.name)).toEqual(['changePantry']);
    expect(calls[0].args).toEqual([{ add: card.add, removeNames: ['eggs'], removeIds: [] }, true]);
    await writer.undo(pantry.trail);
    // The same-name item that was already there ('old-rice') is never touched; the route's add takes no ids.
    expect(calls[1].args).toEqual([{ add: [{ name: 'eggs', ingredientId: 'egg' }], removeNames: [], removeIds: ['new-rice'] }, true]);

    const prof = await writer.confirm(local(buildProfileCard({ marketDays: [6] }), 'L2'), 'tap');
    if (!prof.ok) throw new Error('expected a write');
    expect(calls.slice(2).map((c) => [c.name, c.args[0]])).toEqual([['getProfile', undefined], ['putProfile', { marketDays: [6] }]]);
    expect(said(await writer.undo(prof.trail))).toEqual(['undo']);
    expect(calls.at(-1)).toEqual({ name: 'putProfile', args: [{ marketDays: [2] }] });
  });

  test('signed in rule undo deletes the written row and refreshes; server undo calls undoWrite', async () => {
    const saved: Rule = { id: 'r9', target: { kind: 'ingredient', ids: ['milk'] }, type: 'avoid', severity: 'intolerance' };
    const { calls, writer } = setup({
      createRule: () => ok({ rule: saved }, 201),
      deleteRule: () => ok(null, 204),
      me: () => ok({ id: 'u1', email: 'cook@example.com', entitlements: [] }),
      listRules: () => ok({ rules: [] }),
      undoWrite: () => ok({ parts: [{ kind: 'line', line: { trigger: 'undo', vars: {} } }] }),
    }, signedIn);
    const out = await writer.confirm(local(milk()), 'tap');
    if (!out.ok) throw new Error('expected a write');
    expect(said(await writer.undo(out.trail))).toEqual(['rule.voided']);
    expect(calls.map((c) => c.name)).toEqual(['createRule', 'me', 'listRules', 'deleteRule', 'me', 'listRules']);
    expect(calls[3].args).toEqual(['r9']);
    const serverTrail = { id: 'P1', origin: 'server' as const, kind: 'pantry' as const, summary: 's', undoUntil: '2026-11-10T12:05:00Z' };
    expect(said(await writer.undo(serverTrail))).toEqual(['undo']);
    expect(calls.at(-1)).toEqual({ name: 'undoWrite', args: ['P1'] });
  });

  test('undo after the window does nothing and says so', async () => {
    const { store, writer, later, calls } = setup({});
    const out = await writer.confirm(local(ruleCard('sesame', 'allergy')), 'tap');
    if (!out.ok) throw new Error('expected a write');
    later(UNDO_WINDOW_MS + 1);
    expect(said(await writer.undo(out.trail))).toEqual(['undo.nothing']);
    expect(store.get().localRules).toHaveLength(1);
    const serverTrail = { id: 'P1', origin: 'server' as const, kind: 'rule' as const, summary: 's', undoUntil: T0.toISOString() };
    expect(said(await writer.undo(serverTrail))).toEqual(['undo.nothing']);
    expect(calls).toEqual([]);
  });

  test('signed out rule undo removes exactly that rule', async () => {
    const { store, writer } = setup({});
    const keep = await writer.confirm(local(milk(), 'A'), 'tap');
    const out = await writer.confirm(local(ruleCard('sesame', 'allergy'), 'B'), 'tap');
    if (!out.ok || !keep.ok) throw new Error('expected writes');
    expect(said(await writer.undo(out.trail))).toEqual(['rule.voided']);
    expect(store.get().localRules.map((r) => r.id)).toEqual([keep.trail.id]);
    // A second undo of the same entry finds nothing.
    expect(said(await writer.undo(out.trail))).toEqual(['undo.nothing']);
  });
});

describe('fix round 1', () => {
  const coconut: Rule = { id: 'r-coco', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'allergy' };
  const coconutCard = () => ruleCard('coconut', 'allergy');

  test.each([429, 0])('a stamped allergen is in the cached account rules even when the refresh gets %i: the dish is never ✅', async (code) => {
    const { store, writer } = setup({
      createRule: () => ok({ rule: coconut }, 201),
      deleteRule: () => ok(null, 204),
      me: () => ok({ id: 'u1', email: 'cook@example.com', entitlements: [] }),
      listRules: () => fail(code, code === 0 ? 'network' : 'rate_limited'),
    }, signedIn);
    const parippu = () => buildRecipeCard({ slug: 'india/kerala/parippu', content, graph, rules: activeRules(store.get(), graph), today: '2026-11-10', showCalories: false });
    expect(parippu().status).toBe('ok');
    const out = await writer.confirm(local(coconutCard()), 'tap');
    expect(out.ok).toBe(true);
    expect(store.get().accountRules).toEqual([coconut]);
    expect(parippu().status).not.toBe('ok');
    // Undo takes it out the same way.
    if (!out.ok) throw new Error();
    await writer.undo(out.trail);
    expect(store.get().accountRules).toEqual([]);
  });

  test('a sign-in to another account while the write was in flight never gets the rule in its cache (E5)', async () => {
    const other: Rule = { id: 'r-other', target: { kind: 'ingredient', ids: ['milk'] }, type: 'avoid', severity: 'intolerance' };
    const box: { store?: ReturnType<typeof setup>['store'] } = {};
    const s = setup({
      createRule: () => {
        box.store!.update((x) => ({ ...x, account: { email: 'other@example.com' }, accountRules: [other] }));
        return ok({ rule: coconut }, 201);
      },
      me: () => ok({ id: 'u2', email: 'other@example.com', entitlements: [] }),
      listRules: () => fail(429, 'rate_limited'),
    }, signedIn);
    box.store = s.store;
    await s.writer.confirm(local(coconutCard()), 'tap');
    expect(s.store.get().accountRules).toEqual([other]);
  });

  test('account rules that never loaded stay unloaded after a stamp (fail closed)', async () => {
    const { store, writer } = setup({
      createRule: () => ok({ rule: coconut }, 201),
      me: () => ok({ id: 'u1', email: 'cook@example.com', entitlements: [] }),
      listRules: () => fail(429, 'rate_limited'),
    }, { account: { email: 'cook@example.com' }, accountRules: null });
    await writer.confirm(local(coconutCard()), 'tap');
    expect(store.get().accountRules).toBeNull();
  });

  test('a severity edit on a diet card keeps its diet form (the rule terms are used, as on the server)', async () => {
    const { store, writer } = setup({});
    const diet = buildRuleCard({ term: 'vegetarian', severity: null }, graph, content.ruleTerms);
    if (!diet.ok) throw new Error();
    expect(diet.card.form).toBe('rule_diet');
    const out = await writer.confirm(local(diet.card), 'tap', { severity: 'preference' });
    if (!out.ok) throw new Error('expected a write');
    expect(out.trail.summary).toBe(`${diet.card.display.ingredient}, a diet rule`);
    expect(store.get().localRules[0]).toMatchObject({ severity: 'preference', target: diet.card.rule.target });
  });

  test('a signed-out rule is validated against what another tab stored, not this tab\'s memory', async () => {
    const storage = new Map<string, string>();
    const st = { get length() { return storage.size; }, clear: () => storage.clear(), key: (i: number) => [...storage.keys()][i] ?? null,
      getItem: (k: string) => storage.get(k) ?? null, removeItem: (k: string) => { storage.delete(k); }, setItem: (k: string, v: string) => { storage.set(k, v); } } as Storage;
    const mine = createStore(st);
    const other = createStore(st);
    mine.update((x) => x);
    // Another tab stores a rule the graph doesn't know; this tab's memory has none.
    other.update((x) => ({ ...x, localRules: [{ id: 'bad', target: { kind: 'ingredient', ids: ['not_an_id'] }, type: 'avoid', severity: 'allergy' }] }));
    const { client } = fakeClient({});
    const writer = createCardWriter({ client, store: mine, dialogue: createDialogue(content.pan), graph, ruleTerms: content.ruleTerms, now: () => T0 });
    expect(await writer.confirm(local(coconutCard()), 'tap')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(mine.get().localRules.map((r) => r.id)).toEqual(['bad']);
  });

  test('Family Table mode: nothing is written, turned down or undone, and no call is made', async () => {
    const { store, calls, writer } = setup({}, { settings: { ...createStore(null).get().settings, familyTable: true } });
    expect(await writer.confirm(local(coconutCard()), 'tap')).toMatchObject({ ok: false, items: [] });
    expect(await writer.reject(server(milk()))).toEqual([]);
    expect(await writer.undo({ id: 'P1', origin: 'server', kind: 'rule', summary: 's', undoUntil: '2026-11-10T12:05:00Z' })).toEqual([]);
    expect(store.get().localRules).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('409 rules_need_review → the invalid-rules message with the Your rules link', async () => {
    const { writer } = setup({ createRule: () => fail(409, 'rules_need_review') }, signedIn);
    const out = await writer.confirm(local(milk()), 'tap');
    expect(out).toEqual({ ok: false, reason: 'invalid', items: [{ kind: 'rules_error', message: RULES_INVALID_MESSAGE, href: '#/rules' }] });
  });
});

test('partsToItems drops model text and keeps lines, choices and consent', () => {
  const items = partsToItems([
    { kind: 'text', text: 'anything' },
    { kind: 'line', line: { trigger: 'didnt_understand', vars: {} } },
    { kind: 'choices', options: [{ id: 'a', name: 'A' }], severity: null },
    { kind: 'consent', purpose: 'ai_health' },
  ], createDialogue(content.pan));
  expect(items.map((i) => i.kind)).toEqual(['said', 'choices', 'consent']);
});
