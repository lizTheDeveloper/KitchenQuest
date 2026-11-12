// M7 Ruling 15 (D4, P2, B5): what the Pan says aloud, rendered by the API alone from server-held data. A client's
// `speak` names items by id or reference only (core `SpeakItem`: no text, no variables); every variable here is the
// server's own and passes `filterReply` again; anything that cannot be said safely is spoken as `voice.check_screen`,
// never dropped silently. TTS takes only `SpeakableText`, which only `renderSpeak` makes.
import {
  check,
  heardCheck,
  planWeekStart,
  stockSwapsFor,
  listWords,
  MAX_SPEAK_CHARS,
  MAX_SPEAK_ITEMS,
  SPEAK_VAR_MAX,
  speechChunks,
  speechText,
  stepSpeech,
  type HeardCheck,
  type IngredientGraph,
  type LineRef,
  type RuleTerm,
  type SpeakItem,
} from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import { loadNotes } from '../book/notes-service.js';
import type { Catalog } from '../catalog.js';
import type { Keyring } from '../crypto/keyring.js';
import { profiles } from '../db/schema.js';
import { filterReply } from '../mentor/filter.js';
import type { PanBank } from '../mentor/lines.js';
import { readProposalCard } from '../mentor/proposals.js';
import type { RecipeIndex } from '../recipes/recipe-index.js';
import { loadRules } from '../rules/store.js';
import type { Db } from '../types.js';
import { localToday } from '../week/local-date.js';
import { loadPlan, loadRunForPlan, viewOf } from '../week/store.js';
import { recentReplies } from './recent-replies.js';

declare const brand: unique symbol;
/** Speech the TTS may say: chunks to speak verbatim, `cache` per chunk (B5). Only `renderSpeak` makes one (D4). */
export type SpeakableText = { readonly chunks: readonly { text: string; cache: boolean }[]; readonly [brand]: true };

/** The texts renderSpeak made: the runtime half of the brand, checked by the upstream before anything is sent. */
const minted = new WeakSet<object>();

/** True only for a SpeakableText that renderSpeak made (a cast or a copy is refused). */
export function isSpeakable(x: unknown): x is SpeakableText {
  return typeof x === 'object' && x !== null && minted.has(x);
}

export const CHECK_SCREEN = 'voice.check_screen';
export const STEP_ON_SCREEN = 'voice.step_on_screen';
export const HEARD_CHECK = 'voice.heard_check';
export const HEARD_CHECK_SPELLED = 'voice.heard_check_spelled';
export const TOO_LONG = 'voice.too_long';
/** Every trigger renderSpeak says itself, each with its variables: the voice route checks the bank has them at boot. */
export const SPOKEN_TRIGGERS: Readonly<Record<string, readonly string[]>> = {
  [CHECK_SCREEN]: [],
  [STEP_ON_SCREEN]: [],
  [TOO_LONG]: [],
  [HEARD_CHECK]: ['terms'],
  [HEARD_CHECK_SPELLED]: ['spelled', 'terms'],
};

export interface SpeakContext {
  userId: string;
  bank: PanBank;
  /** The graph and rule terms the heard check reads (as the mentor turn's). */
  catalog: { graph: IngredientGraph; ruleTerms: readonly RuleTerm[] };
  /** This socket's own transcript of utterance `utteranceId` (the client's id), or null when it has none. */
  lastTranscript(utteranceId: number): string | null;
  /** The read-back of the player's own open or decided card (sealed `mentor_proposals`), or null when not theirs. */
  card(proposalId: string): Promise<LineRef[] | null>;
  /** Ruling 11: the dish checks ✅ on `localDate` with the player's rules, with no 🔁 and no stall swap. */
  stepOk(slug: string, step: number, localDate: string): Promise<boolean>;
  recipes: RecipeIndex;
  /** For `recentReplies` (defaults to the wall clock). */
  nowMs?: number;
}

interface Piece {
  text: string;
  cache: boolean;
}

/** A server-held variable may be spoken: short, and it passes the output filter (Ruling 15). */
const speakableVar = (v: string): boolean => v.length <= SPEAK_VAR_MAX && filterReply(v, { finish: 'stop' }).ok;

/**
 * One written line with the server's variables: every variable checked, the first variant that fills them. Cacheable
 * only when the trigger takes no variables at all, so nothing personal is ever cached (B5). Null when it can't be said.
 */
function refPiece(bank: PanBank, ref: LineRef): Piece | null {
  if (!Object.values(ref.vars).every((v) => typeof v === 'string' && speakableVar(v))) return null;
  const text = bank.firstLine(ref);
  if (text === '') return null;
  return { text, cache: Object.keys(ref.vars).length === 0 && bank.varsOf(ref.trigger).length === 0 };
}

function fixed(bank: PanBank, trigger: string): Piece {
  const text = bank.lineAt(trigger, 0, {});
  if (text === null) throw new Error(`renderSpeak: pan.yaml has no var-free ${trigger}`);
  return { text, cache: true };
}

/** The heard card's spoken half, from this socket's own transcript (§7.6b.2: the spelling comes from code). */
export function heardLine(check: HeardCheck): LineRef {
  const terms = listWords(check.terms.map((t) => t.heard));
  if (!check.speakSpelling) return { trigger: HEARD_CHECK, vars: { terms } };
  return { trigger: HEARD_CHECK_SPELLED, vars: { terms, spelled: check.terms.map((t) => t.spelled).join(', ') } };
}

async function piecesOf(item: SpeakItem, ctx: SpeakContext): Promise<Piece[] | null> {
  const { bank } = ctx;
  switch (item.kind) {
    case 'line': {
      // The client sends no variables, so only a var-free trigger can be said (a device line with vars: check_screen).
      if (bank.varsOf(item.trigger).length > 0) return null;
      const text = bank.lineAt(item.trigger, item.index, {});
      return text === null ? null : [{ text, cache: true }];
    }
    case 'reply': {
      const ref = recentReplies.line(ctx.userId, item.replyId, item.part, ctx.nowMs);
      const p = ref === null ? null : refPiece(bank, ref);
      return p === null ? null : [p];
    }
    case 'card': {
      const refs = await ctx.card(item.proposalId);
      if (refs === null || refs.length === 0) return null;
      const out: Piece[] = [];
      for (const ref of refs) {
        const p = refPiece(bank, ref);
        if (p === null) return null; // a read-back is said whole or not at all
        out.push(p);
      }
      return out;
    }
    case 'heard': {
      const transcript = ctx.lastTranscript(item.utteranceId);
      if (transcript === null) return null;
      const check = heardCheck(transcript, ctx.catalog.graph, ctx.catalog.ruleTerms);
      if (check === null) return null;
      // Contract (core heard-types.ts, N7): tooLong first. It was not read: refuse, and ask the player to type.
      if (check.tooLong) return [fixed(bank, TOO_LONG)];
      const p = refPiece(bank, heardLine(check));
      return p === null ? null : [p];
    }
    case 'step': {
      const recipe = ctx.recipes.get(item.slug);
      if (recipe === undefined) return null;
      const text = stepSpeech(recipe, item.step);
      if (text === null) return null;
      // Ruling 11: read aloud only when safe; a step too long to say is on the screen too.
      if (!(await ctx.stepOk(item.slug, item.step, item.localDate)) || speechText(text).length > MAX_SPEAK_CHARS) return [fixed(bank, STEP_ON_SCREEN)];
      return [{ text, cache: false }];
    }
  }
}

/** As core's upstream parser: a speak carries at most this many chunks. */
const MAX_CHUNKS = MAX_SPEAK_ITEMS * 8;

const chunksOf = (pieces: readonly Piece[]) =>
  pieces.flatMap((p) => speechChunks(speechText(p.text)).map((text) => ({ text, cache: p.cache })));
const lengthOf = (chunks: readonly { text: string }[]) => chunks.reduce((n, c) => n + c.text.length, 0);

/**
 * Renders a client's speak items into SpeakableText (Ruling 15):
 * - `line`: a var-free trigger's variant `index`; a trigger with variables is `voice.check_screen`;
 * - `reply`: the line part of the player's recent reply (`recentReplies`), with the server's variables;
 * - `card`: the read-back of the player's own card (`ctx.card`); another player's id reads as unknown;
 * - `heard`: core `heardCheck` of this socket's own transcript → `voice.heard_check(_spelled)`, spelled by core `spell`
 *   (§7.6b.2); a check too long to read → `voice.too_long`;
 * - `step`: core `stepSpeech` when `ctx.stepOk`, else `voice.step_on_screen` (Ruling 11).
 * Every variable must be at most SPEAK_VAR_MAX and pass `filterReply`, else THAT item is `voice.check_screen`; so is an
 * unknown id. Past MAX_SPEAK_CHARS in total, the items from the cut on are one `voice.check_screen`. Adjacent
 * fallbacks are said once. Chunks are core `speechChunks(speechText(text))`; `cache` per chunk: true only for a
 * var-free line (B5).
 */
export async function renderSpeak(items: readonly SpeakItem[], ctx: SpeakContext): Promise<SpeakableText> {
  const check = chunksOf([fixed(ctx.bank, CHECK_SCREEN)]);
  const reserve = lengthOf(check);
  const out: { text: string; cache: boolean }[] = [];
  let total = 0;
  let lastWasCheck = false;
  const sayCheck = () => {
    if (lastWasCheck) return;
    out.push(...check);
    total += reserve;
    lastWasCheck = true;
  };
  for (let i = 0; i < items.length; i++) {
    const pieces = await piecesOf(items[i], ctx);
    if (pieces === null) {
      sayCheck();
      continue;
    }
    const chunks = chunksOf(pieces);
    const len = lengthOf(chunks);
    const more = i < items.length - 1;
    const room = MAX_SPEAK_CHARS - total - (more ? reserve : 0);
    if (len > room || out.length + chunks.length > MAX_CHUNKS - (more ? check.length : 0)) {
      // The cut: this item and every later one are on the screen. Room for the fallback is always kept.
      sayCheck();
      break;
    }
    out.push(...chunks);
    total += len;
    lastWasCheck = chunks.length > 0 && chunks.every((c, k) => c.text === check[k]?.text) && chunks.length === check.length;
  }
  const text = { chunks: Object.freeze(out.map((c) => Object.freeze({ ...c }))) } as unknown as SpeakableText;
  minted.add(Object.freeze(text));
  return text;
}

// --- the server-held sources a socket's SpeakContext reads ----------------------------------------------------------

/** A card item's read-back: the player's own sealed proposal (any status), its code-built `readback`; else null. */
export async function cardReadback(db: Db, keyring: Keyring, userId: string, proposalId: string): Promise<LineRef[] | null> {
  const card = await readProposalCard(db, keyring, userId, proposalId);
  return card === null ? null : card.readback.map((r) => ({ trigger: r.trigger, vars: { ...r.vars } }));
}

/**
 * Ruling 11: a canon step may be read aloud only when the dish checks ✅ (`ok`: no 🔁 swap, nothing ❓ or ⛔) with the
 * player's rules on `localDate` (their local date, within a day of the server's), the plan week's market run (open
 * or done, as cook mode shows it) made no stall swap for the dish, and none of the player's margin notes changes its
 * ingredients. Anything unknown or invalid is false: the step is on the screen.
 */
export async function stepCleared(
  db: Db,
  deps: { keyring: Keyring; catalog: Catalog; recipes: RecipeIndex },
  userId: string,
  slug: string,
  localDate: string,
  now: Date,
): Promise<boolean> {
  try {
    localToday(localDate, now);
  } catch {
    return false;
  }
  const recipe = deps.recipes.get(slug);
  if (recipe === undefined) return false;
  const rules = await loadRules(db, deps.keyring, userId);
  if (check(recipe, rules, deps.catalog.graph, [...deps.catalog.substitutions], localDate).status !== 'ok') return false;
  if ((await loadNotes(db, deps.keyring, userId, slug)).some((n) => n.ops.length > 0)) return false;
  const marketDays = (await db.select({ marketDays: profiles.marketDays }).from(profiles).where(eq(profiles.userId, userId))).at(0)?.marketDays ?? [];
  const plan = await loadPlan(db, deps.keyring, userId, planWeekStart(localDate, marketDays));
  if (plan === null) return true;
  const run = await loadRunForPlan(db, deps.keyring, userId, plan.id);
  return run === null || stockSwapsFor(viewOf(run), slug).length === 0;
}
