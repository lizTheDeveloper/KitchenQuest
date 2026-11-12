import { buildCheckOffCard, matchCheckOff, navPlace, normalizeTurn, playerOwnWords, stripPageEvents, type CheckOffCard, type MarketRunView, type NavTarget, type ReplyPart } from '@kitchenquest/core';
import type { Catalog } from '../catalog.js';
import type { Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { ApiError } from '../errors.js';
import { openRunViewIn, tickIn } from '../week/market-service.js';
import type { WeekDeps } from '../week/plan-service.js';
import { loadRunById } from '../week/store.js';
import { line } from './lines.js';
import type { WeekSource } from './plan-turn.js';

/**
 * The market check-off pieces of a mentor turn (M6 Step 8, Rulings 13 and 14; C30, C31). Code matches every word to a
 * row of the player's open run (core `checkOffIntent`, `matchCheckOff`) and builds the card (core `buildCheckOffCard`).
 * A grammar card is applied in the turn itself, through the write guard (`confirmProposalIn`, channel 'grammar'); a
 * model card waits for the player's tap. Each tick is Step 6's `tickIn`, one row at a time in one transaction.
 */

export interface CheckOffDeps {
  keyring: Keyring;
  catalog: Catalog;
  week: WeekSource;
}

async function weekDepsOf(tx: Tx, deps: CheckOffDeps): Promise<WeekDeps> {
  return { keyring: deps.keyring, catalog: deps.catalog, loop: deps.week.loop, recipes: await deps.week.recipes.current(tx) };
}

/** The player's open run for the plan week of `today`, its rows as they stand now; read only (no lock, no write). */
export async function currentRun(tx: Tx, deps: CheckOffDeps, userId: string, today: string): Promise<MarketRunView | null> {
  return openRunViewIn(tx, await weekDepsOf(tx, deps), userId, today);
}

/** What a check-off confirm records to undo: the run and exactly the row keys it ticked. */
export interface CheckOffUndo {
  runId: string;
  keys: string[];
}

/** `tickIn`'s refusals that mean "this row is not there to change now": gone (404), out of stock or a swap (400), done (409). */
const skipped = (e: unknown): boolean =>
  e instanceof ApiError && (e.code === 'not_found' || e.code === 'stock_invalid' || e.code === 'run_closed');

/**
 * Ticks the card's got rows into the pantry, dated `today` (source 'market', Ruling 16), re-reading the run under its
 * locks: a row gone from the run, already ticked (on screen since), or marked out of stock is skipped. Missing rows are
 * never ticked. The caller holds the locks `lockForKind('check_off')` takes (`pantry:` → `plan:` → `health_data`), so
 * `tickIn` re-takes only locks already held. Returns the keys it ticked and their row names.
 */
export async function tickCheckOffIn(
  tx: Tx,
  deps: CheckOffDeps,
  userId: string,
  card: CheckOffCard,
  at: Date,
  today: string | undefined,
  requestId?: string,
): Promise<{ keys: string[]; names: string[] }> {
  const week = await weekDepsOf(tx, deps);
  const before = await loadRunById(tx, deps.keyring, userId, card.runId);
  if (before === null || before.doneAt !== null) return { keys: [], names: [] };
  const keys: string[] = [];
  const names: string[] = [];
  for (const key of card.got) {
    const row = before.items.find((i) => i.key === key);
    if (row === undefined || row.ticked || row.outOfStock === true) continue;
    try {
      const view = await tickIn(tx, week, userId, card.runId, key, true, at, requestId, today);
      keys.push(key);
      names.push(view.items.find((i) => i.key === key)?.name ?? row.name);
    } catch (e) {
      if (!skipped(e)) throw e;
    }
  }
  return { keys, names };
}

/** Undo: unticks exactly the rows the confirm ticked; each tick's own pantry row goes (by pantry id, `tickIn`). */
export async function untickCheckOffIn(tx: Tx, deps: CheckOffDeps, userId: string, undo: CheckOffUndo, at: Date, requestId?: string): Promise<void> {
  const week = await weekDepsOf(tx, deps);
  for (const key of undo.keys) {
    try {
      await tickIn(tx, week, userId, undo.runId, key, false, at, requestId);
    } catch (e) {
      if (!skipped(e)) throw e;
    }
  }
}

/** No open market run: `market.no_run` and a chip to the market list (Ruling 14). Nothing is ticked or stored. */
function noRunParts(): ReplyPart[] {
  const target: NavTarget = { to: 'market' };
  return [line('market.no_run'), { kind: 'go', target, line: { trigger: 'nav.offer', vars: { place: navPlace(target, null) } } }];
}

/**
 * A missing word from the model is kept only where the player's own words say it in one of the grammar's missing forms
 * ("out of X", "couldn't get X", "no X today / left / in stock / at the stall"): a bare "no X" is a health statement
 * (N7), never a stock note, so "got the chicken, no fennel" never puts fennel on a card as missing.
 */
function saidMissing(own: string, word: string): boolean {
  const t = normalizeTurn(own);
  const w = normalizeTurn(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (w === '') return false;
  const item = `(?:the |some |a |an )?${w}`;
  return new RegExp(`\\b(?:out of|couldn'?t get) (?:[^,.;!?]*\\b(?:and|,) )?${item}\\b|\\bno ${item} (?:today|left|in stock|at the stall)\\b`).test(t);
}

/**
 * The model's `propose_check_off` as reply parts and at most one card (Ruling 14). The strings were already checked to be
 * the player's verbatim words (R5, `applyPostChecks`). With no open run: `market.no_run` and a chip to the list. Words
 * that match no open row are dropped silently (never echoed); with none matched, `market.checkoff_none`. The card is
 * pending (`source: 'model'`): nothing ticks until the player taps it, or a plain typed yes (M4 strict yes).
 */
export function modelCheckOff(
  args: { got: string[]; missing: string[] },
  run: MarketRunView | null,
  raw: string,
  deps: { catalog: Catalog },
): { card: CheckOffCard | null; parts: ReplyPart[] } {
  if (run === null) return { card: null, parts: noRunParts() };
  const own = stripPageEvents(playerOwnWords(raw)).text;
  const graph = deps.catalog.graph;
  const got = matchCheckOff(args.got, run, graph).keys;
  const missing = matchCheckOff(args.missing.filter((w) => saidMissing(own, w)), run, graph).keys;
  const card = buildCheckOffCard(run, got, missing, 'model');
  if (card === null) return { card: null, parts: [line('market.checkoff_none')] };
  return { card, parts: card.readback.map((l) => ({ kind: 'line', line: l })) };
}
