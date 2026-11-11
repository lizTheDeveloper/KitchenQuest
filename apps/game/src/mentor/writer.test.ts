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
/** The daily write cap's 429: only it carries details.retryAfterSeconds. */
const writeCap = (): ApiResult<never> => ({ ok: false, status: 429, error: { code: 'rate_limited', message: '', details: { retryAfterSeconds: 3600 }, retryAfter: 3600 } });
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
    expect(calls).toEqual([{ name: 'confirmProposal', args: ['P1', { severity: 'allergy' }, undefined] }]);
    expect(out).toMatchObject({ ok: true, trail });
    expect(said(out.items)).toEqual(['rule.stamped']);
    expect(JSON.stringify(out.items)).not.toContain('safe!');
  });

  test('M-6: a card from an earlier conversation, tapped after a new one began, closes with card.earlier_conversation', async () => {
    const store = createStore(null);
    store.update((s) => ({ ...s, ...signedIn }));
    const { client } = fakeClient({ confirmProposal: () => fail(409, 'proposal_closed') });
    let current: string | null = 'c2';
    const writer = createCardWriter({ client, store, dialogue: createDialogue(content.pan), graph, ruleTerms: content.ruleTerms, now: () => T0, conversationId: () => current });
    const out = await writer.confirm({ ...server(milk(), 'P1'), conversationId: 'c1' }, 'tap');
    expect(out).toMatchObject({ ok: false, reason: 'closed' });
    expect(said(out.items)).toEqual(['card.earlier_conversation']);
    // A card of the conversation the player is in that closed (expired, decided) gets no such line.
    current = 'c1';
    const same = await writer.confirm({ ...server(milk(), 'P2'), conversationId: 'c1' }, 'tap');
    expect(same.items).toEqual([]);
  });

  test('H2: a server card tap names the conversation the player is in now', async () => {
    const trail = { id: 'P1', origin: 'server' as const, kind: 'rule' as const, summary: 'milk', undoUntil: '2026-11-10T12:05:00Z' };
    const store = createStore(null);
    store.update((s) => ({ ...s, ...signedIn }));
    const { client, calls } = fakeClient({ confirmProposal: () => ok({ trail, parts: [] }) });
    let current: string | null = 'c1';
    const writer = createCardWriter({ client, store, dialogue: createDialogue(content.pan), graph, ruleTerms: content.ruleTerms, now: () => T0, conversationId: () => current });
    await writer.confirm(server(milk(), 'P1'), 'tap');
    current = null;
    await writer.confirm(server(milk(), 'P2'), 'tap');
    expect(calls.map((c) => c.args)).toEqual([['P1', undefined, 'c1'], ['P2', undefined, null]]);
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

  test('429 on the tap: the daily write cap is `limited` with write.daily_limit; a per-minute 429 stays `network`', async () => {
    const meal = buildMealCard({ eatenOn: '2026-11-10', slot: 'breakfast', description: 'toast' });
    const capped = setup({ createMeal: () => writeCap(), confirmProposal: () => writeCap() }, signedIn);
    const out = await capped.writer.confirm(local(meal), 'tap');
    expect(out).toMatchObject({ ok: false, reason: 'limited' });
    expect(said(out.items)).toEqual(['write.daily_limit']);
    expect(await capped.writer.confirm(server(milk()), 'tap')).toMatchObject({ ok: false, reason: 'limited' });
    const busy = setup({ createMeal: () => fail(429, 'rate_limited') }, signedIn);
    expect(await busy.writer.confirm(local(meal), 'tap')).toMatchObject({ ok: false, reason: 'network' });
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
    expect(await b).toMatchObject({ ok: false, reason: 'busy' });
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
    expect(said((await writer.undo(pantry.trail)).items)).toEqual(['undo']);
    expect(store.get().localPantry).toEqual([{ id: 'e1', name: 'eggs', ingredientId: 'egg' }]);
    expect(said((await writer.undo(p.trail)).items)).toEqual(['undo']);
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
    expect(said((await writer.undo(prof.trail)).items)).toEqual(['undo']);
    expect(calls.at(-1)).toEqual({ name: 'putProfile', args: [{ marketDays: [2] }] });
  });

  test('signed in rule undo deletes the written row and refreshes; server undo calls undoWrite', async () => {
    const saved: Rule = { id: 'r9', target: { kind: 'ingredient', ids: ['milk'] }, type: 'avoid', severity: 'intolerance' };
    const { calls, writer } = setup({
      createRule: () => ok({ rule: saved }, 201),
      deleteRule: () => ok(null, 204),
      me: () => ok({ id: 'u1', email: 'cook@example.com', entitlements: [] }),
      listRules: () => ok({ rules: [] }),
      undoWrite: () => ok({ parts: [{ kind: 'line', line: { trigger: 'undo', vars: {} } }], undone: true }),
    }, signedIn);
    const out = await writer.confirm(local(milk()), 'tap');
    if (!out.ok) throw new Error('expected a write');
    expect(said((await writer.undo(out.trail)).items)).toEqual(['rule.voided']);
    expect(calls.map((c) => c.name)).toEqual(['createRule', 'me', 'listRules', 'deleteRule', 'me', 'listRules']);
    expect(calls[3].args).toEqual(['r9']);
    const serverTrail = { id: 'P1', origin: 'server' as const, kind: 'pantry' as const, summary: 's', undoUntil: '2026-11-10T12:05:00Z' };
    expect(said((await writer.undo(serverTrail)).items)).toEqual(['undo']);
    expect(calls.at(-1)).toEqual({ name: 'undoWrite', args: ['P1'] });
  });

  test('undo after the window does nothing and says so', async () => {
    const { store, writer, later, calls } = setup({});
    const out = await writer.confirm(local(ruleCard('sesame', 'allergy')), 'tap');
    if (!out.ok) throw new Error('expected a write');
    later(UNDO_WINDOW_MS + 1);
    expect(said((await writer.undo(out.trail)).items)).toEqual(['undo.nothing']);
    expect(store.get().localRules).toHaveLength(1);
    const serverTrail = { id: 'P1', origin: 'server' as const, kind: 'rule' as const, summary: 's', undoUntil: T0.toISOString() };
    expect(said((await writer.undo(serverTrail)).items)).toEqual(['undo.nothing']);
    expect(calls).toEqual([]);
  });

  test('signed out rule undo removes exactly that rule', async () => {
    const { store, writer } = setup({});
    const keep = await writer.confirm(local(milk(), 'A'), 'tap');
    const out = await writer.confirm(local(ruleCard('sesame', 'allergy'), 'B'), 'tap');
    if (!out.ok || !keep.ok) throw new Error('expected writes');
    expect(said((await writer.undo(out.trail)).items)).toEqual(['rule.voided']);
    expect(store.get().localRules.map((r) => r.id)).toEqual([keep.trail.id]);
    // A second undo of the same entry finds nothing.
    expect(said((await writer.undo(out.trail)).items)).toEqual(['undo.nothing']);
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
    expect(await writer.undo({ id: 'P1', origin: 'server', kind: 'rule', summary: 's', undoUntil: '2026-11-10T12:05:00Z' })).toEqual({ status: 'nothing', items: [] });
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

describe('undo outcomes (Step 8 fix round 1 carry)', () => {
  const entry = { id: 'P1', origin: 'server' as const, kind: 'pantry' as const, summary: 's', undoUntil: '2026-11-10T12:05:00Z' };
  const lineParts = (trigger: string) => [{ kind: 'line' as const, line: { trigger, vars: {} } }];

  test('server undone:true → undone; undone:false with pantry.undo_full → full (kept); undone:false otherwise → nothing', async () => {
    let answer: ApiResult<unknown> = ok({ parts: lineParts('undo'), undone: true });
    const { writer } = setup({ undoWrite: () => answer }, signedIn);
    expect(await writer.undo(entry)).toMatchObject({ status: 'undone' });
    answer = ok({ parts: lineParts('pantry.undo_full'), undone: false });
    const full = await writer.undo(entry);
    expect(full.status).toBe('full');
    expect(said(full.items)).toEqual(['pantry.undo_full']);
    answer = ok({ parts: lineParts('undo.nothing'), undone: false });
    expect(await writer.undo(entry)).toMatchObject({ status: 'nothing' });
  });

  test('offline or a server error → failed, so the entry stays to try again', async () => {
    const { writer } = setup({ undoWrite: () => fail(0, 'network') }, signedIn);
    expect(await writer.undo(entry)).toEqual({ status: 'failed', items: [] });
  });

  test('a local pantry undo into a full pantry is full, and a later undo still works', async () => {
    let full = true;
    const { writer } = setup({
      changePantry: (change) => {
        const c = change as { removeIds: string[] };
        if (c.removeIds.length > 0 && full) return fail(400, 'too_many_items');
        return ok({ items: [], removed: [], addedIds: c.removeIds.length > 0 ? [] : ['n1'] });
      },
    }, signedIn);
    const out = await writer.confirm(local(buildPantryCard({ add: ['rice'], remove: [] }, graph)), 'tap');
    if (!out.ok) throw new Error('expected a write');
    expect(await writer.undo(out.trail)).toMatchObject({ status: 'full' });
    full = false;
    expect(await writer.undo(out.trail)).toMatchObject({ status: 'undone' });
  });
});

describe('fix round 1', () => {
  test('I1: a typed yes while the tap is in flight is busy, never closed; the tap still writes', async () => {
    let finish!: (r: ApiResult<unknown>) => void;
    const { writer, calls } = setup({ getProfile: () => ok({ marketDays: [], mealsPerWeek: null, country: null, region: null, mealWindows: [] }), putProfile: () => new Promise((r) => { finish = r; }) }, signedIn);
    const view = local(buildProfileCard({ marketDays: [6] }));
    const tap = writer.confirm(view, 'tap');
    await new Promise((r) => setTimeout(r, 0));
    expect(await writer.confirm(view, 'typed_yes')).toEqual({ ok: false, reason: 'busy', items: [] });
    finish(ok({ marketDays: [6], mealsPerWeek: null, country: null, region: null, mealWindows: [] }));
    expect((await tap).ok).toBe(true);
    expect(calls.filter((c) => c.name === 'putProfile')).toHaveLength(1);
    // Once written, it is closed.
    expect(await writer.confirm(view, 'tap')).toMatchObject({ ok: false, reason: 'closed' });
  });

  test('M2: a second undo while one is in flight is busy; the write is reversed once', async () => {
    let finish!: (r: ApiResult<unknown>) => void;
    const { writer, calls } = setup({ undoWrite: () => new Promise((r) => { finish = r; }) }, signedIn);
    const entry = { id: 'P1', origin: 'server' as const, kind: 'meal' as const, summary: 's', undoUntil: '2026-11-10T12:05:00Z' };
    const first = writer.undo(entry);
    expect(await writer.undo(entry)).toEqual({ status: 'busy', items: [] });
    finish(ok({ parts: [{ kind: 'line', line: { trigger: 'undo', vars: {} } }], undone: true }));
    expect((await first).status).toBe('undone');
    expect(calls.filter((c) => c.name === 'undoWrite')).toHaveLength(1);
  });
});

describe('raiseRule (the rules screen raising an account rule)', () => {
  const ids = (): string[] => {
    const card = ruleCard('coconut', 'allergy');
    if (card.kind !== 'rule') throw new Error();
    return card.rule.target.ids;
  };
  const at = (severity: Rule['severity']): Rule => ({ id: 's1', target: { kind: 'category', ids: ids() }, type: 'avoid', severity });
  const raisedCard = (term: 'allergy' | 'intolerance' = 'allergy'): ProposalCard => ruleCard('coconut', term);
  const me = () => ok({ id: 'u1', email: 'cook@example.com', entitlements: [] });

  /**
   * A fake account whose server copy is `box.rule` at `box.version`; PUT overwrites it, as the API does, and with
   * an If-Match version (the 4th argument) only over that version (N4). `beforePut` runs first: another device's write.
   */
  function account(initial: Rule, storeRule: Rule = initial) {
    const box = { rule: initial, version: 1, puts: [] as unknown[][], beforePut: null as (() => void) | null, capped: false };
    const env = setup({
      updateRule: (...a) => {
        box.beforePut?.();
        box.beforePut = null;
        box.puts.push(a);
        if (box.capped) return writeCap();
        if (a[3] !== undefined && a[3] !== box.version) return fail(409, 'rule_changed');
        box.rule = { ...(a[1] as object), id: 's1' } as Rule;
        box.version++;
        return ok({ rule: box.rule, version: box.version });
      },
      me, listRules: () => ok({ rules: [box.rule], versions: { s1: box.version } }),
    }, { ...signedIn, accountRules: [storeRule] });
    return { ...env, box };
  }

  test('a tap raises the rule with confirmed true, and returns a trail entry with an undo window', async () => {
    const card = raisedCard();
    if (card.kind !== 'rule') throw new Error();
    const { store, writer, box } = account(at('intolerance'));
    const out = await writer.raiseRule(local(card), at('intolerance'));
    expect(box.puts[0]).toEqual(['s1', card.rule, true, 1]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.trail).toMatchObject({ origin: 'local', kind: 'rule' });
    expect(out.trail.id).not.toBe('s1');
    expect(Date.parse(out.trail.undoUntil) - T0.getTime()).toBe(UNDO_WINDOW_MS);
    expect(store.get().accountRules?.[0].severity).toBe(card.rule.severity);
  });

  test('undo puts the account rule back as it was; a second undo has nothing to do', async () => {
    const { store, writer, box } = account(at('intolerance'));
    const out = await writer.raiseRule(local(raisedCard()), at('intolerance'));
    if (!out.ok) throw new Error('raise failed');
    const undone = await writer.undo(out.trail);
    expect(undone.status).toBe('undone');
    expect(said(undone.items)).toEqual(['undo']);
    const { id: _id, ...before } = at('intolerance');
    expect(box.puts[1]).toEqual(['s1', before, true, 2]);
    expect(store.get().accountRules).toEqual([at('intolerance')]);
    expect((await writer.undo(out.trail)).status).toBe('nothing');
  });

  test('I2: a raise is refused when the server already holds the same or a stricter level (the screen was stale)', async () => {
    // The screen still shows intolerance; the account was raised to allergy elsewhere.
    const { writer, box, store } = account(at('allergy'), at('intolerance'));
    const out = await writer.raiseRule(local(raisedCard('intolerance')), at('intolerance'));
    expect(out).toMatchObject({ ok: false, reason: 'closed' });
    expect(said(out.items)).toEqual(['rule.raise_not_stricter']);
    expect(box.puts).toEqual([]);
    expect(box.rule.severity).toBe('allergy');
    expect(store.get().accountRules?.[0].severity).toBe('allergy');
    // Equal level too.
    const same = account(at('allergy'));
    expect((await same.writer.raiseRule(local(raisedCard('allergy')), at('allergy'))).ok).toBe(false);
    expect(same.box.puts).toEqual([]);
  });

  test('N5: a rule gone from the server gets a truthful line, not "same level or stricter"', async () => {
    const { writer, box } = account(at('intolerance'));
    box.rule = { ...at('intolerance'), id: 'other' };
    const out = await writer.raiseRule(local(raisedCard()), at('intolerance'));
    expect(out).toMatchObject({ ok: false, reason: 'closed' });
    expect(said(out.items)).toEqual(['rule.raise_gone']);
    expect(box.puts).toEqual([]);
  });

  test('N6: a raise is refused when the rule under that id is now a different rule (target or type)', async () => {
    const other = ruleCard('sesame', 'intolerance');
    if (other.kind !== 'rule') throw new Error();
    const diffTarget = { ...at('intolerance'), target: other.rule.target };
    const a = account(diffTarget, at('intolerance'));
    expect(said((await a.writer.raiseRule(local(raisedCard()), at('intolerance'))).items)).toEqual(['rule.raise_gone']);
    expect(a.box.puts).toEqual([]);
    const diffType: Rule = { ...at('intolerance'), type: 'limit' };
    const b = account(diffType, at('intolerance'));
    expect((await b.writer.raiseRule(local(raisedCard()), at('intolerance'))).ok).toBe(false);
    expect(b.box.puts).toEqual([]);
  });

  test('N6: undo does nothing when the rule under that id changed target since the raise', async () => {
    const other = ruleCard('sesame', 'allergy');
    if (other.kind !== 'rule') throw new Error();
    const { writer, box } = account(at('intolerance'));
    const out = await writer.raiseRule(local(raisedCard()), at('intolerance'));
    if (!out.ok) throw new Error('raise failed');
    box.rule = { ...box.rule, target: other.rule.target }; // same id and severity, different target
    const undone = await writer.undo(out.trail);
    expect(undone.status).toBe('nothing');
    expect(said(undone.items)).toEqual(['undo.rule_changed']);
    expect(box.puts).toHaveLength(1);
  });

  test('N7: a raise keeps the account rule\'s note, and undo restores the whole earlier rule', async () => {
    const noted: Rule = { ...at('intolerance'), note: 'since 2019' };
    const { writer, box } = account(noted);
    const out = await writer.raiseRule(local(raisedCard()), noted);
    if (!out.ok) throw new Error('raise failed');
    expect(box.rule).toMatchObject({ severity: 'allergy', note: 'since 2019' });
    await writer.undo(out.trail);
    expect(box.rule).toEqual(noted);
  });

  test('I1 scenario A: the screen\'s rule is stale, so `before` comes from the server and undo restores what was really there', async () => {
    // Server holds allergy (raised on the phone); this tab still thinks intolerance, and raises to anaphylactic.
    const strongest = ruleCard('coconut', null);
    const { writer, box } = account(at('allergy'), at('intolerance'));
    const out = await writer.raiseRule(local(strongest), at('intolerance'));
    if (!out.ok) throw new Error('raise failed');
    expect(box.rule.severity).toBe('anaphylactic');
    expect((await writer.undo(out.trail)).status).toBe('undone');
    expect(box.rule.severity).toBe('allergy'); // not intolerance: never weaker than before the raise
  });

  test('N4: another device raises the rule between the raise\'s read and its write: 409, nothing lowered, raise_gone', async () => {
    const { writer, box } = account(at('intolerance'));
    box.beforePut = () => { box.rule = at('anaphylactic'); box.version++; };
    const out = await writer.raiseRule(local(raisedCard('allergy')), at('intolerance'));
    expect(out.ok).toBe(false);
    expect(said(out.items)).toEqual(['rule.raise_gone']);
    expect(box.rule.severity).toBe('anaphylactic');
  });

  test('N4: another device raises the rule between the undo\'s read and its write: 409, the stricter rule stays, undo.rule_changed', async () => {
    const { writer, box } = account(at('intolerance'));
    const out = await writer.raiseRule(local(raisedCard('allergy')), at('intolerance'));
    if (!out.ok) throw new Error('raise failed');
    box.beforePut = () => { box.rule = { ...at('anaphylactic') }; box.version++; };
    const undone = await writer.undo(out.trail);
    expect(undone.status).toBe('nothing');
    expect(said(undone.items)).toEqual(['undo.rule_changed']);
    expect(box.rule.severity).toBe('anaphylactic');
  });

  test('429 on the tap: the daily write cap on undoing a raise says write.daily_limit, and the undo stays possible', async () => {
    const { writer, box } = account(at('intolerance'));
    const out = await writer.raiseRule(local(raisedCard('allergy')), at('intolerance'));
    if (!out.ok) throw new Error('raise failed');
    box.capped = true;
    const undone = await writer.undo(out.trail);
    expect(undone.status).toBe('failed');
    expect(said(undone.items)).toEqual(['write.daily_limit']);
    expect(box.rule.severity).toBe('allergy');
  });

  test('I1 scenario B: a rule changed after the raise is left alone by undo', async () => {
    const { writer, box, store } = account(at('intolerance'));
    const out = await writer.raiseRule(local(raisedCard('allergy')), at('intolerance'));
    if (!out.ok) throw new Error('raise failed');
    box.rule = at('anaphylactic'); // another device raises it further inside the undo window
    const undone = await writer.undo(out.trail);
    expect(undone.status).toBe('nothing');
    expect(said(undone.items)).toEqual(['undo.rule_changed']);
    expect(box.puts).toHaveLength(1); // no second PUT
    expect(box.rule.severity).toBe('anaphylactic');
    expect(store.get().accountRules?.[0].severity).not.toBe('intolerance');
  });

  test('undo of a rule removed meanwhile changes nothing', async () => {
    const { writer, box } = account(at('intolerance'));
    const out = await writer.raiseRule(local(raisedCard()), at('intolerance'));
    if (!out.ok) throw new Error('raise failed');
    const gone = { ...box, rule: { ...box.rule, id: 'other' } };
    box.rule = gone.rule; // the account no longer lists s1
    const undone = await writer.undo(out.trail);
    expect(undone.status).toBe('nothing');
    expect(box.puts).toHaveLength(1);
  });

  test('a failed undo (offline, or the write fails) keeps the entry, and a later undo works', async () => {
    let mode: 'up' | 'list_down' | 'put_down' = 'up';
    let server = at('intolerance');
    const { writer } = setup({
      listRules: () => (mode === 'list_down' ? fail(0, 'network') : ok({ rules: [server] })),
      updateRule: (...a) => {
        if (mode === 'put_down') return fail(500, 'boom');
        server = { ...(a[1] as object), id: 's1' } as Rule;
        return ok({ rule: server });
      },
      me,
    }, { ...signedIn, accountRules: [at('intolerance')] });
    const out = await writer.raiseRule(local(raisedCard()), at('intolerance'));
    if (!out.ok) throw new Error('raise failed');
    mode = 'list_down';
    expect((await writer.undo(out.trail)).status).toBe('failed');
    mode = 'put_down';
    expect((await writer.undo(out.trail)).status).toBe('failed');
    expect(server.severity).toBe('allergy');
    mode = 'up';
    expect((await writer.undo(out.trail)).status).toBe('undone');
    expect(server.severity).toBe('intolerance');
  });

  test('an offline raise writes nothing and keeps the card open', async () => {
    const { writer } = setup({ listRules: () => fail(0, 'network') }, { ...signedIn, accountRules: [at('intolerance')] });
    const view = local(raisedCard());
    expect(await writer.raiseRule(view, at('intolerance'))).toMatchObject({ ok: false, reason: 'network' });
    expect(await writer.raiseRule(view, at('intolerance'))).toMatchObject({ ok: false, reason: 'network' });
  });

  test('a raise is written once: a second call for the same card is closed', async () => {
    const { writer, box } = account(at('intolerance'));
    const view = local(raisedCard());
    await writer.raiseRule(view, at('intolerance'));
    expect(await writer.raiseRule(view, at('intolerance'))).toMatchObject({ ok: false, reason: 'closed' });
    expect(box.puts).toHaveLength(1);
  });

  test('Family Table: nothing is raised', async () => {
    const { writer, calls } = setup({}, { ...signedIn, settings: { ...createStore(null).get().settings, familyTable: true } });
    expect(await writer.raiseRule(local(raisedCard()), at('intolerance'))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(calls).toEqual([]);
  });
});
