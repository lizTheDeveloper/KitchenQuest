// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import type { ListItem } from '@kitchenquest/core/engine';
import { writtenLine } from './plan-view';
import { stockControl } from './stock-view';

const PARIPPU = 'india/kerala/parippu';
const row = (patch: Partial<ListItem> = {}): ListItem => ({ key: 'shallot', name: 'shallots', ingredientId: 'shallot', stall: 'wen', forDishes: [PARIPPU], ticked: false, ...patch });

describe('stockControl (Ruling 11)', () => {
  test('no stock control on a ⛔ (never listed), ❓, ticked, rules-swapped or stall-swap row, or in Family Table', () => {
    const deps = { swaps: [], act: () => Promise.resolve({ ok: true }), familyTable: false };
    expect(stockControl(row(), deps)).not.toBeNull();
    expect(stockControl(row({ unverified: true }), deps)).toBeNull();
    expect(stockControl(row({ ticked: true }), deps)).toBeNull();
    expect(stockControl(row({ swappedFor: [PARIPPU] }), deps)).toBeNull();
    expect(stockControl(row({ key: 'stock:onion', stockSwap: { from: 'shallot' } }), deps)).toBeNull();
    expect(stockControl(row(), { ...deps, familyTable: true })).toBeNull();
    // With no swap: the Pan's market.no_swap (no keeper line given) and "Skip it this week" only.
    const box = stockControl(row(), deps)!;
    box.querySelector<HTMLButtonElement>('.stock-ask')!.click();
    expect(box.textContent).toContain(writtenLine('market.no_swap', { item: 'shallots' }));
    expect(box.querySelectorAll('.stock-swap')).toHaveLength(0);
  });

  test('an out-of-stock row shows what was done and one Undo; the swap row names the swap', async () => {
    const acts: unknown[] = [];
    const deps = { swaps: [], act: (a: unknown) => { acts.push(a); return Promise.resolve({ ok: true }); }, familyTable: false };
    const skipped = stockControl(row({ outOfStock: true }), deps)!;
    expect(skipped.textContent).toContain('skipped this week');
    skipped.querySelector<HTMLButtonElement>('.stock-undo')!.click();
    await Promise.resolve();
    expect(acts).toEqual([{ key: 'shallot', action: 'undo' }]);
    const swapped = stockControl(row({ outOfStock: true }), { ...deps, swapRow: row({ key: 'stock:onion', name: 'onion', stockSwap: { from: 'shallot' }, ticked: true }), dishName: () => 'Parippu Curry' })!;
    expect(swapped.textContent).toContain(writtenLine('market.stock_swapped', { item: 'shallots', swap: 'onion', dish: 'Parippu Curry' }));
  });

  test('"Out of stock?" is a disclosure button (aria-expanded), and a chip takes the swap by its id', async () => {
    const acts: unknown[] = [];
    const box = stockControl(row(), { swaps: [{ toId: 'onion', toName: 'onion', note: '', dishes: [PARIPPU] }], act: (a) => { acts.push(a); return Promise.resolve({ ok: true }); }, familyTable: false })!;
    const ask = box.querySelector<HTMLButtonElement>('.stock-ask')!;
    expect(ask.getAttribute('aria-expanded')).toBe('false');
    ask.click();
    expect(ask.getAttribute('aria-expanded')).toBe('true');
    box.querySelector<HTMLButtonElement>('.stock-swap')!.click();
    await Promise.resolve();
    expect(acts).toEqual([{ key: 'shallot', action: 'take', toId: 'onion' }]);
  });
});
