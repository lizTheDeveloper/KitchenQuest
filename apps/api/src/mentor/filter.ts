/**
 * The output filter (spec §7.6b.5, spike §6.5, pre-flight C2/C3): every piece of
 * model text passes here before the player sees it. A failure is replaced by a
 * written line (`REPLACEMENT`), never shown. The model can never write and can
 * never verify a dish, so a claim of either fails, except in a short fixed list
 * of negated phrasings; a loose "any negation in the sentence" test is never used.
 * Since fix round 1 the turn shows no model text at all on a health turn (R1)
 * and screens the rest with `touchesHealth` (R2); this filter is the second layer.
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
/** A longer reply loses sentences from the end until it fits (fix round 1, I6). */
const MAX_CHARS = 400;
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

const MARKDOWN = /(\*\*|__|`|^#{1,6}\s|^\s*[-*]\s|\[[^\]]+\]\([^)]+\))/m;
/** voice.md §0.2–0.3 and §7. */
const BANNED_WORDS =
  /\b(exotic|ethnic|weird|strange|unusual|discover(ed|s)?|unlock(ed|s)?|loot(ed)?|collect(ed)?|acquired?|guilt-free|cheat day|junk food|clean eating|sinful|skipped a meal|streaks?|authentic|broken english)\b/i;
const SAFETY_CLAIM = /\b(safe|nut-free|allergen-free|gluten-free|dairy-free|guarantee[ds]?)\b/i;
/**
 * The only safety sentences that pass: a refusal whose object is the safety
 * itself, as one closed phrase with no clause break ("I can't promise it's
 * safe"; never "I can't tell you how happy I am; the frijoles are safe").
 */
const SAFE_OK =
  /\b(i )?(can'?t|cannot|won'?t|never) (promise|guarantee|say|tell you|be sure)( that)? (it'?s|it is|this is|that'?s|that is|they'?re|they are|anything is|any (dish|food) is) safe\b/i;
/** Verb forms of a write (pre-flight C3, fix round 1 C2). */
const WRITE_CLAIM =
  /\b(log(ged|ging)|sav(ed|ing)|stamp(ed|ing)|fil(ed|ing)|record(ed|ing)|remov(ed|ing)|add(ed|ing)|updat(ed|ing)|schedul(ed|ing)|not(ed|ing)|stor(ed|ing)|written|wrote|remember(ed|ing)?|struck|inked|taken the liberty|on file|in the ledger|in place|all set|got it down|on (your|the) list|set up)\b/i;
/** Negated write words that pass: "nothing's been saved", "isn't stored yet". */
const WRITE_NEGATED =
  /\b(isn'?t|not|nothing'?s?|nothing has) (been |yet )?(yet )?(saved|logged|stamped|filed|noted|stored|recorded|written( down)?)\b|\bshow you the card\b/i;
/** "Once you tap the card, it's filed": at most 30 characters on, holding one write word only. */
const ONCE_YOU_TAP = /\bonce you (tap|stamp)\b[^.?!;]{0,30}/i;
const SELLS = /\b(guild|subscription|subscribe|premium|upgrade|membership)\b|\$\s?\d|£\s?\d/i;
const MEDICAL_DOSE = /\b\d+(\.\d+)?\s?(mg|mcg|ml|milligrams?)\b/i;
const PRAISE = /\b(proud|well done|good job|nice work|great)\b/i;
const LESS = /\b(only|skip\w*|less|light|nothing but|just (a |one )?(coffee|tea))\b/i;
const IM_A_PAN = /\bi'?m a pan\b/i;

/** R2: medicines, and words about whether food is safe or fits a rule. */
const MEDICINE_WORDS = /\b(antihistamines?|benadryl|ibuprofen|paracetamol|tablets?|pills?|epi-?pens?|doses?|mg)\b/i;
const FIT_WORDS = /\b(safe|unsafe|fine for|ok(ay)? for|good for you|[a-z]+-free|allerg\w*|avoid\w*|contain\w*|react\w*)\b/i;

const global = (re: RegExp) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
/** Curly apostrophes read as straight ones, so "can’t" is "can't". Same length, so match offsets agree. */
const straight = (s: string) => s.replace(/[‘’‛]/g, "'");

/** The sentence claims safety, other than inside a SAFE_OK refusal. */
function claimsSafety(sentence: string): boolean {
  if (!SAFETY_CLAIM.test(sentence)) return false;
  const rest = sentence.replace(global(SAFE_OK), ' ');
  return rest === sentence || SAFETY_CLAIM.test(rest);
}

/** The sentence has a write word that no negated phrase, and no short "once you tap" clause with only it, holds whole. */
function claimsWrite(sentence: string): boolean {
  const ok = [...sentence.matchAll(global(WRITE_NEGATED))].map((m) => [m.index, m.index + m[0].length] as const);
  const writes = [...sentence.matchAll(global(WRITE_CLAIM))];
  for (const m of sentence.matchAll(global(ONCE_YOU_TAP))) {
    const inside = writes.filter((w) => m.index <= w.index && w.index + w[0].length <= m.index + m[0].length);
    if (inside.length <= 1) ok.push([m.index, m.index + m[0].length] as const);
  }
  return writes.some((m) => !ok.some(([from, to]) => from <= m.index && m.index + m[0].length <= to));
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
  while (kept.length > 1 && kept.join(' ').length > MAX_CHARS) kept = kept.slice(0, -1);
  if (kept.length === 0) return { ok: false, reason: 'empty' };
  if (kept[0].length > MAX_CHARS) return { ok: false, reason: 'truncated' };
  return { ok: true, text: kept.join(' ') };
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * R2 (fix round 1): on a turn that is not a health turn, model text that names
 * one of the player's rule words, the dish on screen, a medicine, or whether
 * food is safe or fits is never shown; the turn says the scripted
 * `mentor.check_card` line instead. `words` are lower-case names (rule
 * targets, their kinds and aliases, rule-term phrases, the dish title).
 */
export function touchesHealth(text: string, words: readonly string[]): boolean {
  const t = straight(text).toLowerCase();
  if (MEDICINE_WORDS.test(t) || FIT_WORDS.test(t)) return true;
  return words.some((w) => {
    const forms = [w, `${w}s`, `${w}es`, ...(w.endsWith('s') ? [w.slice(0, -1)] : [])].filter((f) => f.trim() !== '');
    return forms.some((f) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(f)}(?=$|[^\\p{L}\\p{N}])`, 'u').test(t));
  });
}
