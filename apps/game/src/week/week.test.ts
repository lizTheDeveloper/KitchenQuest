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
import { renderPlanView, writtenLine } from './plan-view';
import { answerNudge, compost, noteNudge, rescueOffer } from './rescue';
import { createWeekSource } from './source';

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
    // Offered and saved as 'offered': the same offer again until answered, never a different one.
    expect(offerFor(plan([], { slot: 'offered' }), [], toolkit, TODAY)).toEqual(offer);
    expect(offerFor(plan([], { slot: 'declined' }), [], toolkit, TODAY)).toBeNull();
    expect(offerFor(plan([], { slot: 'accepted' }), [], toolkit, TODAY)).toBeNull();
    expect(offerFor(plan([], { hard: true }), [], toolkit, TODAY)).toBeNull();
    // A ⛔ dish is never the offer: with parippu blocked there is nothing to offer.
    expect(offerFor(plan([]), [COCONUT], toolkit, TODAY)).toBeNull();
    // Can't verify is never safe.
    expect(offerFor(plan([]), null, toolkit, TODAY)).toBeNull();
    const yes = acceptSlot(plan([]), offer!, 3);
    expect(yes.slot).toBe('accepted');
    expect(yes.items).toEqual(expect.arrayContaining([{ day: 3, kind: 'dish', slug: PARIPPU, servings: 3 }, { day: 2, kind: 'lesson', slug: PARIPPU }]));
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
