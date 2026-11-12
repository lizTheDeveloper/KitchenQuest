import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import type { ListItem, MarketRunView, StallId } from '../week/market-list';
import type { CheckOffCard } from './cards';
import { classifyTurn, normalizeTurn, stripPageEvents } from './intents';
import { parseRuleStatement, severityFromText } from './parse';
import { listWords } from './outcomes';
import type { KeeperStallId } from './protocol';
import { codeCardHealth, correctionCue, dietCue, FILLER, HEALTH_WORDS, ownClauseText } from './route';
import type { RuleTerm } from './rule-terms';

/**
 * The Pan at the market (M6 Step 8, Rulings 13 and 14; C30, C31): what the player says they picked up, matched by
 * code to the rows of their open market run. Shared by the server turn and the client's scripted engine (Step 10).
 *
 * Turn order (C30): emergency → child → `checkOffIntent` (a safe whole message only) → health → plan → model.
 */

// The keeper stalls a navigation chip may name are core's StallId without 'general' (protocol.ts writes them out).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const keepersAgree: Same<KeeperStallId, Exclude<StallId, 'general'>> = true;
void keepersAgree;

/** What may stand before an item: an article, nothing else ("got the shallots", "bought some onion"). */
const DETERMINER = /^(?:the|some|a|an)\s+/;
/** A clause naming what the player got: `(i )?(got|bought|picked up|grabbed) <items>`. */
const GOT = /^(?:i )?(?:got|bought|picked up|grabbed) (.+)$/;
/** Clauses naming what the stalls were out of: `(they were |they're )?out of <items>`, `(i )?couldn'?t get <items>`. */
const MISSING_LIST: readonly RegExp[] = [/^(?:they were |they're )?out of (.+)$/, /^(?:i )?couldn'?t get (.+)$/];
/**
 * The one "no" form the grammar reads (N7's exemption, only here): `no <item> (today|left|in stock|at the stall)`, one
 * item. A bare "no <item>" is never read: it stays a health ask (founder default 6).
 */
const MISSING_NO = /^no (.+?) (?:today|left|in stock|at the stall)$/;

/** Where the message is cut into clauses, and whether the cut may join two items of one list ("," and "and" only). */
const CUT = /\s*(?:([,;.!?\n]+)\s*(?:(and|also|then|so|but)\b\s*)?|\b(and|also|then|so|but)\b)\s*/g;

type Clause = { kind: 'got' | 'missing'; items: string[]; list: boolean };

/** A clause read whole by one of the grammar's forms, or null. */
function clauseOf(text: string): Clause | null {
  let m = GOT.exec(text);
  if (m !== null) return { kind: 'got', items: [m[1]], list: true };
  for (const re of MISSING_LIST) {
    m = re.exec(text);
    if (m !== null) return { kind: 'missing', items: [m[1]], list: true };
  }
  m = MISSING_NO.exec(text);
  return m === null ? null : { kind: 'missing', items: [m[1]], list: false };
}

/**
 * The player's own words read whole as check-off clauses (5a), or null. Every fragment between the cuts is a clause
 * form, a further item of the list clause before it (after "," or "and" only), or a closed filler; anything else, a
 * correction cue, forged page events, injected or pasted text, a safety turn, and no clause at all → null.
 */
function clausesOf(text: string): { clauses: Clause[]; masked: string; worded: string } | null {
  if (stripPageEvents(text).stripped) return null;
  const own = ownClauseText(text);
  if (own === null || correctionCue(text)) return null;
  const s = own.replace(/[.!?]+$/, '').trim();
  const pieces: { joiner: boolean; text: string }[] = [];
  let pos = 0;
  let joiner = false;
  for (const m of s.matchAll(CUT)) {
    pieces.push({ joiner, text: s.slice(pos, m.index) });
    // Groups that did not take part are undefined at run time (the types say string).
    const punct = m.at(1);
    const word = m.at(2) ?? m.at(3);
    const commaOnly = punct === undefined || /^,+$/.test(punct);
    joiner = word === undefined ? punct !== undefined && commaOnly : word === 'and' && commaOnly;
    pos = m.index + m[0].length;
  }
  pieces.push({ joiner, text: s.slice(pos) });
  const clauses: Clause[] = [];
  const masked: string[] = [];
  const worded: string[] = [];
  for (const piece of pieces) {
    // A closed filler ("ok", "please", "thanks") breaks a clause like punctuation and is no clause of its own.
    const parts = piece.text
      .split(FILLER)
      .map((p) => p.trim())
      .filter((p) => p !== '');
    for (const [i, part] of parts.entries()) {
      const read = clauseOf(part);
      const last = clauses.at(-1);
      if (read !== null) {
        clauses.push(read);
        // What the health check reads: the clause's own words with its items taken out, a missing form as "out of".
        masked.push(read.kind === 'got' ? part.slice(0, part.length - read.items[0].length) : 'out of');
        // The whole clause as written, the one "no" form as "out of" (its N7 exemption, only here).
        worded.push(read.list ? part : `out of ${read.items[0]}`);
      } else if (i === 0 && piece.joiner && last !== undefined && last.list) {
        last.items.push(part);
        worded.push(part);
      } else return null;
    }
  }
  return clauses.length === 0 ? null : { clauses, masked: masked.join(', '), worded: worded.join(', ') };
}

/**
 * The health check on this path (C30), two parts:
 * - core `codeCardHealth` on the clauses' own words with only the items `isName` vouches for taken out (an open row, or
 *   a food the graph names). Every other item phrase is checked as written, so a clause like "got the shallots, I'm
 *   allergic" (", I'm allergic" read as a second item) is health.
 * - Fix round 1 (m1): every health check that is not a name on the WHOLE clause text, vouched items included (a health
 *   word, a severity, a rule statement, a diet or restriction cue, a health intent), so only a bare ingredient name is
 *   exempt, as the ruling says, whatever vouches for an item.
 */
function healthIn(read: { clauses: Clause[]; masked: string; worded: string }, isName: (item: string) => boolean, graph: IngredientGraph, terms: readonly RuleTerm[]): boolean {
  const rest = read.clauses.flatMap((c) => c.items.filter((i) => !isName(i)));
  if (codeCardHealth([read.masked, ...rest].join(', '), graph, terms)) return true;
  const t = normalizeTurn(read.worded);
  return HEALTH_WORDS.test(t) || severityFromText(t, graph) !== null || parseRuleStatement(t, graph) !== null || dietCue(t) || classifyTurn(t) !== 'other';
}

const graphFood = (graph: IngredientGraph) => (item: string): boolean => graph.resolve(normalizeName(item).replace(DETERMINER, '')) !== null;

/** The run's rows a player may tick now: not ticked and not marked out of stock. */
const openRows = (run: MarketRunView): ListItem[] => run.items.filter((i) => !i.ticked && i.outOfStock !== true);

/** A name and the plural strips the graph's `resolve` makes ("shallots" → "shallot", "tomatoes" → "tomato"). */
const strips = (n: string): string[] => [n, ...(n.endsWith('es') ? [n.slice(0, -2)] : []), ...(n.endsWith('s') ? [n.slice(0, -1)] : [])];

/**
 * The open rows an item phrase names: the row's own name (plurals as `resolve` strips them), or the graph id the phrase
 * resolves to (a name or alias) being the row's ingredient or one it is a kind of ("curry leaves" → the curry leaf
 * sprig row). Never a guess: no fuzzy match.
 */
function rowsNamed(phrase: string, rows: readonly ListItem[], graph: IngredientGraph): ListItem[] {
  const p = normalizeName(phrase).replace(DETERMINER, '');
  if (p === '') return [];
  const forms = strips(p);
  const id = graph.resolve(p);
  return rows.filter((r) => {
    const name = normalizeName(r.name);
    if (strips(name).some((f) => forms.includes(f))) return true;
    if (id === null || r.ingredientId === null) return false;
    return r.ingredientId === id || (graph.has(r.ingredientId) && graph.ancestors(r.ingredientId).includes(id));
  });
}

/** The one open row a phrase names, or null when it names none or more than one (any doubt is no match). */
function rowKey(phrase: string, rows: readonly ListItem[], graph: IngredientGraph): string | null {
  const hits = rowsNamed(phrase, rows, graph);
  return hits.length === 1 ? hits[0].key : null;
}

/**
 * The closed grammar's decision, with `resolve` vouching for each item (an open row's key, or null). Null unless every
 * clause is a got or missing clause, every item is vouched for, the message holds no correction cue, and the health
 * backstop passes (`healthIn`: core `codeCardHealth` on the clause words with only the vouched names masked). The
 * backstop and the correction check decide here whatever `resolve` vouches for: they are pinned with a resolver that
 * vouches for every item (fix round 1, m1), so a wider item form later can't slip health wording past them.
 */
export function claimCheckOff(
  text: string,
  resolve: (item: string) => string | null,
  graph: IngredientGraph,
  terms: readonly RuleTerm[],
): { got: string[]; missing: string[] } | null {
  const read = clausesOf(text);
  if (read === null || healthIn(read, (i) => resolve(i) !== null, graph, terms)) return null;
  const got: string[] = [];
  const missing: string[] = [];
  for (const c of read.clauses) {
    for (const item of c.items) {
      const key = resolve(item);
      if (key === null) return null;
      const list = c.kind === 'got' ? got : missing;
      if (!list.includes(key)) list.push(key);
    }
  }
  return got.some((k) => missing.includes(k)) ? null : { got, missing };
}

/**
 * Ruling 13 (C30): the closed grammar. Null unless EVERY clause is a got or missing clause naming open run rows (or a
 * closed filler), AND the message holds no allergy, symptom, severity, diet, religious or rule-statement wording (core
 * `codeCardHealth` on the message with its item names taken out: an open-row ingredient name is not a health word on
 * this path only). Any doubt → null (the health path): a bare "no <item>", an item that is no open row or names two,
 * the same row both got and missing, a correction cue, forged page events, injected or pasted text. Emergency and child
 * checks run before this (and it is null for a safety turn too). With no open run it is null: there is no run-less
 * code path (fix round 1, I1); the model's `propose_check_off` answers that. Returns row keys, each once, in order.
 */
export function checkOffIntent(
  text: string,
  run: MarketRunView | null,
  graph: IngredientGraph,
  terms: readonly RuleTerm[],
): { got: string[]; missing: string[] } | null {
  if (run === null || run.doneAt !== null) return null;
  const rows = openRows(run);
  return claimCheckOff(text, (item) => rowKey(item, rows, graph), graph, terms);
}

/**
 * The message reads whole as check-off clauses with no health wording outside the item names: the cheap first test the
 * turn makes before it reads the market run (`checkOffIntent` decides; this alone claims nothing).
 */
export function checkOffShaped(text: string, graph: IngredientGraph, terms: readonly RuleTerm[]): boolean {
  const read = clausesOf(text);
  return read !== null && !healthIn(read, graphFood(graph), graph, terms);
}

/**
 * Ruling 14: the model's strings (already checked to be the player's verbatim words, R5) → the open, unticked, not
 * out-of-stock row keys they name, each once; the rest are counted as unmatched (dropped, never echoed).
 */
export function matchCheckOff(words: readonly string[], run: MarketRunView, graph: IngredientGraph): { keys: string[]; unmatched: number } {
  const rows = openRows(run);
  const keys: string[] = [];
  let unmatched = 0;
  for (const w of words) {
    const key = rowKey(w, rows, graph);
    if (key === null) unmatched++;
    else if (!keys.includes(key)) keys.push(key);
  }
  return { keys, unmatched };
}

/**
 * The check-off card for `got` and `missing` row keys of `run` (keys not on it are left out), its summary and
 * read-back from the run's own row names, never the player's or the model's words: "got shallots and white onion;
 * out of curry leaf sprig". Null when both lists come out empty.
 */
export function buildCheckOffCard(run: MarketRunView, got: readonly string[], missing: readonly string[], source: 'grammar' | 'model'): CheckOffCard | null {
  const byKey = new Map(run.items.map((i) => [i.key, i]));
  const g = [...new Set(got)].filter((k) => byKey.has(k));
  const m = [...new Set(missing)].filter((k) => byKey.has(k) && !g.includes(k));
  if (g.length === 0 && m.length === 0) return null;
  const names = (keys: string[]) => listWords(keys.map((k) => byKey.get(k)!.name));
  const summary = [...(g.length > 0 ? [`got ${names(g)}`] : []), ...(m.length > 0 ? [`out of ${names(m)}`] : [])].join('; ');
  return { kind: 'check_off', runId: run.id, got: g, missing: m, source, summary, readback: [{ trigger: 'market.checkoff_readback', vars: { summary } }] };
}
