// The Pan's check-off card in full (M6 Step 10, C31), Form 12-M: its own lazy chunk (first paint never carries it). It
// lists the matched rows by their list names (code's, never the player's or the model's words) and, for each missing
// row, "Out of stock?", which opens `#/market` at that row's stock control.
//   - A grammar card (the scripted engine's, or the API's code-built one) is applied: its rows show ticked, with one
//     "Undo" that unticks each. No "Tick these" button.
//   - A model-proposed card is pending: "Tick these" and "Not now", and nothing ticks before the tap.
//   - Without health_data consent either card stays pending behind `consent.health_first` until a tap after consent.
import { type CheckOffCard } from '@kitchenquest/core/engine';
import { graph } from '../content';
import type { BureauForm } from '../content/types';
import { localDate } from '../recipes/rules';
import { routeHref } from '../shell/router';
import type { PlayerStore } from '../state/store';
import { contentText, h } from '../ui/dom';
import { knownRun } from '../week/market-swaps';
import { askStock } from '../week/stock-ask';
import { bureauSlip } from './cards-view';
import type { CardView, CheckOffSlot, PanelTrail as Trail } from './reply';

/** `applying`: a grammar card whose ticks are on their way; `undone`: its Undo ran. */
type CheckOffState = Exclude<CheckOffSlot['state'], 'new'>;

const TICK = 'Tick these';
const NOT_NOW = 'Not now';
const UNDO = 'Undo';
const STOCK = 'Out of stock?';
const UNDONE_TEXT = 'Unticked. The list is as it was.';
const APPLYING_TEXT = 'Ticking…';

let seq = 0;

/**
 * A row's name as the run has it; a row no longer on the known run is named from the graph (an ingredient key), or
 * from its own normalised name (a `name:` key). Never anything the player typed.
 */
function rowName(key: string, store: PlayerStore, now: () => Date): string {
  const row = knownRun(store.get(), localDate(now()))?.items.find((i) => i.key === key);
  if (row !== undefined) return row.name;
  if (key.startsWith('name:')) return key.slice(5);
  if (key.startsWith('stock:')) return graph.has(key.slice(6)) ? graph.get(key.slice(6)).name : key.slice(6);
  return graph.has(key) ? graph.get(key).name : key;
}

function renderCheckOffCard(card: CheckOffCard, opts: {
  form: BureauForm; state: CheckOffState; store: PlayerStore; now: () => Date;
  onTick(): void; onNotNow(): void; onUndo(): void;
  /** Navigation is the panel's (a hash change): here only the row to open is handed over. */
  go?: (hash: string) => void;
}): HTMLElement {
  const name = (k: string) => rowName(k, opts.store, opts.now);
  const ticked = opts.state === 'applied';
  const got = card.got.map((k) => h('li', { class: 'checkoff-row', 'data-key': k, 'data-ticked': String(ticked) },
    h('span', { class: 'checkoff-mark', 'aria-hidden': 'true' }, ticked ? '✓ ' : '○ '),
    contentText('span', name(k)),
    // In words, never by the mark alone.
    h('span', { class: 'checkoff-state' }, ticked ? ' (ticked)' : opts.state === 'undone' ? ' (unticked)' : ' (not ticked yet)')));
  const missing = card.missing.map((k) => {
    const ask = h('button', { type: 'button', class: 'btn btn-secondary checkoff-stock' }, STOCK);
    ask.setAttribute('aria-label', `${STOCK} ${name(k)}`);
    ask.addEventListener('click', () => {
      askStock(k);
      const hash = routeHref({ name: 'market' });
      if (opts.go) opts.go(hash);
      else { const win = ask.ownerDocument.defaultView; if (win) win.location.hash = hash; }
    });
    return h('li', { class: 'checkoff-row checkoff-missing', 'data-key': k }, contentText('span', name(k)), h('span', { class: 'checkoff-state' }, ' (they were out)'), ' ', ask);
  });
  const buttons: HTMLElement[] = [];
  if (opts.state === 'pending') {
    const tick = h('button', { type: 'button', class: 'btn btn-primary pan-card-confirm checkoff-tick' }, TICK);
    const no = h('button', { type: 'button', class: 'btn btn-secondary pan-card-reject checkoff-not-now' }, NOT_NOW);
    tick.addEventListener('click', () => { opts.onTick(); });
    no.addEventListener('click', () => { opts.onNotNow(); });
    if (card.got.length > 0) buttons.push(tick);
    buttons.push(no);
  } else if (opts.state === 'applied' && card.got.length > 0) {
    const undo = h('button', { type: 'button', class: 'btn btn-secondary checkoff-undo' }, UNDO);
    undo.addEventListener('click', () => { opts.onUndo(); });
    buttons.push(undo);
  }
  const note = opts.state === 'undone' ? UNDONE_TEXT : opts.state === 'applying' ? APPLYING_TEXT : null;
  const titleId = `pan-checkoff-title-${++seq}`;
  const el = bureauSlip(opts.form, titleId,
    got.length > 0 ? h('ul', { class: 'checkoff-rows', 'aria-label': 'Got' }, ...got) : null,
    missing.length > 0 ? h('ul', { class: 'checkoff-rows', 'aria-label': 'Out of' }, ...missing) : null,
    note === null ? null : h('p', { class: 'pan-card-note', role: 'status' }, note),
    buttons.length > 0 ? h('div', { class: 'bureau-buttons' }, ...buttons) : null);
  el.classList.add('pan-checkoff-card');
  el.dataset.kind = 'check_off';
  el.dataset.state = opts.state;
  el.dataset.source = card.source;
  return el;
}

/**
 * The panel's hook (panel.ts keeps only the slot's state): draws the card for the slot's state into its holder, keeping
 * focus inside the card when it had it (on its first button, else its title, else the panel's text box).
 */
export function drawCheckOff(holder: HTMLElement, view: CardView, slot: CheckOffSlot, deps: {
  forms: Record<string, BureauForm>; store: PlayerStore; now: () => Date; focus(): void;
  tick(): unknown; notNow(): unknown; undo(t: Trail): unknown; go?: (hash: string) => void;
}): void {
  const card = view.card;
  const form = deps.forms.market_list as BureauForm | undefined;
  if (!holder.isConnected || card.kind !== 'check_off' || form === undefined) return;
  // A new card: a local grammar card is ticking now (its confirm intent); any other waits for its tap.
  if (slot.state === 'new') slot.state = view.origin === 'local' && card.source === 'grammar' ? 'applying' : 'pending';
  const hadFocus = holder.contains(holder.ownerDocument.activeElement);
  holder.replaceChildren(renderCheckOffCard(card, {
    form, state: slot.state, store: deps.store, now: deps.now, ...(deps.go ? { go: deps.go } : {}),
    onTick: () => { void deps.tick(); }, onNotNow: () => { void deps.notNow(); },
    onUndo: () => { if (slot.trail) void deps.undo(slot.trail); },
  }));
  if (!hadFocus) return;
  const next = holder.querySelector<HTMLElement>('button') ?? holder.querySelector<HTMLElement>('.bureau-title');
  if (next) { if (!next.matches('button')) next.tabIndex = -1; next.focus(); } else deps.focus();
}
