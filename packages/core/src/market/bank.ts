// Which stall questions, tips and FAQ answers a player may see (M6 Step 1, spec §2.2 and §3.5). Everything a question
// names goes through the M1 rules engine with the player's rules on their local date, with NO substitutions: a
// question names the item itself, so a curated swap never makes a blocked item 🔁 here. Only ✅ is shown; ⛔ and ❓
// are dropped ("can't verify is never safe"). Pure and browser-safe: no I/O, no recipe parser, no progress/.
import { lineOf, textMentions } from '../ingredients/mentions';
import type { ParsedRecipe } from '../recipe/types';
import { check, type CheckStatus } from '../rules/check';
import { countryInScope } from './country';
import type { ItemTip, MarketCtx, StallFaq, StallFile, StallQuestion, StallTrigger, StallVariant, StallVariantFile } from './types';

const RANK: Record<CheckStatus, number> = { ok: 0, swap: 1, unverified: 2, blocked: 3 };
const worst = (a: CheckStatus, b: CheckStatus): CheckStatus => (RANK[b] > RANK[a] ? b : a);

/** One synthetic recipe holding a bare line for each id, so the rules engine judges a set of items like any dish. */
function itemsRecipe(ids: readonly string[], ctx: MarketCtx): ParsedRecipe {
  return {
    meta: { title: 'market', country: '', region: '', credit: '', cook: '', difficulty: 1, skills: [], servings: 1, license: '', status: 'draft', sacred: false, contributors: [] },
    ingredients: ids.map((id) => lineOf(ctx.graph.get(id).name)),
    timers: [],
    steps: [],
    source: '',
  };
}

/**
 * The worst check status, with no substitutions, over the declared ids and every graph id the texts name. An id the
 * graph doesn't know is ❓, never "no ingredient". Nothing named at all is ✅. Never cached: rules change.
 * Exported inside market/ only (season.ts's notes use it); not part of the package surface.
 */
export function namedStatus(declared: readonly string[], texts: readonly string[], ctx: MarketCtx): CheckStatus {
  const known = new Set<string>();
  let status: CheckStatus = 'ok';
  for (const id of declared) {
    if (ctx.graph.has(id)) known.add(id);
    else status = 'unverified';
  }
  for (const id of textMentions(texts, ctx.graph)) known.add(id);
  if (known.size === 0) return status;
  return worst(status, check(itemsRecipe([...known].sort(), ctx), ctx.rules, ctx.graph, [], ctx.date).status);
}

/**
 * The worst check status, with NO substitutions, over q.contains ∪ every option's contains ∪ textMentions(prompt,
 * options' text and reactions, explain). Reactions count too: they are shown, so whatever they name is named.
 */
export function questionStatus(q: StallQuestion, ctx: MarketCtx): CheckStatus {
  const declared = [...(q.contains ?? []), ...q.options.flatMap((o) => o.contains ?? [])];
  const texts = [q.prompt, ...q.options.flatMap((o) => [o.text, o.reaction]), q.explain];
  return namedStatus(declared, texts, ctx);
}

/**
 * 'protein_counter' when check of the `meat` category is ⛔ under ctx.rules (Ruling 4); 'base' otherwise.
 * Only meaningful for a stall file that has `variants.protein_counter`; every other stall is 'base'.
 * A partial rule ("no pork") leaves `meat` ❓, not ⛔, so Bram stays, with the pork questions dropped.
 */
export function stallVariant(stall: StallFile, ctx: MarketCtx): StallVariant {
  if (stall.variants?.protein_counter === undefined || !ctx.graph.has('meat')) return 'base';
  return check(itemsRecipe(['meat'], ctx), ctx.rules, ctx.graph, [], ctx.date).status === 'blocked' ? 'protein_counter' : 'base';
}

/** The part of the file this player's variant uses: the Protein Counter's own block, or the base stall. */
function sideOf(stall: StallFile, variant: StallVariant): Pick<StallVariantFile, 'questions' | 'item_tips' | 'faq' | 'triggers'> {
  const pc = stall.variants?.protein_counter;
  return variant === 'protein_counter' && pc !== undefined ? pc : stall;
}

/** Ruling 8: absent scope = everywhere; a scope shows only to a player whose country is inside it (`countryInScope`). */
function inScope(q: StallQuestion, country: string | null): boolean {
  return q.countries === undefined || countryInScope(q.countries, country);
}

/**
 * Which bank of the stall file a question id is in: 'protein_counter' for `variants.protein_counter.questions`,
 * 'base' for the stall's own questions and its seasonal ones, null when the file has no such question. Fix round 1,
 * M2: a Protein Counter round is health-revealing (Ruling 17), so callers decide by this, never by an id's prefix.
 * The validator rejects a question id that appears in two banks, so the answer is unique.
 */
export function questionVariant(stall: StallFile, questionId: string): StallVariant | null {
  if (stall.variants?.protein_counter?.questions.some((q) => q.id === questionId)) return 'protein_counter';
  const seasonal = Object.values(stall.seasonal ?? {}).flatMap((months) => Object.values(months).flat());
  return [...stall.questions, ...seasonal].some((q) => q.id === questionId) ? 'base' : null;
}

/**
 * The questions this player may see at this stall now: the variant's (or base) questions plus `seasonal` (Wen's
 * `seasonalQuestions(stall, regionId, month, table)` for the player's own region and month; [] for every other stall and
 * for a player with no seasonal region), each kept only when questionStatus is 'ok' AND its `countries` scope is
 * absent or contains ctx.country (`countryInScope`: both sides through `normalizeCountry`, a UK nation inside the UK). Dropped questions are counted, never named, so a screen can say the
 * bank is smaller without revealing why.
 */
export function stallBank(
  stall: StallFile,
  ctx: MarketCtx,
  seasonal: readonly StallQuestion[] = [],
): { variant: StallVariant; questions: StallQuestion[]; dropped: number } {
  const variant = stallVariant(stall, ctx);
  const all = [...sideOf(stall, variant).questions, ...seasonal];
  const questions = all.filter((q) => inScope(q, ctx.country) && questionStatus(q, ctx) === 'ok');
  return { variant, questions, dropped: all.length - questions.length };
}

/**
 * The stall's tip for an item (the Protein Counter's own tips when that variant is in use), or null when there is
 * none, or when the item, anything the tip's text names, or anything its `contains` declares, is ⛔ or ❓ (no substitutions).
 */
export function tipFor(stall: StallFile, ingredientId: string, ctx: MarketCtx): ItemTip | null {
  const tips = sideOf(stall, stallVariant(stall, ctx)).item_tips;
  const tip = Object.hasOwn(tips, ingredientId) ? tips[ingredientId] : undefined;
  if (tip === undefined) return null;
  // M7 Step 7 (M6 final M7): the tip's declared contains count as well as the scan.
  return namedStatus([ingredientId, ...(tip.contains ?? [])], [tip.pick, tip.store], ctx) === 'ok' ? tip : null;
}

/**
 * The stall's generic safety line, with the ids its trigger declares for it (line 0): the Spice Merchant's
 * `allergen_note`, else `medical`; the variant's, then the base's.
 */
function safetyLine(stall: StallFile, side: { triggers: Record<string, StallTrigger> }): { text: string; contains: string[] } | null {
  for (const key of ['allergen_note', 'medical']) {
    for (const triggers of [side.triggers, stall.triggers]) {
      const trigger = Object.hasOwn(triggers, key) ? triggers[key] : undefined;
      const line = trigger?.lines[0];
      if (typeof line === 'string' && line !== '') {
        const contains = trigger?.contains !== undefined && Object.hasOwn(trigger.contains, '0') ? trigger.contains['0'] : [];
        return { text: line, contains };
      }
    }
  }
  return null;
}

/**
 * Ruling 21: each FAQ entry as its chip (`q[0]`) and the answer to show. An entry whose chip names anything ⛔ or ❓
 * (no substitutions) is left out (fix round 1, I1). When `a` (its words or its `contains`) names anything ⛔ or ❓,
 * `a_if_blocked` (itself checked the same way, with `contains_if_blocked`), else the stall's generic safety line
 * (`medical`; the Spice Merchant's `allergen_note`) when that line is ✅ too (M7 Step 7). An entry with nothing safe
 * to say is left out.
 */
export function faqFor(stall: StallFile, ctx: MarketCtx): { q: string; a: string }[] {
  const side = sideOf(stall, stallVariant(stall, ctx));
  const ok = (text: string, declared: readonly string[] = []): boolean => namedStatus(declared, [text], ctx) === 'ok';
  // M7 Step 7 (M6 final M2): the safety line is checked like any shown text, so it never stands in when it names
  // something ⛔ or ❓ (its trigger's declared ids for line 0 count too). Then the entry has nothing safe to say.
  const line = safetyLine(stall, side);
  const fallback = line !== null && ok(line.text, line.contains) ? line.text : null;
  const out: { q: string; a: string }[] = [];
  for (const f of side.faq as readonly StallFaq[]) {
    const q = f.q[0];
    // The chip is shown text too (fix round 1, I1): a chip naming anything ⛔ or ❓ drops the whole entry.
    if (typeof q !== 'string' || q.trim() === '' || !ok(q)) continue;
    // M7 Step 7 (M6 final M7): each answer's declared contains count as well as the scan.
    const a = ok(f.a, f.contains) ? f.a : f.a_if_blocked !== undefined && ok(f.a_if_blocked, f.contains_if_blocked) ? f.a_if_blocked : fallback;
    if (a !== null) out.push({ q, a });
  }
  return out;
}

/**
 * A keeper's written lines for one trigger (greet, idle, farewell, correct, ...), as this player may see them (Step 1
 * review M3, for Step 9): the Protein Counter's own trigger when that variant is in use and has it, else the base
 * stall's. Each line is kept only when everything it names (its declared `contains` for that line, and every graph
 * food its words name) is ✅ under ctx.rules, with no substitutions, as
 * questions are ("Don't say 'something with beef'" never reaches a no-beef player). [] when the trigger is missing
 * or no line is safe: the screen then shows no keeper line, never a guessed one. A `{var}` is not a word here; the
 * caller checks whatever it fills in (an item name) the same way before showing it.
 */
export function keeperLines(stall: StallFile, triggerId: string, ctx: MarketCtx): string[] {
  const side = sideOf(stall, stallVariant(stall, ctx));
  const trigger = Object.hasOwn(side.triggers, triggerId)
    ? side.triggers[triggerId]
    : Object.hasOwn(stall.triggers, triggerId)
      ? stall.triggers[triggerId]
      : undefined;
  if (trigger === undefined) return [];
  // The line's declared ids (fix round 1, Task 5 ruling 1) and everything the graph finds in its words.
  return trigger.lines.filter((line, i) => {
    if (typeof line !== 'string' || line.trim() === '') return false;
    const declared = trigger.contains !== undefined && Object.hasOwn(trigger.contains, String(i)) ? trigger.contains[String(i)] : [];
    return namedStatus(declared, [line.replace(/\{\w+\}/g, ' ')], ctx) === 'ok';
  });
}
