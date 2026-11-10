import { canonicalText, foldConfusables } from '@kitchenquest/core';

/**
 * The screen for model-sourced strings on cards (spec §7.6b.5, spike §6.5,
 * pre-flight C2/C3, fix round 2 R5). Ruling R9 (fix round 4): the model's free
 * text is never shown to any player, so the only model strings a player can see
 * are card fields (a rule term, a region, a meal description, a pantry item),
 * and each must pass `filterReply` and `touchesHealth`. The model can never
 * write and can never verify a dish, so a claim of either fails, except in a
 * short fixed list of negated phrasings; a loose "any negation" test is never used.
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

/** A longer string fails as `truncated` (fix round 1, I6). */
const MAX_CHARS = 400;
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

const MARKDOWN = /(\*\*|__|`|^#{1,6}\s|^\s*[-*]\s|\[[^\]]+\]\([^)]+\))/m;
/** voice.md §0.2–0.3 and §7. */
const BANNED_WORDS =
  /\b(exotic|ethnic|weird|strange|unusual|discover(ed|s)?|unlock(ed|s)?|loot(ed)?|collect(ed)?|acquired?|guilt-free|cheat day|junk food|clean eating|sinful|skipped a meal|streaks?|authentic|broken english)\b/i;
/** Safety words, any "-free", a digit for a letter ("s4fe") and "fine for your …" (fix round 1 probe). */
const SAFETY_CLAIM =
  /\b(s[a@4]fe|[a-z]+-free|free of|guarantee[ds]?|(fine|ok|okay|alright|good) (for|with) (you|your)|harmless|in the clear|won'?t (hurt|harm|bother|react|affect)|you won'?t react|(nothing|none) in (this|it|there|here)\b[^.!?]{0,30}\b(bother|hurt|harm|affect|fret|worry)|(aren'?t|isn'?t|is no|are no|not any|zero) \w+ in (this|it|there|here)|good to go|go for it|no worries|nothing to (worry|fret)|(no|not a) problem|no need to worry|eat anything|enjoy it freely|fret)\b/i;
/**
 * The only safety sentences that pass: a refusal whose object is the safety
 * itself, as one closed phrase with no clause break ("I can't promise it's
 * safe"; never "I can't tell you how happy I am; the frijoles are safe").
 */
const SAFE_OK =
  /\b(i )?(can'?t|cannot|won'?t|never) (promise|guarantee|say|tell you|be sure)( that)? (it'?s|it is|this is|that'?s|that is|they'?re|they are|anything is|any (dish|food) is) safe\b/i;
/**
 * Write claims (pre-flight C3, fix rounds 1–3): write verbs in any tense, first-person
 * action frames ("I'll keep that in mind", "I've got that down"), bare "done", "sorted",
 * "dealt with", "from now on", and indirect ones ("your market day is now …").
 */
const WRITE_CLAIM =
  /\b(sav(e|es|ed|ing)|log(s|ged|ging)?|add(s|ed|ing)?|remov(e|es|ed|ing)|delet(e|es|ed|ing)|clear(s|ed|ing)?|mark(s|ed|ing)?|record(s|ed|ing)?|not(e|es|ed|ing)|stor(e|es|ed|ing)|lock(ed|s)? in|jot(s|ted|ting)?|pencil(l?ed|l?ing|s)?( in)?|tick(s|ed|ing)?( off)?|cross(es|ed|ing)? off|stamp(s|ed|ing)?|fil(e|es|ed|ing)|updat(e|es|ed|ing)|schedul(e|es|ed|ing)|written|wrote|remember(s|ed|ing)?|struck|inked|taken the liberty|on file|in the ledger|in place|all set|got (it|that|this) down|on (your|the) list|off (your|the) list|set up|chang(ed|ing)|switch(ed|ing)|mov(ed|ing) your|made a note|consider it done|that'?s (done|in)|all done|(?<!well )done( and dusted)?|sorted|dealt with|from now on|put\b[^.!?]{0,30}\bdown|t(aken|ook|ake|aking)\b[^.!?]{0,30}\bout of|gone from|your [\w' ]{0,30}\b(is|are) now|i('ve| have|'ll| will|'m going to| am going to|'d| would) (now |just |go ahead and )?(keep|put|set|get|got|take|make|handle|sort|deal|pop|stick|leave|have|make)\b)\b/i;
/** "Your pantry is empty now", "your rule is gone", "your profile now says …": a record the model claims changed. */
const RECORD_STATE =
  /\byour (\w+ )?(pantry|list|profile|rules?|card|cupboard|ledger|market day|schedule|log|file|record)s?\b[^.!?]{0,30}\b(now|gone|empty|clear|cleared|says|has|reads|shows|updated|done)\b|\b(is|are|'s) (now )?(in|on) (your|the) (\w+ )?(list|cupboard|pantry|card|file|ledger|profile)\b|\bon it now\b/i;
/** Negated write words that pass: "nothing's been saved", "isn't stored yet". */
const WRITE_NEGATED =
  /\b(isn'?t|not|nothing'?s?|nothing has) (been |yet )?(yet )?(saved|logged|stamped|filed|noted|stored|recorded|written( down)?)\b|\bshow you the card\b/i;
/** "Once you tap the card, it's filed": at most 30 characters on, holding one write word only. */
const ONCE_YOU_TAP = /\bonce you (tap|stamp)\b[^.?!;]{0,30}/i;
const SELLS = /\b(gu[i1l!|]ld|subscription|subscribe|premium|upgrade|membership)\b|\$\s?\d|£\s?\d/i;
const MEDICAL_DOSE = /\b\d+(\.\d+)?\s?(mg|mcg|ml|milligrams?)\b|\b(antihistamines?|benadryl|ibuprofen|paracetamol|acetaminophen|aspirin|piriton|cetirizine|loratadine|zyrtec|claritin|gaviscon|rennie|calpol|nurofen|epi[- ]?pens?)\b/i;
const PRAISE = /\b(proud|well done|good job|nice work|great)\b/i;
const LESS = /\b(only|skip\w*|less|light|nothing but|just (a |one )?(coffee|tea))\b/i;

/** Medicines, and words about whether food is safe or fits a rule. */
const MEDICINE_WORDS =
  /\b(antihistamines?|benadryl|ibuprofen|paracetamol|tablets?|pills?|epi[- ]?pens?|doses?|mg|piriton|zyrtec|claritin|cetirizine|loratadine|gaviscon|rennie|calpol|nurofen|aspirin)\b/i;
const FIT_WORDS =
  /\b(safe|unsafe|fine for|ok(ay)? for|alright for|good for you|[a-z]+-free|free of|allerg\w*|avoid\w*|contain\w*|react\w*|bother\w*|harm\w*|hurt\w*|in the clear|upset\w*|tuck in|dig in)\b/i;

const global = (re: RegExp) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
/** Curly apostrophes read as straight ones, so "can’t" is "can't". Same length, so match offsets agree. */
const straight = (s: string) => s.replace(/[‘’‛]/g, "'");
/**
 * R7 (fix round 2): every filter and screen reads text through core's
 * canonical form (NFKC, invisible characters dropped, capped at MAX_TEXT) with
 * lookalikes folded ("ѕafe", "ｐｅａｎｕｔｓ", "pea\u200bnuts"), then straight apostrophes.
 */
export const screenText = (s: string): string =>
  straight(foldConfusables(canonicalText(s)))
    // Letter-spaced runs read as one word ("s a f e" is "safe", fix round 3, B3).
    .replace(/\b(?:\p{L} ){2,}\p{L}\b/gu, (run) => run.replace(/ /g, ''));

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
  ['write_claim', (s) => claimsWrite(s) || RECORD_STATE.test(s)],
  ['sells', (s) => SELLS.test(s)],
  ['medical_dose', (s) => MEDICAL_DOSE.test(s)],
  ['eat_less_praise', (s) => PRAISE.test(s) && LESS.test(s)],
];

/** Checks a model-sourced string, sentence by sentence; one that passes comes back in its normalised form. */
export function filterReply(
  text: string,
  opts: { finish: 'stop' | 'tool_calls' | 'length' | 'other' },
): { ok: true; text: string } | { ok: false; reason: FilterFail } {
  const trimmed = screenText(text).trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (opts.finish === 'length') return { ok: false, reason: 'truncated' };
  if (MARKDOWN.test(trimmed)) return { ok: false, reason: 'markdown' };
  const sentences = trimmed.split(SENTENCE_SPLIT).filter((s) => s !== '');
  for (const [reason, fails] of SENTENCE_CHECKS) {
    if (sentences.some((s) => fails(straight(s)))) return { ok: false, reason };
  }
  if (trimmed.length > MAX_CHARS) return { ok: false, reason: 'truncated' };
  return { ok: true, text: sentences.join(' ') };
}

/** R5: a card string that names a medicine, or whether food is safe or fits, never reaches a card. */
export function touchesHealth(text: string): boolean {
  const t = screenText(text).toLowerCase();
  return MEDICINE_WORDS.test(t) || FIT_WORDS.test(t);
}
