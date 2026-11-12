// The lazy market module (M6 Step 5): the client shape of each stall, and the option-order pins (Ruling 2).
import { createHash } from 'node:crypto';
import { STALL_IDS, type SeasonTable, type StallFile, type StallId, type StallQuestion, type StallTrigger } from '@kitchenquest/core';
import type { ClientStall, MarketContent } from '../../src/content/types';

/** Repo-relative path of the committed pin file. */
export const PINS_PATH = 'apps/game/build/content/market-pins.json';

/** Question id → hash of its option texts in file order. */
export type MarketPins = Readonly<Record<string, string>>;

type MarketStallId = Exclude<StallId, 'general'>;
const MARKET_STALLS = STALL_IDS.filter((id): id is MarketStallId => id !== 'general');

/** Drop the writers' `when` and `notes`: no model reads them in M6 (Ruling 21). */
function clientTriggers(triggers: Record<string, StallTrigger>): Record<string, StallTrigger> {
  return Object.fromEntries(Object.entries(triggers).map(([id, { when: _w, notes: _n, ...rest }]) => [id, rest]));
}

/** A stall as shipped: no persona (base or variant), no trigger `when` or `notes`. Everything a screen shows stays. */
export function clientStall(stall: StallFile): ClientStall {
  const { persona: _persona, variants, ...rest } = stall;
  const out: ClientStall = { ...rest, triggers: clientTriggers(stall.triggers) };
  const pc = variants?.protein_counter;
  if (pc !== undefined) {
    const { persona: _pcPersona, ...pcRest } = pc;
    out.variants = { protein_counter: { ...pcRest, triggers: clientTriggers(pc.triggers) } };
  }
  return out;
}

/** Keys sorted at every level, so the version depends on content, never on key order. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/**
 * The client market module's data, from the compiled (already validated) content: every market stall in its client
 * shape and The Season's Table. `version` is the first 12 hex of sha256 over the canonical JSON of both.
 */
export function compileMarket(content: { stalls: Record<string, StallFile>; seasonality: SeasonTable }): MarketContent {
  const stalls = {} as Record<MarketStallId, ClientStall>;
  for (const id of MARKET_STALLS) {
    if (!Object.hasOwn(content.stalls, id)) throw new Error(`compileMarket: stall "${id}" is missing`);
    stalls[id] = clientStall(content.stalls[id]);
  }
  const version = createHash('sha256').update(JSON.stringify(canonical({ stalls, seasonality: content.seasonality }))).digest('hex').slice(0, 12);
  return { stalls, seasonality: content.seasonality, version };
}

/** Every question in a stall file, with its key path: base, the Protein Counter, and every seasonal month. */
export function stallQuestions(stall: StallFile): { at: string; q: StallQuestion }[] {
  const out: { at: string; q: StallQuestion }[] = stall.questions.map((q, i) => ({ at: `questions[${i}]`, q }));
  stall.variants?.protein_counter?.questions.forEach((q, i) => out.push({ at: `variants.protein_counter.questions[${i}]`, q }));
  for (const [region, months] of Object.entries(stall.seasonal ?? {})) {
    for (const [month, list] of Object.entries(months)) list.forEach((q, i) => out.push({ at: `seasonal.${region}.${month}[${i}]`, q }));
  }
  return out;
}

/**
 * Ruling 2: a hash of a question's options in file order: each option's text and whether it is the correct one (fix
 * round 1, M4: a saved `pick` would be re-scored the other way if the correct option moved under the same id).
 */
export function optionPin(q: StallQuestion): string {
  return createHash('sha256').update(JSON.stringify(q.options.map((o) => [o.text, o.correct]))).digest('hex').slice(0, 16);
}

/**
 * The pin file's text as pins (fix round 1, M3): `null` (the file does not exist yet) is the only "first run". A file
 * that does not parse (a merge conflict) or is not a map of id → hash throws, so `content:pin` never re-pins every
 * question to whatever its options are now.
 */
export function parsePinsFile(text: string | null): Record<string, string> {
  if (text === null) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${PINS_PATH}: JSON does not parse (${e instanceof Error ? e.message : String(e)}); fix the file, never delete it to re-pin`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Object.values(raw).every((v) => typeof v === 'string')) {
    throw new Error(`${PINS_PATH}: not a map of question id to pin`);
  }
  return raw as Record<string, string>;
}

/**
 * Ruling 2: an event's `pick` is an option index in file order, so once a question ships its options are pinned. A
 * pinned id whose options changed order or text fails ("give the question a new id"); an id with no pin fails until
 * `npm run content:pin -w @kitchenquest/game` adds it (the build never writes the pin file itself). Pins of removed
 * questions stay, so a removed id can't come back with different options.
 */
export function pinProblems(stall: StallFile, pins: MarketPins): string[] {
  const problems: string[] = [];
  for (const { at, q } of stallQuestions(stall)) {
    const pin = Object.hasOwn(pins, q.id) ? pins[q.id] : undefined;
    if (pin === undefined) {
      problems.push(`${at} (${q.id}): has no option-order pin; run \`npm run content:pin -w @kitchenquest/game\` and commit ${PINS_PATH}`);
    } else if (pin !== optionPin(q)) {
      problems.push(
        `${at} (${q.id}): its options changed order, text or correct answer since the question shipped (Ruling 2: a saved answer is an option index): ` +
          'give the question a new id, or, for a deliberate text fix, re-pin it with `npm run content:pin -w @kitchenquest/game -- --repin ' + q.id + '` in the same commit',
      );
    }
  }
  return problems;
}

/**
 * The pin file after `content:pin`: every pin kept, every new question id added. An existing id whose options changed
 * is re-pinned only when named in `repin` (a deliberate text fix); otherwise it is reported and left as it was.
 */
export function updatedPins(stalls: readonly StallFile[], pins: MarketPins, repin: ReadonlySet<string> = new Set()): { pins: Record<string, string>; added: string[]; repinned: string[]; changed: string[] } {
  const next: Record<string, string> = { ...pins };
  const added: string[] = [];
  const repinned: string[] = [];
  const changed: string[] = [];
  for (const stall of stalls) {
    for (const { q } of stallQuestions(stall)) {
      const pin = optionPin(q);
      if (!Object.hasOwn(next, q.id)) {
        next[q.id] = pin;
        added.push(q.id);
      } else if (next[q.id] !== pin) {
        if (repin.has(q.id)) {
          next[q.id] = pin;
          repinned.push(q.id);
        } else changed.push(q.id);
      }
    }
  }
  const sorted = Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]]));
  return { pins: sorted, added, repinned, changed };
}
