// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { type PantryItem, type Plan, type Rule, type ToolkitState } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { createStore, type PlayerState, type PlayerStore } from '../state/store';
import type { AppContext } from '../shell/app';
import { canonRecipes, planContextFor } from './context';
import { createWeekStore } from './local-week';
import { byStall, forText, marketScreen } from './market-screen';
import { acceptSlot, offerFor, planScreen } from './plan-screen';
import { practiceDay, renderPlanView, slotDay, writtenLine } from './plan-view';
import { answerNudge, compost, noteNudge, rescueOffer } from './rescue';
import { mountRescue } from './rescue-slot';
import { createWeekSource } from './source';
import { afterMove, mergedWeek, moveCandidates, moveOffer, moveWeek } from './move';
import { grantedOnly, showFailure } from './screen-kit';
import { forgetWeek, plannedOn, rememberedWeek } from './memory';

const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const MON = '2026-11-09';
const TODAY = '2026-11-11';
const NOW = new Date(2026, 10, 11, 12, 0);
/** Under a coconut allergy parippu is ⛔ (coconut oil and grated coconut). */
const COCONUT: Rule = { id: 'r-coco', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'allergy' };
const plan = (items: Plan['items'], patch: Partial<Plan> = {}): Plan => ({ weekStart: MON, items, hard: false, slot: 'unanswered', ...patch });
const dish = (day: number, slug: string) => ({ day, kind: 'dish' as const, slug, servings: 2 });

const noClient = new Proxy({}, { get: (_t, name: string) => () => Promise.reject(new Error(`unexpected call: ${name}`)) }) as ApiClient;

function store(patch: Partial<PlayerState> = {}): PlayerStore {
  const s = createStore(null);
  s.update((x) => ({ ...x, ...patch }));
  return s;
}
const appCtx = (s: PlayerStore, navigated: unknown[] = []): AppContext => ({ store: s, now: () => NOW, navigate: (r) => { navigated.push(r); } });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('plan view', () => {
  test('a blocked item has a disabled Cook and plan.blocked_dish; ❓ never renders ✅', () => {
    const p = plan([dish(0, PARIPPU), dish(1, ONIGIRI)]);
    const rows = [
      { item: p.items[0], status: 'blocked' as const, findings: [{ ingredient: 'coconut oil', ingredientId: 'coconut_oil', kind: 'match' as const, status: 'blocked' as const }] },
      { item: p.items[1], status: 'unverified' as const, findings: [] },
    ];
    const el = renderPlanView({ weekStart: MON, rows, line: writtenLine, onCook: () => undefined });
    const [blocked, unsure] = [...el.querySelectorAll<HTMLElement>('.plan-item')];
    expect(blocked.querySelector<HTMLButtonElement>('.plan-cook')!.disabled).toBe(true);
    expect(content.pan.triggers['plan.blocked_dish'].lines.some((l) => blocked.textContent.includes(l.slice(l.indexOf('}') + 1, l.indexOf('}') + 15)))).toBe(true);
    expect(blocked.querySelector('[data-status]')!.getAttribute('data-status')).toBe('blocked');
    expect(unsure.querySelector<HTMLButtonElement>('.plan-cook')!.disabled).toBe(false);
    expect(unsure.querySelector('.chip')!.getAttribute('data-status')).toBe('unverified');
    expect(unsure.textContent).not.toContain('✅');
    expect(unsure.textContent).toContain(writtenLine('plan.unverified_dish', { dish: 'Onigiri' }).slice(0, 10));
  });
});

describe('weekly slot', () => {
  const toolkit: ToolkitState = { techniques: { legumes: { tier: 'tried', firstAt: '2026-11-01', lastUsedAt: '2026-11-01', recipes: [] }, 'heat-control': { tier: 'seen', firstAt: '2026-11-01', lastUsedAt: '2026-11-01', recipes: [] } } };
  test('offered once; declined → never again this week; hard week → none', () => {
    const offer = offerFor(plan([]), [], toolkit, TODAY);
    expect(offer).toMatchObject({ kind: 'new', technique: 'tempering', recipe: PARIPPU });
    // Offered and saved as 'offered' (pinned, M5 final m1): the same offer again until answered, never a different one.
    const pinned = plan([], { slot: 'offered', offer: { technique: 'tempering', recipe: PARIPPU } });
    expect(offerFor(pinned, [], toolkit, TODAY)).toEqual(offer);
    // M5 final m1: the toolkit changes mid-week (grains now Tried), so the recomputed offer would be another technique
    // (shaping): none is shown, never a second suggestion. An offered week with no pin (saved before pins) shows none.
    const later: ToolkitState = { techniques: { ...toolkit.techniques, grains: { tier: 'tried', firstAt: '2026-11-10', lastUsedAt: '2026-11-10', recipes: [] } } };
    expect(offerFor(plan([]), [], later, TODAY)).not.toBeNull();
    expect(offerFor(plan([]), [], later, TODAY)?.technique).not.toBe('tempering');
    expect(offerFor(pinned, [], later, TODAY)).toBeNull();
    expect(offerFor(plan([], { slot: 'offered' }), [], toolkit, TODAY)).toBeNull();
    expect(offerFor(plan([], { slot: 'declined' }), [], toolkit, TODAY)).toBeNull();
    expect(offerFor(plan([], { slot: 'accepted' }), [], toolkit, TODAY)).toBeNull();
    expect(offerFor(plan([], { hard: true }), [], toolkit, TODAY)).toBeNull();
    // A ⛔ dish is never the offer: with parippu blocked there is nothing to offer.
    expect(offerFor(plan([]), [COCONUT], toolkit, TODAY)).toBeNull();
    // Can't verify is never safe.
    expect(offerFor(plan([]), null, toolkit, TODAY)).toBeNull();
    const yes = acceptSlot(pinned, offer!, 3, TODAY);
    expect(yes.slot).toBe('accepted');
    expect(yes.offer).toBeUndefined(); // answered: the pin goes
    expect(yes.items).toEqual(expect.arrayContaining([{ day: 3, kind: 'dish', slug: PARIPPU, servings: 3 }, { day: 2, kind: 'lesson', slug: PARIPPU }]));
  });
});

describe('M9: the practice day is never a day already gone', () => {
  const toolkit: ToolkitState = { techniques: { legumes: { tier: 'tried', firstAt: '2026-11-01', lastUsedAt: '2026-11-01', recipes: [] }, 'heat-control': { tier: 'seen', firstAt: '2026-11-01', lastUsedAt: '2026-11-01', recipes: [] } } };
  test('the offer goes from tomorrow, its practice today at the earliest; a dish planned today practises today', () => {
    const offer = offerFor(plan([]), [], toolkit, TODAY)!;
    // Wednesday the 11th is day 2: the dish from Thursday (day 3), its practice on Wednesday.
    expect(slotDay(plan([]), offer, TODAY)).toBe(3);
    expect(practiceDay(plan([]), 3, TODAY)).toBe(2);
    // The offer's dish already planned today: the practice is today too, never Tuesday.
    expect(acceptSlot(plan([dish(2, PARIPPU)]), offer, 2, TODAY).items).toContainEqual({ day: 2, kind: 'lesson', slug: PARIPPU });
    // A week that hasn't started: the day before is fine.
    expect(practiceDay({ weekStart: '2026-11-16' }, 1, TODAY)).toBe(0);
  });
});

describe('device week (local-week.ts)', () => {
  test('a plan with a ⛔ item is never saved; an ok one is, and its previous comes back', () => {
    const s = store({ localRules: [COCONUT] });
    const w = createWeekStore({ store: s });
    expect(w.savePlan(plan([dish(0, PARIPPU)]))).toMatchObject({ ok: false });
    expect(s.get().localWeek.plans).toEqual([]);
    expect(w.savePlan(plan([dish(1, ONIGIRI)]))).toEqual({ ok: true, previous: null });
    expect(w.savePlan(plan([dish(2, ONIGIRI)]))).toEqual({ ok: true, previous: plan([dish(1, ONIGIRI)]) });
  });

  test('market: ticked → local pantry item with addedOn today and source market; untick removes that id only', () => {
    const s = store();
    const w = createWeekStore({ store: s });
    w.savePlan(plan([dish(0, PARIPPU)]));
    const run = w.run(MON, TODAY)!;
    const row = run.items.find((i) => i.ingredientId === 'green_chili') ?? run.items[0];
    // A same-name row already there, told to the Pan: an untick must never touch it.
    s.update((x) => ({ ...x, localPantry: [{ id: 'told-1', name: 'salt', ingredientId: 'salt' }] }));
    const after = w.tick(MON, row.key, true, TODAY)!;
    expect(after.items.find((i) => i.key === row.key)!.ticked).toBe(true);
    const added = s.get().localPantry.find((p) => p.name === row.name && p.id !== 'told-1')!;
    expect(added).toMatchObject({ name: row.name, ingredientId: row.ingredientId, addedOn: TODAY, source: 'market' });
    w.tick(MON, row.key, false, TODAY);
    expect(s.get().localPantry.map((p) => p.id)).toEqual(['told-1']);
    // Finishing once; a second finish changes nothing, and a done run takes no ticks.
    expect(w.finish(MON, NOW)!.finished).toBe(true);
    expect(w.finish(MON, NOW)!.finished).toBe(false);
    expect(w.tick(MON, row.key, true, TODAY)).toBeNull();
  });

  test('a ⛔ dish adds nothing to the list; rows carry ❓ and swappedFor as core marks them', () => {
    const s = store({ localRules: [] });
    const w = createWeekStore({ store: s });
    w.savePlan(plan([dish(0, PARIPPU)]));
    s.update((x) => ({ ...x, localRules: [COCONUT] }));
    // The rule came after the save: parippu is ⛔ now, so its rows leave the list.
    expect(w.run(MON, TODAY)!.items).toEqual([]);
  });
});

describe('market list', () => {
  test('each stall section is headed by its stallNames entry; general has a name', () => {
    const items = [
      { key: 'a', name: 'onion', ingredientId: 'onion', stall: 'wen' as const, forDishes: [PARIPPU], ticked: false },
      { key: 'b', name: 'pappadam', ingredientId: null, stall: 'general' as const, forDishes: [PARIPPU], ticked: false, unverified: true as const },
      { key: 'c', name: 'neutral oil', ingredientId: 'neutral_oil', stall: 'general' as const, forDishes: [PARIPPU], swappedFor: [PARIPPU], ticked: false },
    ];
    const sections = byStall(items);
    expect(sections.map((x) => x.stall)).toEqual(['wen', 'general']);
    expect(sections[0].name).toBe(content.stallNames.wen);
    expect(content.stallNames.general).toMatch(/\S/);
    expect(sections[1].name).toBe(content.stallNames.general);
    expect(forText(items[2])).toBe('for Parippu Curry, swapped');
  });

  test('the screen: a box per row with its ❓ badge; ticking writes the pantry; the stall headings are named', async () => {
    const s = store();
    createWeekStore({ store: s }).savePlan(plan([dish(0, PARIPPU)]));
    const el = document.createElement('div');
    document.body.append(el);
    await marketScreen(noClient).mount(el, { name: 'market' }, appCtx(s));
    await flush();
    const heads = [...el.querySelectorAll('.market-stall h2')].map((x) => x.textContent);
    expect(heads.length).toBeGreaterThan(0);
    for (const hd of heads) expect(Object.values(content.stallNames)).toContain(hd);
    const box = el.querySelector<HTMLInputElement>('.market-tick')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await flush();
    expect(s.get().localPantry.some((p) => p.source === 'market' && p.addedOn === TODAY)).toBe(true);
    expect(el.querySelector('.market-done')).not.toBeNull();
    el.remove();
  });
});

describe('Family Table (C31)', () => {
  test('plan and market screens render with no save, tick, finish or rescue control; nothing written to the store', async () => {
    const s = store();
    createWeekStore({ store: s }).savePlan(plan([dish(0, PARIPPU)]));
    s.update((x) => ({ ...x, settings: { ...x.settings, familyTable: true } }));
    let writes = 0;
    s.subscribe(() => { writes++; });
    const p = document.createElement('div');
    await planScreen(noClient).mount(p, { name: 'plan' }, appCtx(s));
    await flush();
    expect(p.querySelector('.plan-item')).not.toBeNull();
    expect(p.querySelector('.plan-save, .plan-remove, .plan-add, .plan-cook, #plan-hard, .plan-slot button')).toBeNull();
    const m = document.createElement('div');
    await marketScreen(noClient).mount(m, { name: 'market' }, appCtx(s));
    await flush();
    expect(m.querySelector('.market-row')).not.toBeNull();
    expect(m.querySelector('input, .market-done')).toBeNull();
    // The week source refuses every write without a call.
    const src = createWeekSource({ store: s, client: noClient });
    expect(await src.save(plan([]), TODAY)).toMatchObject({ ok: false, kind: 'family_table' });
    expect(await src.openRun(MON, TODAY)).toMatchObject({ ok: false, kind: 'family_table' });
    // No rescue in Family Table mode.
    expect(rescueOffer(s.get(), [], null, TODAY, content.frames, content.keeps, { recipes: canonRecipes(), graph, rules: [], subs: [] })).toBeNull();
    expect(writes).toBe(0);
    expect(s.get().localWeek.runs).toEqual([]);
  });
});

describe('Use-It-Up Rescue', () => {
  const bought = (name: string, ingredientId: string, addedOn: string, id = name): PantryItem & { id: string } => ({ id, name, ingredientId, addedOn, source: 'market' });
  const told = (name: string, ingredientId: string): PantryItem & { id: string } => ({ id: name, name, ingredientId });
  // Spinach keeps 3 days: bought two days ago it has one left.
  const pantry = [bought('spinach', 'spinach', '2026-11-09'), told('cooked rice', 'cooked_rice'), told('coconut oil', 'coconut_oil')];
  const uses = (rules: Rule[]) => ({ recipes: canonRecipes(), graph, rules, subs: [...content.substitutions] });

  test('one a day; off in settings → none; compost removes the item and shows rescue.compost; subs reach fillFrame (a swap filler is offered with 🔁)', async () => {
    const s = store({ localPantry: pantry });
    const offer = rescueOffer(s.get(), pantry, null, TODAY, content.frames, content.keeps, uses([COCONUT]))!;
    expect(offer.item.id).toBe('spinach');
    expect(offer.frame.id).toBe('fried-rice');
    // The rescued item is in the dish, and the coconut oil is the rules engine's labelled swap (🔁), never ⛔.
    expect(Object.values(offer.filled.fills).some((f) => f?.name === 'spinach')).toBe(true);
    expect(offer.filled.check.status).toBe('swap');
    noteNudge(s, offer, TODAY);
    // The same nudge again until it is answered; then nothing more today.
    expect(rescueOffer(s.get(), pantry, null, TODAY, content.frames, content.keeps, uses([COCONUT]))!.item.id).toBe('spinach');
    answerNudge(s, offer, TODAY);
    expect(rescueOffer(s.get(), pantry, null, TODAY, content.frames, content.keeps, uses([COCONUT]))).toBeNull();
    // Tomorrow is a new day (spinach still has a day left then).
    expect(rescueOffer(s.get(), pantry, null, '2026-11-12', content.frames, content.keeps, uses([COCONUT]))).not.toBeNull();
    // Off in settings: none.
    s.update((x) => ({ ...x, settings: { ...x.settings, rescueNudges: false } }));
    expect(rescueOffer(s.get(), pantry, null, '2026-11-12', content.frames, content.keeps, uses([]))).toBeNull();
    // Compost removes that row by id, and the line is the warm one.
    expect(await compost(s, noClient, offer.item)).toBe(true);
    expect(s.get().localPantry.map((p) => p.id)).toEqual(['cooked rice', 'coconut oil']);
    expect(writtenLine('rescue.compost', { item: 'spinach' })).toMatch(/compost/i);
  });

  test('never an item past its keep time, never one the rules block, never a told item', () => {
    const s = store();
    // Spinach bought five days ago is past its three-day keep time.
    expect(rescueOffer(s.get(), [bought('spinach', 'spinach', '2026-11-06'), told('cooked rice', 'cooked_rice')], null, TODAY, content.frames, content.keeps, uses([]))).toBeNull();
    const spinachRule: Rule = { id: 'r-sp', target: { kind: 'ingredient', ids: ['spinach'] }, type: 'avoid', severity: 'allergy' };
    expect(rescueOffer(s.get(), pantry, null, TODAY, content.frames, content.keeps, uses([spinachRule]))).toBeNull();
    expect(rescueOffer(s.get(), [told('spinach', 'spinach')], null, TODAY, content.frames, content.keeps, uses([]))).toBeNull();
  });

  test('M5 final m11: the nudge memory is per partition: A answered, B signs in and is nudged, A back the same day → no second nudge', () => {
    const s = store({ localPantry: pantry });
    const A = { email: 'a@example.com' }, B = { email: 'b@example.com' };
    const offerNow = () => rescueOffer(s.get(), pantry, null, TODAY, content.frames, content.keeps, uses([COCONUT]));
    s.update((x) => ({ ...x, account: A }));
    const a = offerNow()!;
    noteNudge(s, a, TODAY);
    answerNudge(s, a, TODAY); // "Not now"
    expect(offerNow()).toBeNull();
    s.update((x) => ({ ...x, account: B }));
    const b = offerNow()!;
    expect(b).not.toBeNull(); // B's own day: one nudge for B
    noteNudge(s, b, TODAY);
    s.update((x) => ({ ...x, account: A }));
    expect(offerNow()).toBeNull(); // A already had today's one
    // Another day starts afresh, and yesterday's records are pruned on the next write.
    expect(rescueOffer(s.get(), pantry, null, '2026-11-12', content.frames, content.keeps, uses([COCONUT]))).not.toBeNull();
    noteNudge(s, rescueOffer(s.get(), pantry, null, '2026-11-12', content.frames, content.keeps, uses([COCONUT]))!, '2026-11-12');
    expect(Object.values(s.get().rescue).every((r) => r.on === '2026-11-12')).toBe(true);
  });

  test('a ❓ frame is offered (rescue.unverified); a ⛔ one never is', () => {
    const s = store();
    // No rice: the frame's required rice slot stays empty, so the filled frame is ❓, never a guess.
    const offer = rescueOffer(s.get(), [bought('spinach', 'spinach', '2026-11-09')], null, TODAY, content.frames, content.keeps, uses([]))!;
    expect(offer.filled.check.status).toBe('unverified');
    expect(offer.filled.emptyRequired).toContain('rice');
  });
});

describe('plan screen (signed out)', () => {
  test('Plan it saves to the device; the planContext checks each item on its date', async () => {
    const s = store();
    const el = document.createElement('div');
    document.body.append(el);
    await planScreen(noClient).mount(el, { name: 'plan' }, appCtx(s));
    await flush();
    const select = el.querySelector<HTMLSelectElement>('#plan-add-0')!;
    select.value = PARIPPU;
    el.querySelector<HTMLButtonElement>('#plan-add-btn-0')!.click();
    el.querySelector<HTMLButtonElement>('.plan-save')!.click();
    await flush();
    expect(s.get().localWeek.plans).toEqual([plan([{ day: 0, kind: 'dish', slug: PARIPPU, servings: 3 }])]);
    expect(planContextFor(MON, []).weekStart).toBe(MON);
    el.remove();
  });

  test('a ⛔ dish is refused with plan.blocked_dish, never added', async () => {
    const s = store({ localRules: [COCONUT] });
    const el = document.createElement('div');
    await planScreen(noClient).mount(el, { name: 'plan' }, appCtx(s));
    await flush();
    el.querySelector<HTMLSelectElement>('#plan-add-0')!.value = PARIPPU;
    el.querySelector<HTMLButtonElement>('#plan-add-btn-0')!.click();
    expect(el.querySelector('.plan-item')).toBeNull();
    expect(el.querySelector('.week-note')!.textContent).toMatch(/rules|blocked|clashes|Not that one/);
  });
});

describe('Ruling 5: a save blocked by a dish that is ⛔ now', () => {
  test('the plan screen names the dish with plan.blocked_dish, never "try again"', async () => {
    const s = store();
    createWeekStore({ store: s }).savePlan(plan([dish(6, PARIPPU)]));
    s.update((x) => ({ ...x, localRules: [COCONUT] }));
    const el = document.createElement('div');
    document.body.append(el);
    await planScreen(noClient).mount(el, { name: 'plan' }, appCtx(s));
    await flush();
    el.querySelector<HTMLSelectElement>('#plan-add-1')!.value = ONIGIRI;
    el.querySelector<HTMLButtonElement>('#plan-add-btn-1')!.click();
    el.querySelector<HTMLButtonElement>('.plan-save')!.click();
    await flush();
    const note = el.querySelector('.week-note')!.textContent;
    expect(note).toContain('Parippu Curry');
    expect(note).toMatch(/coconut/);
    expect(note).not.toMatch(/try again/i);
    el.remove();
  });
});

describe('Ruling 2: "Move this week to your account?"', () => {
  type Call = { name: string; args: unknown[] };
  function fake(over: Record<string, (...a: unknown[]) => unknown> = {}) {
    const calls: Call[] = [];
    const run = { id: 'run1', weekStart: MON, items: [{ key: 'green_chili', name: 'green chillies', ingredientId: 'green_chili', stall: 'wen', forDishes: [PARIPPU], ticked: false }], doneAt: null };
    const base: Record<string, (...a: unknown[]) => unknown> = {
      getPlan: () => ({ ok: true, status: 200, data: { plan: null, weekStart: MON, checks: [] } }),
      putPlan: (p) => ({ ok: true, status: 200, data: { plan: { ...(p as object), id: 'row' }, checks: [] } }),
      openRun: () => ({ ok: true, status: 200, data: run }),
      tick: (_id, key) => ({ ok: true, status: 200, data: { ...run, items: run.items.map((i) => (i.key === key ? { ...i, ticked: true } : i)) } }),
      finishRun: () => ({ ok: true, status: 200, data: { ...run, doneAt: '2026-11-11T12:00:00Z' } }),
      ...over,
    };
    const client = new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => { calls.push({ name, args }); return Promise.resolve(base[name]?.(...args)); } }) as ApiClient;
    return { client, calls };
  }
  /** A week planned and half-shopped signed out, then a sign-in. */
  function signedInWithDeviceWeek() {
    const s = store();
    const w = createWeekStore({ store: s });
    w.savePlan(plan([dish(6, PARIPPU)]));
    const r = w.run(MON, TODAY)!;
    w.tick(MON, r.items.find((i) => i.ingredientId === 'green_chili')!.key, true, TODAY);
    s.update((x) => ({ ...x, account: { email: 'cook@example.com' }, accountRules: [] }));
    return s;
  }

  test('only on a tap: PUT the week with today, replay the ticks, then the week leaves the device (moved, not copied)', async () => {
    const s = signedInWithDeviceWeek();
    const { client, calls } = fake();
    expect(moveCandidates(s.get(), MON).plans).toHaveLength(1);
    expect((await moveWeek(s, client, TODAY)).kind).toBe('moved');
    expect(calls.map((c) => c.name)).toEqual(['getPlan', 'putPlan', 'openRun', 'tick']);
    expect(calls[1].args).toEqual([plan([dish(6, PARIPPU)]), TODAY]);
    expect(calls[3].args).toEqual(['run1', 'green_chili', true, TODAY]);
    expect(s.get().localWeek).toEqual({ plans: [], runs: [] });
  });

  test('N1: only what landed leaves the device; a dish on a date outside the account\'s week stays (probe: onigiri Tue 17th)', async () => {
    const s = store({ localProfile: { marketDays: [6], mealsPerWeek: null, country: null, region: null, mealWindows: [] } });
    // A guest with Saturday market days plans next week (Sat 14th): parippu on Sat, onigiri on Tue 17th.
    createWeekStore({ store: s }).savePlan(plan([dish(0, PARIPPU), dish(3, ONIGIRI)], { weekStart: '2026-11-14' }));
    s.update((x) => ({ ...x, account: { email: 'cook@example.com' }, accountRules: [] }));
    const { client, calls } = fake();
    expect((await moveWeek(s, client, TODAY)).kind).toBe('moved');
    // The account week is Mon 9th–Sun 15th: Saturday the 14th is its day 5.
    expect(calls[1].args[0]).toEqual(plan([dish(5, PARIPPU)]));
    expect(s.get().localWeek.plans).toEqual([plan([dish(3, ONIGIRI)], { weekStart: '2026-11-14' })]);
  });

  test('N1: what stays on the device is kept for PLAN_RETENTION_WEEKS like any device week', () => {
    const old = plan([dish(1, ONIGIRI)], { weekStart: '2026-08-03' });
    const w = afterMove({ plans: [old, plan([dish(6, PARIPPU)])], runs: [] }, [plan([dish(6, PARIPPU)])], MON, new Set(), TODAY);
    expect(w.plans).toEqual([]); // the moved week went, and the long-ended one with it
  });

  test('N2: a dish the account\'s rules refuse is named with plan.blocked_dish and stays on the device; the rest moves', async () => {
    const s = store();
    createWeekStore({ store: s }).savePlan(plan([dish(6, PARIPPU), dish(0, ONIGIRI)]));
    s.update((x) => ({ ...x, account: { email: 'cook@example.com' }, accountRules: [COCONUT] }));
    let puts = 0;
    const { client, calls } = fake({
      putPlan: (p) => (puts++ === 0
        ? { ok: false, status: 400, error: { code: 'plan_invalid', message: '', details: { problems: [`blocked: ${PARIPPU}`] } } }
        : { ok: true, status: 200, data: { plan: { ...(p as object), id: 'row' }, checks: [] } }),
    });
    const r = await moveWeek(s, client, TODAY);
    expect(r.kind).toBe('moved');
    expect(r.lines.map((l) => l.trigger)).toEqual(['plan.blocked_dish']);
    expect(writtenLine(r.lines[0].trigger, r.lines[0].vars)).toContain('Parippu Curry');
    expect(calls.filter((c) => c.name === 'putPlan').at(-1)!.args[0]).toEqual(plan([dish(0, ONIGIRI)]));
    expect(s.get().localWeek.plans).toEqual([plan([dish(6, PARIPPU)])]);
  });

  test('N2: the plan landed but a tick failed: week.move_partial, and the device keeps everything for the next tap', async () => {
    const s = signedInWithDeviceWeek();
    const { client } = fake({ tick: () => ({ ok: false, status: 0, error: { code: 'network', message: '' } }) });
    const r = await moveWeek(s, client, TODAY);
    expect(r).toEqual({ kind: 'partial', lines: [{ trigger: 'week.move_partial', vars: {} }] });
    expect(s.get().localWeek.plans).toHaveLength(1);
    expect(s.get().localWeek.runs).toHaveLength(1);
  });

  test('N3: an account change at openRun, at a tick, or at the finish moves nothing more and keeps the device week', async () => {
    const swap = (s: PlayerStore) => { s.update((x) => ({ ...x, account: { email: 'other@example.com' } })); };
    // openRun
    let s = signedInWithDeviceWeek();
    let f = fake({ openRun: () => { swap(s); return { ok: true, status: 200, data: { id: 'run1', weekStart: MON, items: [{ key: 'green_chili', ticked: false, forDishes: [PARIPPU] }], doneAt: null } }; } });
    expect((await moveWeek(s, f.client, TODAY)).kind).toBe('failed');
    expect(f.calls.map((c) => c.name)).not.toContain('tick');
    expect(s.get().localWeek.plans).toHaveLength(1);
    // a tick (with a finished device run, so a finish would follow)
    s = signedInWithDeviceWeek();
    s.update((x) => ({ ...x, localWeek: { ...x.localWeek, runs: x.localWeek.runs.map((r) => ({ ...r, doneAt: '2026-11-11T10:00:00Z' })) } }));
    f = fake({ tick: () => { swap(s); return { ok: true, status: 200, data: { id: 'run1', weekStart: MON, items: [], doneAt: null } }; } });
    expect((await moveWeek(s, f.client, TODAY)).kind).toBe('failed');
    expect(f.calls.map((c) => c.name)).not.toContain('finishRun');
    expect(s.get().localWeek.plans).toHaveLength(1);
    // the finish: the last write lands, then the account changes; the device week is not touched for the new one
    s = signedInWithDeviceWeek();
    s.update((x) => ({ ...x, localWeek: { ...x.localWeek, runs: x.localWeek.runs.map((r) => ({ ...r, doneAt: '2026-11-11T10:00:00Z' })) } }));
    f = fake({ finishRun: () => { swap(s); return { ok: true, status: 200, data: { id: 'run1', weekStart: MON, items: [], doneAt: 'x' } }; } });
    await moveWeek(s, f.client, TODAY);
    expect(s.get().localWeek.plans).toHaveLength(1);
  });

  test('N3: a retry is idempotent: a row the account already ticked is not ticked again; a finished account run is not finished again', async () => {
    const s = signedInWithDeviceWeek();
    s.update((x) => ({ ...x, localWeek: { ...x.localWeek, runs: x.localWeek.runs.map((r) => ({ ...r, doneAt: '2026-11-11T10:00:00Z' })) } }));
    const { client, calls } = fake({ openRun: () => ({ ok: true, status: 200, data: { id: 'run1', weekStart: MON, items: [{ key: 'green_chili', ticked: true, forDishes: [PARIPPU] }], doneAt: '2026-11-11T11:00:00Z' } }) });
    expect((await moveWeek(s, client, TODAY)).kind).toBe('moved');
    expect(calls.map((c) => c.name)).toEqual(['getPlan', 'putPlan', 'openRun']);
  });

  test('N3: a row the account already ticked (run still open) is not ticked again', async () => {
    const s = signedInWithDeviceWeek();
    const { client, calls } = fake({ openRun: () => ({ ok: true, status: 200, data: { id: 'run1', weekStart: MON, items: [{ key: 'green_chili', ticked: true, forDishes: [PARIPPU] }], doneAt: null } }) });
    expect((await moveWeek(s, client, TODAY)).kind).toBe('moved');
    expect(calls.map((c) => c.name)).not.toContain('tick');
  });

  test('N3: "Move it" without health_data hands the consent card a retry that moves the week', async () => {
    const s = signedInWithDeviceWeek();
    let consented = false;
    const { client, calls } = fake({
      putPlan: (p) => (consented ? { ok: true, status: 200, data: { plan: p, checks: [] } } : { ok: false, status: 403, error: { code: 'consent_required', message: '', details: { purpose: 'health_data' } } }),
    });
    let retry: (() => void) | null = null;
    const el = moveOffer({ store: s, client, weekStart: MON, today: TODAY, onMoved: () => undefined, onConsent: (r) => { retry = r; } })!;
    el.querySelector<HTMLButtonElement>('.week-move')!.click();
    await flush();
    expect(retry).not.toBeNull();
    expect(s.get().localWeek.plans).toHaveLength(1);
    consented = true;
    retry!();
    await flush();
    expect(calls.filter((c) => c.name === 'putPlan')).toHaveLength(2);
    expect(s.get().localWeek.plans).toEqual([]);
  });

  test('N3: the offer itself calls nothing; a consent grant runs the move again, a decline doesn\'t', async () => {
    const s = signedInWithDeviceWeek();
    const { client, calls } = fake();
    const el = moveOffer({ store: s, client, weekStart: MON, today: TODAY, onMoved: () => undefined, onConsent: () => undefined });
    expect(el).not.toBeNull();
    await flush();
    expect(calls).toEqual([]);
    let runs = 0;
    const answer = grantedOnly(() => { runs++; });
    answer('declined');
    answer('unavailable');
    expect(runs).toBe(0);
    answer('granted');
    expect(runs).toBe(1);
  });

  test('without health_data: the consent path, and the week stays on the device', async () => {
    const s = signedInWithDeviceWeek();
    const { client, calls } = fake({ putPlan: () => ({ ok: false, status: 403, error: { code: 'consent_required', message: '', details: { purpose: 'health_data' } } }) });
    expect((await moveWeek(s, client, TODAY)).kind).toBe('consent');
    expect(calls.map((c) => c.name)).toEqual(['getPlan', 'putPlan']);
    expect(s.get().localWeek.plans).toHaveLength(1);
  });

  test('the account\'s own week is kept: the device items are added on the same dates', () => {
    const account = plan([dish(1, ONIGIRI)]);
    // A device week that starts on Sunday the 8th: its day 1 (Monday the 9th) is the account week's day 0.
    const merged = mergedWeek(account, MON, [plan([dish(1, PARIPPU), dish(0, PARIPPU)], { weekStart: '2026-11-08' })]);
    expect(merged.items).toEqual([dish(1, ONIGIRI), dish(0, PARIPPU)]);
  });

  test('signed out, in Family Table mode, or nothing on the device: no offer and no call', async () => {
    const { client, calls } = fake();
    const out = store();
    expect((await moveWeek(out, client, TODAY)).kind).toBe('nothing');
    const ft = signedInWithDeviceWeek();
    ft.update((x) => ({ ...x, settings: { ...x.settings, familyTable: true } }));
    expect((await moveWeek(ft, client, TODAY)).kind).toBe('nothing');
    expect(moveOffer({ store: ft, client, weekStart: MON, today: TODAY, onMoved: () => undefined, onConsent: () => undefined })).toBeNull();
    expect(calls).toEqual([]);
  });

  test('an account change while the move is on its way leaves the device week where it is (partitions)', async () => {
    const s = signedInWithDeviceWeek();
    const { client, calls } = fake({ putPlan: (p) => { s.update((x) => ({ ...x, account: { email: 'other@example.com' } })); return { ok: true, status: 200, data: { plan: p, checks: [] } }; } });
    expect((await moveWeek(s, client, TODAY)).kind).toBe('failed');
    expect(calls.map((c) => c.name)).toEqual(['getPlan', 'putPlan']); // no run is opened or ticked under the other account
    expect(s.get().localWeek.plans).toHaveLength(1);
  });
});

describe('I5: guards pinned', () => {
  const bought = (name: string, ingredientId: string, addedOn: string, id = name): PantryItem & { id: string } => ({ id, name, ingredientId, addedOn, source: 'market' });
  const told = (name: string, ingredientId: string, id = name): PantryItem & { id: string } => ({ id, name, ingredientId });
  const uses = (rules: Rule[]) => ({ recipes: canonRecipes(), graph, rules, subs: [...content.substitutions] });
  const pantry = [bought('spinach', 'spinach', '2026-11-09'), told('cooked rice', 'cooked_rice'), told('sunflower oil', 'neutral_oil')];

  test('a rescue whose filled frame leaves the rescued item out is never offered (Step 3 carry)', () => {
    // A frame that says it rescues spinach but has no slot spinach fits: picking it fills the slot with the onion instead.
    const frame = { ...content.frames.find((f) => f.id === 'fried-rice')!, id: 'odd', rescues: ['spinach'], slots: [{ key: 'veg', accepts: ['onion'], optional: false }], steps: ['Fry {veg}.'] };
    const s = store();
    expect(rescueOffer(s.get(), [...pantry, told('onion', 'onion')], null, TODAY, [frame], content.keeps, uses([]))).toBeNull();
  });

  test('Family Table: no rescue even with a rescuable pantry; compost writes nothing; a tick is refused without a call', async () => {
    const s = store({ localPantry: pantry });
    s.update((x) => ({ ...x, settings: { ...x.settings, familyTable: true } }));
    expect(rescueOffer(s.get(), pantry, null, TODAY, content.frames, content.keeps, uses([]))).toBeNull();
    expect(rescueOffer({ ...s.get(), settings: { ...s.get().settings, familyTable: false } }, pantry, null, TODAY, content.frames, content.keeps, uses([]))).not.toBeNull();
    expect(await compost(s, noClient, pantry[0])).toBe(false);
    expect(s.get().localPantry).toHaveLength(3);
    const run = { id: 'r', weekStart: MON, items: [], doneAt: null };
    expect(await createWeekSource({ store: s, client: noClient }).tick(run, 'k', true, TODAY)).toMatchObject({ ok: false, kind: 'family_table' });
    expect(await createWeekSource({ store: s, client: noClient }).finish(run, TODAY, NOW)).toMatchObject({ ok: false, kind: 'family_table' });
  });

  test('rules unreadable: nothing saved on the device, and the kitchen offers no rescue (and fetches nothing)', async () => {
    const s = store({ rulesUnreadable: true, localPantry: pantry });
    expect(createWeekStore({ store: s }).savePlan(plan([dish(1, ONIGIRI)]))).toMatchObject({ ok: false });
    expect(s.get().localWeek.plans).toEqual([]);
    const slot = document.createElement('div');
    await mountRescue(slot, appCtx(s), noClient, () => true);
    expect(slot.childElementCount).toBe(0);
    // With the rules readable the same pantry is offered (the guard is what stopped it).
    const ok = store({ localPantry: pantry });
    await mountRescue(slot, appCtx(ok), noClient, () => true);
    expect(slot.querySelector('.rescue')).not.toBeNull();
  });

  test('an untick removes only the row its tick added, never a same-name item already there', () => {
    const s = store();
    const w = createWeekStore({ store: s });
    w.savePlan(plan([dish(0, PARIPPU)]));
    const row = w.run(MON, TODAY)!.items.find((i) => i.ingredientId === 'green_chili')!;
    w.tick(MON, row.key, true, TODAY);
    // The same item, told to the Pan meanwhile: an untick must leave it.
    s.update((x) => ({ ...x, localPantry: [...x.localPantry, told(row.name, row.ingredientId!, 'told-same')] }));
    w.tick(MON, row.key, false, TODAY);
    expect(s.get().localPantry.map((p) => p.id)).toEqual(['told-same']);
  });

  test('the market screen draws each ❓ row with its ❓ badge and each swap with 🔁; a plain row has neither', async () => {
    const s = store();
    // A shellfish rule makes onigiri's katsuobushi a labelled swap; nori and umeboshi are check-the-label lines.
    s.update((x) => ({ ...x, localRules: [{ id: 'f', target: { kind: 'category', ids: ['fish'] }, type: 'avoid', severity: 'allergy' }] }));
    createWeekStore({ store: s }).savePlan(plan([dish(1, ONIGIRI), dish(0, PARIPPU)]));
    const run = createWeekStore({ store: s }).run(MON, TODAY)!;
    const el = document.createElement('div');
    await marketScreen(noClient).mount(el, { name: 'market' }, appCtx(s));
    await flush();
    let badges = 0;
    for (const item of run.items) {
      const li = el.querySelector(`.market-row[data-key="${CSS.escape(item.key)}"]`)!;
      const chip = li.querySelector('.chip')?.getAttribute('data-status') ?? null;
      expect(chip, item.name).toBe(item.unverified ? 'unverified' : item.swappedFor ? 'swap' : null);
      if (chip !== null) badges++;
    }
    expect(badges).toBeGreaterThan(0);
  });

  test('M6: Remove hands focus to that day\'s heading, never the page', async () => {
    const s = store();
    createWeekStore({ store: s }).savePlan(plan([dish(3, ONIGIRI)]));
    const el = document.createElement('div');
    document.body.append(el);
    await planScreen(noClient).mount(el, { name: 'plan' }, appCtx(s));
    await flush();
    const remove = el.querySelector<HTMLButtonElement>('.plan-remove')!;
    remove.focus();
    remove.click();
    expect(document.activeElement?.id).toBe('plan-day-3');
    el.remove();
  });
});

describe('N4: the week screens remember a week only for the account they read it for', () => {
  test('an account switch while Plan it is on its way remembers nothing for the new account', async () => {
    forgetWeek();
    const s = store({ account: { email: 'a@example.com' }, accountRules: [] });
    const client = {
      getPlan: () => Promise.resolve({ ok: true, status: 200, data: { plan: null, weekStart: MON, checks: [] } }),
      putPlan: (p: unknown) => { s.update((x) => ({ ...x, account: { email: 'b@example.com' }, accountRules: [] })); return Promise.resolve({ ok: true, status: 200, data: { plan: p, checks: [] } }); },
    } as unknown as ApiClient;
    const el = document.createElement('div');
    document.body.append(el);
    await planScreen(client).mount(el, { name: 'plan' }, appCtx(s));
    await flush();
    el.querySelector<HTMLSelectElement>('#plan-add-1')!.value = ONIGIRI;
    el.querySelector<HTMLButtonElement>('#plan-add-btn-1')!.click();
    el.querySelector<HTMLButtonElement>('.plan-save')!.click();
    await flush();
    expect(rememberedWeek('b@example.com')).toBeNull();
    expect(plannedOn(ONIGIRI, '2026-11-10', 'b@example.com')).toBe(false);
    el.remove();
  });
});

describe('M5 final I3: the device save prunes on today, not on the saved week', () => {
  test('saving a past week through the source still drops a week that ended more than 8 weeks before today', async () => {
    const s = store({ localWeek: { plans: [plan([dish(0, ONIGIRI)], { weekStart: '2026-09-07' })], runs: [] } });
    const src = createWeekSource({ store: s, client: noClient, today: () => TODAY });
    expect(await src.save(plan([dish(0, PARIPPU)], { weekStart: '2026-09-14' }), TODAY)).toMatchObject({ ok: true });
    expect(s.get().localWeek.plans.map((p) => p.weekStart)).toEqual(['2026-09-14']);
  });
});

describe('M5 final m2: a 429 on a week write says which limit it is', () => {
  const s429 = (details: object) => ({ ok: false as const, status: 429, error: { code: 'rate_limited', message: '', details, retryAfter: 60 } });
  test('the daily write cap is `limited` (write.daily_limit); a per-minute 429 is `network` (try again in a moment)', async () => {
    const s = store({ account: { email: 'cook@example.com' }, accountRules: [] });
    const client = (details: object) => new Proxy({}, { get: (_t, name: string) => () => Promise.resolve(name === 'getPlan' ? s429(details) : s429(details)) }) as ApiClient;
    expect(await createWeekSource({ store: s, client: client({ retryAfterSeconds: 3600, scope: 'day' }) }).current(TODAY)).toMatchObject({ ok: false, kind: 'limited' });
    expect(await createWeekSource({ store: s, client: client({ retryAfterSeconds: 12 }) }).current(TODAY)).toMatchObject({ ok: false, kind: 'network' });
    const shown: string[] = [];
    showFailure({ kind: 'limited' }, { show: (t) => shown.push(t) }, writtenLine);
    expect(content.pan.triggers['write.daily_limit'].lines).toContain(shown[0]);
  });
});
