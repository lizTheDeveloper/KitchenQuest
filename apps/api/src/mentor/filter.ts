/**
 * The output filter (spec §7.6b.5, spike §6.5, pre-flight C2/C3): every piece of
 * model text passes here before the player sees it. A failure is replaced by a
 * written line (`REPLACEMENT`), never shown. The model can never write and can
 * never verify a dish, so a claim of either fails, except in a short fixed list
 * of negated phrasings; a loose "any negation in the sentence" test is never used.
 */

export type FilterFail =
  | 'empty'
  | 'truncated'
  | 'markdown'
  | 'banned_word'
  | 'safety_claim'
  | 'write_claim'
  | 'sells'
  | 'medical_dose'
  | 'eat_less_praise';

/**
 * The trigger that replaces a failed reply. `safety_claim` falls back to
 * `didnt_understand` when the context has no dish and no rule (pre-flight
 * C34); the turn decides that.
 */
export const REPLACEMENT: Readonly<Record<FilterFail, string>> = Object.freeze({
  empty: 'didnt_understand',
  truncated: 'didnt_understand',
  markdown: 'didnt_understand',
  banned_word: 'didnt_understand',
  safety_claim: 'rule.severe_label_reminder',
  write_claim: 'write.not_done',
  sells: 'allowance.explain',
  medical_dose: 'rule.medical_deflect',
  eat_less_praise: 'didnt_understand',
});

/** 7.6b.5's limit. */
const MAX_SENTENCES = 3;
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

export const MARKDOWN = /(\*\*|__|`|^#{1,6}\s|^\s*[-*]\s|\[[^\]]+\]\([^)]+\))/m;
/** voice.md §0.2–0.3 and §7. */
export const BANNED_WORDS =
  /\b(exotic|ethnic|weird|strange|unusual|discover(ed|s)?|unlock(ed|s)?|loot(ed)?|collect(ed)?|acquired?|guilt-free|cheat day|junk food|clean eating|sinful|skipped a meal|streaks?|authentic|broken english)\b/i;
export const SAFETY_CLAIM = /\b(safe|nut-free|allergen-free|gluten-free|dairy-free|guarantee[ds]?)\b/i;
/** The only safety sentence that passes: a refusal to call it safe. */
export const SAFE_OK = /\b(can'?t|cannot|won'?t|never) (promise|guarantee|say|tell you|be sure)[^.?!]{0,40}\bsafe\b/i;
/** Verb forms of a write (pre-flight C3). */
export const WRITE_CLAIM =
  /\b(log(ged|ging)|sav(ed|ing)|stamp(ed|ing)|fil(ed|ing)|record(ed|ing)|remov(ed|ing)|add(ed|ing)|updat(ed|ing)|schedul(ed|ing)|struck|inked|taken the liberty|on file|in the ledger)\b/i;
/** The only write words that pass: "nothing's been saved", "once you tap …", "show you the card". */
export const WRITE_OK =
  /\b(isn'?t|not|nothing'?s?|nothing has) (been |yet )?(yet )?(saved|logged|stamped|filed|written( down)?)\b|\bonce you (tap|stamp)\b[^.?!]*|\bshow you the card\b/i;
export const SELLS = /\b(guild|subscription|subscribe|premium|upgrade|membership)\b|\$\s?\d|£\s?\d/i;
export const MEDICAL_DOSE = /\b\d+(\.\d+)?\s?(mg|mcg|ml|milligrams?)\b/i;
export const PRAISE = /\b(proud|well done|good job|nice work|great)\b/i;
export const LESS = /\b(only|skip\w*|less|light|nothing but|just (a |one )?(coffee|tea))\b/i;
export const IM_A_PAN = /\bi'?m a pan\b/i;

const global = (re: RegExp) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
/** Curly apostrophes read as straight ones, so "can’t" is "can't". Same length, so match offsets agree. */
const straight = (s: string) => s.replace(/[‘’‛]/g, "'");

/** The sentence claims safety, other than inside a SAFE_OK refusal. */
function claimsSafety(sentence: string): boolean {
  if (!SAFETY_CLAIM.test(sentence)) return false;
  const rest = sentence.replace(global(SAFE_OK), ' ');
  return rest === sentence || SAFETY_CLAIM.test(rest);
}

/** The sentence has a write word that no WRITE_OK phrase holds whole. */
function claimsWrite(sentence: string): boolean {
  const ok = [...sentence.matchAll(global(WRITE_OK))].map((m) => [m.index, m.index + m[0].length] as const);
  return [...sentence.matchAll(global(WRITE_CLAIM))].some(
    (m) => !ok.some(([from, to]) => from <= m.index && m.index + m[0].length <= to),
  );
}

const SENTENCE_CHECKS: readonly [FilterFail, (s: string) => boolean][] = [
  ['banned_word', (s) => BANNED_WORDS.test(s)],
  ['safety_claim', claimsSafety],
  ['write_claim', claimsWrite],
  ['sells', (s) => SELLS.test(s)],
  ['medical_dose', (s) => MEDICAL_DOSE.test(s)],
  ['eat_less_praise', (s) => PRAISE.test(s) && LESS.test(s)],
];

/**
 * Checks the model's reply, sentence by sentence (every sentence, before any is
 * cut). A reply that passes keeps at most three sentences, and loses those
 * saying "I'm a pan" when the previous Pan reply said it too.
 */
export function filterReply(
  text: string,
  opts: { finish: 'stop' | 'tool_calls' | 'length' | 'other'; previousPanText: string | null },
): { ok: true; text: string } | { ok: false; reason: FilterFail } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (opts.finish === 'length') return { ok: false, reason: 'truncated' };
  if (MARKDOWN.test(trimmed)) return { ok: false, reason: 'markdown' };
  const sentences = trimmed.split(SENTENCE_SPLIT).filter((s) => s !== '');
  for (const [reason, fails] of SENTENCE_CHECKS) {
    if (sentences.some((s) => fails(straight(s)))) return { ok: false, reason };
  }
  let kept = sentences;
  if (opts.previousPanText !== null && IM_A_PAN.test(straight(opts.previousPanText)) && IM_A_PAN.test(straight(trimmed))) {
    kept = kept.filter((s) => !IM_A_PAN.test(straight(s)));
  }
  kept = kept.slice(0, MAX_SENTENCES);
  if (kept.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, text: kept.join(' ') };
}
