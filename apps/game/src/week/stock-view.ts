// "Out of stock?" on Form 12-M (M6 Step 10, Ruling 11): one row's stall-swap control. Two taps: "Out of stock?" opens
// the stall keeper's line with one chip per swap core `stockSwaps` offers now (each labelled with the dishes it is
// for) and "Skip it this week"; with no swap, the keeper's `out_of_stock_none` line (or the Pan's `market.no_swap`)
// and "Skip it this week" only. Taking a swap shows `market.stock_swapped`, and an "Undo" puts both rows back. The
// swaps come from core only (the server re-derives every take); this view never invents one. Nothing here in Family
// Table (C31), and nothing for a ticked, ❓, rules-swapped or stall-swap row: core offers none for those.
import { listWords, type ListItem, type StockSwap } from '@kitchenquest/core/engine';
import type { StockAction } from '../api/types';
import { contentText, h } from '../ui/dom';
import { writtenLine } from './plan-view';

export interface StockDeps {
  /** core `stockSwaps(row, plan, ctx)` now, for the player's rules. */
  swaps: StockSwap[];
  /** Runs the change (device or API). `ok: false`: nothing changed; the screen has said why. */
  act(a: StockAction): Promise<{ ok: boolean }>;
  familyTable: boolean;
  /** The row's stall-swap row on the run, when one was taken. */
  swapRow?: ListItem | null;
  /** The keeper's written line (`out_of_stock` / `out_of_stock_none`), rules-checked; null → the Pan's line. */
  keeperLine?: (trigger: 'out_of_stock' | 'out_of_stock_none', vars: Record<string, string>) => string | null;
  /** A dish's display name. */
  dishName?: (slug: string) => string;
  /** Whether the control starts open (the screen keeps it open across a redraw). */
  open?: boolean;
  onOpen?: (open: boolean) => void;
}

const SKIP = 'Skip it this week';
const ASK = 'Out of stock?';
const UNDO = 'Undo';
const SKIPPED = 'Out of stock: skipped this week.';

/** The dishes a swap is for, in words ("Parippu Curry and Frijoles de Olla"). */
const dishesOf = (slugs: readonly string[], name: (slug: string) => string): string => listWords(slugs.map(name));

/** The control for one row, or null when none belongs there (see the file comment). */
export function stockControl(row: ListItem, deps: StockDeps): HTMLElement | null {
  if (deps.familyTable || row.ticked || row.unverified === true || row.swappedFor !== undefined || row.stockSwap !== undefined) return null;
  const name = deps.dishName ?? ((s: string) => s);
  const box = h('div', { class: 'stock-control', 'data-stock-key': row.key });
  let busy = false;
  const run = async (a: StockAction, buttons: HTMLButtonElement[]) => {
    if (busy) return;
    busy = true;
    for (const b of buttons) b.disabled = true;
    try {
      await deps.act(a);
    } finally {
      busy = false;
      if (box.isConnected) for (const b of buttons) b.disabled = false;
    }
  };

  // Marked out of stock: what was done, and the one Undo (both rows back).
  if (row.outOfStock === true) {
    const swap = deps.swapRow ?? null;
    const text = swap === null
      ? SKIPPED
      : writtenLine('market.stock_swapped', { item: row.name, swap: swap.name, dish: dishesOf(row.forDishes, name) });
    const undo = h('button', { type: 'button', class: 'btn btn-secondary stock-undo' }, UNDO);
    undo.setAttribute('aria-label', `Undo: ${row.name}`);
    undo.addEventListener('click', () => { void run({ key: row.key, action: 'undo' }, [undo]); });
    box.append(contentText('p', text, { class: 'stock-said' }), h('div', { class: 'button-row' }, undo));
    return box;
  }

  const ask = h('button', { type: 'button', class: 'btn btn-secondary stock-ask', 'aria-expanded': 'false' }, ASK);
  ask.setAttribute('aria-label', `${ASK} ${row.name}`);
  const panel = h('div', { class: 'stock-offer', role: 'group', 'aria-label': `If the stall is out of ${row.name}` });
  panel.hidden = true;
  const draw = () => {
    const said = deps.swaps.length > 0
      ? (deps.keeperLine?.('out_of_stock', { item: row.name, swap: listWords(deps.swaps.map((s) => s.toName)) }) ?? null)
      : (deps.keeperLine?.('out_of_stock_none', { item: row.name }) ?? writtenLine('market.no_swap', { item: row.name }));
    const chips = deps.swaps.map((sw) => {
      const b = h('button', { type: 'button', class: 'btn btn-secondary stock-swap', 'data-to': sw.toId },
        contentText('span', sw.toName), ' ', h('span', { class: 'stock-for' }, `(for ${dishesOf(sw.dishes, name)})`));
      return { b, sw };
    });
    const skip = h('button', { type: 'button', class: 'btn btn-secondary stock-skip' }, SKIP);
    const all = [...chips.map((c) => c.b), skip];
    for (const { b, sw } of chips) b.addEventListener('click', () => { void run({ key: row.key, action: 'take', toId: sw.toId }, all); });
    skip.addEventListener('click', () => { void run({ key: row.key, action: 'out' }, all); });
    panel.replaceChildren(
      ...(said === null ? [] : [contentText('p', said, { class: 'stock-said' })]),
      ...chips.filter(({ sw }) => sw.note !== '').map(({ sw }) => contentText('p', sw.note, { class: 'stock-note' })),
      h('div', { class: 'button-row' }, ...all));
  };
  const setOpen = (open: boolean) => {
    ask.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open && panel.childElementCount === 0) draw();
  };
  ask.addEventListener('click', () => {
    const open = ask.getAttribute('aria-expanded') !== 'true';
    setOpen(open);
    deps.onOpen?.(open);
    if (open) panel.querySelector<HTMLElement>('button')?.focus();
  });
  if (deps.open === true) setOpen(true);
  box.append(ask, panel);
  return box;
}
