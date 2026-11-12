// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import type { ListItem, ParsedRecipe, Plan, Rule } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import { loadMarket } from '../market/content';
import { marketCtxFor } from '../market/stall-context';
import { canonRecipes } from './context';
import { renderPlanView, writtenLine } from './plan-view';
import { dishSeasonNote, seasonNoteFor } from './season-note';

const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const MON = '2026-11-09';
const plan = (items: Plan['items']): Plan => ({ weekStart: MON, items, hard: false, slot: 'unanswered' });
const dish = (day: number, slug: string, servings = 3) => ({ day, kind: 'dish' as const, slug, servings });
const row = (patch: Partial<ListItem> = {}): ListItem => ({ key: 'shallot', name: 'shallots', ingredientId: 'shallot', stall: 'wen', forDishes: [PARIPPU], ticked: false, ...patch });

describe("The Season's Table (Ruling 10; data/seasonality.yaml)", () => {
  const SEATTLE = { country: 'USA', region: 'Seattle' };
  const ctx = (date: string, rules: Rule[] = [], profile: { country: string | null; region: string | null } = SEATTLE) => marketCtxFor(rules, profile, date, graph, [...content.substitutions])!;

  test('pnw-usa November: cranberry is "in season where you are"; winter squash is stored (its own label); December kale is in season', async () => {
    const table = (await loadMarket()).seasonality;
    const season = { regionId: 'pnw-usa', table };
    const nov = ctx('2026-11-11');
    expect(seasonNoteFor(row({ key: 'cranberry', name: 'cranberries', ingredientId: 'cranberry' }), season, nov)).toBe(writtenLine('season.now', { item: 'cranberries' }));
    expect(writtenLine('season.now', { item: 'x' })).toMatch(/in season where you are/);
    const squash = seasonNoteFor(row({ key: 'winter_squash', name: 'winter squash', ingredientId: 'winter_squash' }), season, nov);
    expect(squash).toBe(writtenLine('season.other', { item: 'winter squash', category: 'Local, stored from the autumn harvest' }));
    expect(squash).not.toMatch(/in season where you are/);
    expect(seasonNoteFor(row({ key: 'kale', name: 'kale', ingredientId: 'kale' }), season, ctx('2026-12-02'))).toBe(writtenLine('season.now', { item: 'kale' }));
  });

  test('no region → no notes; never on a ❓ or out-of-stock row; never for an item the rules hit; never a countdown', async () => {
    const table = (await loadMarket()).seasonality;
    const cran = row({ key: 'cranberry', name: 'cranberries', ingredientId: 'cranberry' });
    expect(seasonNoteFor(cran, { regionId: null, table }, ctx('2026-11-11', [], { country: null, region: null }))).toBeNull();
    const season = { regionId: 'pnw-usa', table };
    expect(seasonNoteFor({ ...cran, unverified: true }, season, ctx('2026-11-11'))).toBeNull();
    expect(seasonNoteFor({ ...cran, outOfStock: true }, season, ctx('2026-11-11'))).toBeNull();
    // Fix round 1 (m3): a rules-swapped row gets none, as the doc comment says.
    expect(seasonNoteFor({ ...cran, swappedFor: [PARIPPU] }, season, ctx('2026-11-11'))).toBeNull();
    const noCran: Rule = { id: 'r-c', target: { kind: 'ingredient', ids: ['cranberry'] }, type: 'avoid', severity: 'preference' };
    expect(seasonNoteFor(cran, season, ctx('2026-11-11', [noCran]))).toBeNull();
    for (const l of [...content.pan.triggers['season.now'].lines, ...content.pan.triggers['season.other'].lines]) {
      expect(l).not.toMatch(/\d+ (days?|weeks?) left|hurry|last chance|running out|ends soon/i);
    }
  });

  test('plan view season note is text only; plan order and the rows are unchanged with it', async () => {
    const table = (await loadMarket()).seasonality;
    const base = canonRecipes().get(PARIPPU)!;
    const withKale: ParsedRecipe = { ...base, ingredients: [...base.ingredients, { ...base.ingredients[0], name: 'kale', quantity: 1, unit: null }] };
    const note = dishSeasonNote(withKale, { regionId: 'pnw-usa', table }, ctx('2026-12-02'));
    expect(note).toBe(writtenLine('season.now', { item: 'kale' }));
    expect(dishSeasonNote(withKale, { regionId: null, table }, ctx('2026-12-02'))).toBeNull();
    const p = plan([dish(2, ONIGIRI), dish(0, PARIPPU), dish(2, PARIPPU)]);
    const rows = p.items.map((item) => ({ item, status: 'ok' as const, findings: [] }));
    const plain = renderPlanView({ weekStart: MON, rows, line: writtenLine });
    const noted = renderPlanView({ weekStart: MON, rows, line: writtenLine, seasonNote: (i) => (i.slug === PARIPPU ? note : null) });
    const order = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.plan-item')].map((x) => `${x.closest('.plan-day')!.getAttribute('data-day')}:${x.dataset.slug}:${x.dataset.status}`);
    expect(order(noted)).toEqual(order(plain));
    const notes = [...noted.querySelectorAll('.season-note')];
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.tagName).toBe('P');
      expect(n.querySelector('.chip, [data-status]')).toBeNull();
      expect(n.getAttribute('class')).toBe('season-note');
    }
    // A ⛔ or ❓ dish never gets one.
    const bad = renderPlanView({ weekStart: MON, rows: rows.map((r, i) => ({ ...r, status: i === 1 ? 'blocked' as const : 'unverified' as const })), line: writtenLine, seasonNote: () => note });
    expect(bad.querySelectorAll('.season-note')).toHaveLength(0);
  });
});

