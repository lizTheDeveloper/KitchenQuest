// M7 Ruling 4 (§7.6): the heard check, the safety gate for speech. Any transcript naming a graph food, a rule term or
// (with health wording) a sound-alike of one is stopped by a heard card showing the words as heard, spelled, with the
// foods they may have been. Only a tap confirms it (`heardConfirmed`); nothing reaches a rule, a card or the model
// before. Speech-to-text output is untrusted user text (§7.6): it is stripped of page events first. Browser-safe.
import { IngredientGraph } from '../ingredients/graph';
import { pluralForms, words } from '../ingredients/mentions';
import { foldConfusables, HEALTH_PATTERN, MAX_TEXT, normalizeText, stripPageEventsFull } from '../mentor/intents';
import { ALLERGY_NEGATIONS, DIET_WORD_PATTERN, RULE_TRIGGER_PATTERN, SEVERITY_PATTERNS, severityFromText } from '../mentor/parse';
import type { LineRef } from '../mentor/cards';
import { listWords } from '../mentor/outcomes';
import type { RuleTerm } from '../mentor/rule-terms';
import { spell } from '../mentor/spell';
import { MAX_ALTERNATIVES } from './constants';
import { allergenEchoes, rankSoundAlikes, termId, type SoundAlike } from './phonetic';
import { COMMAND_WORDS } from './commands';
import { codePoints } from './wire';
import type { HeardCheck, HeardTerm } from './heard-types';

export type { HeardCheck, HeardTerm } from './heard-types';

/**
 * Words that never start a sound-alike term by themselves: function words, common verbs, and the health, symptom,
 * cooking and command words a health-worded utterance carries. A stop word still counts inside an exact food name.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    // function words
    'the a an and or but nor so yet for of to in on at by from with without into onto over under about above below ' +
    'up down out off as than then there here this that these those it its it\'s they them their theirs we us our ours ' +
    'you your yours he him his she her hers i me my mine im ive id ill not no nor nope yes yeah yep ok okay oh ah um uh ' +
    'is are was were be been being am do does did doing done have has had having can could will would shall should may ' +
    'might must just very really quite too also even still only all any some each every both few more most much many ' +
    'what which who whom whose when where why how if whether because while until after before again once ever never ' +
    'one two three four five six seven eight nine ten lot lots bit little way thing things stuff something anything ' +
    'nothing everything someone anyone please thanks thank cheers sorry well now today tonight tomorrow yesterday ' +
    // people
    'son sons daughter daughters kid kids child children baby wife husband partner friend friends mum mom dad family ' +
    'people guest guests ' +
    // common verbs
    'get gets got getting give gives gave given make makes made making take takes took go goes went gone going come ' +
    'comes came put puts say says said tell told know knew think thought want wants need needs like likes liked love ' +
    'carry carries carried loves hate hates eat eats eating ate eaten drink drinks try tried keep keeps let lets use used using cook cooking ' +
    'cooked feel feels felt seem seems look looks find found turn turns start stop wait read cause causes caused ' +
    // health, symptom and rule words
    'allergic allergy allergies allergen allergens intolerant intolerance intolerances anaphylactic anaphylaxis ' +
    'sensitive sensitivity reaction reactions react reacts diet dietary avoid avoiding coeliac celiac vegan vegetarian ' +
    'sick ill unwell poorly ache aches pain rash hives itchy itch swollen swelling stomach tummy belly gut bloated ' +
    'bloating upset throat skin lips mouth breathe breathing hospital doctor severe severely mild mildly bad badly ' +
    'worse fine safe unsafe free friendly ' +
    // meals, cooking and commands
    'food foods meal meals breakfast lunch dinner supper snack snacks dish dishes recipe recipes step steps next back ' +
    'repeat timer minutes minute seconds hour hours heat pan pot oven stir chop'
  ).split(/\s+/),
);

const isStop = (w: string): boolean => STOP_WORDS.has(w) || /\d/.test(w) || [...w].length < 3;

/** Meal and mealtime words: HEALTH_PATTERN over-catches them on purpose (for the model gate), but alone they are cook chatter. */
const MEAL_ONLY = /^(?:ate|eaten|had|breakfast|brekkie|lunch|dinner|supper|snack\w*)$/;

/**
 * Symptom and reaction words (fix round 3, R1): a closed list, the heard check's own (the shared mentor HEALTH_PATTERN
 * is unchanged). "I ate selfish and got sick" is a reaction report, never chatter, so it is health wording whatever
 * meal word it carries. These are unambiguous: they count anywhere (threw up, vomit, hives, rash, couldn't breathe,
 * wheezing, nauseous, ...).
 */
const SYMPTOM_PATTERN =
  /\b(?:sickness|illness|unwell|poorly|nause\w*|queasy|rash(?:es)?|hives|itch(?:y|ed|es|iness)|swelled|swollen|tingl\w*|threw up|thrown up|vomit\w*|puk(?:e|ed|es|ing)|(?:felt|feel|feels|feeling) (?:ill|sick|unwell|queasy|faint|dizzy)|felt (?:awful|terrible|rough|funny|horrible|weird|off)|(?:couldn'?t|could not|can'?t|cannot) breathe?|breathless|short of breath|wheez\w*|stomach ?aches?|stomach (?:hurt\w*|pains?|cramps?)|tummy ?aches?|belly ?aches?|cramp(?:s|ed|ing)?|(?:lips?|tongue|throat|mouth|face) (?:(?:went|felt|got|was|were|is|are|goes) )?(?:funny|tingly|numb|swollen|itchy|weird|puffy)|(?:use|used|needed) (?:my|her|his|their|the) (?:pen|epi\w*|inhaler)|inhaler|diarrh\w*|dizziness|dizzy spells?|faint(?:ed|ing))\b/;

/** Body words a reaction shows on (not hands: "my hands are numb from the cold" is chatter). */
const BODY = '(?:lips?|tongue|throat|mouth|face|eyes?|gums|cheeks?|skin|neck|ears?)';
/** A modifier between a be, feel or get form and the symptom ("was really sick"). */
const DEG = '(?:(?:so|very|really|quite|properly|violently|seriously|terribly|badly|a bit|a little|all)\\s+)?';
const BE_GET = '(?:was|were|been|being|be|got|get|gets|getting|went|go|goes|going|fell|falls|felt|feel|feels|feeling|became|become|becomes|turned)';
const PERSON_IS = "(?:i'?m|i am|he'?s|she'?s|they'?re|we'?re|you'?re|(?:he|she|they|we|you|son|daughter|kid|child|baby|wife|husband|partner|friend|mum|mom|dad) (?:is|are|am))";
const CAUSE = '(?:made|makes|make|making)\\s+(?:me|him|her|them|us|you|my \\w+)\\s+(?:feel\\s+)?';

/**
 * Fix round 4 (F2): symptom words that also have a cooking sense ("the dough will swell", "break out the wok", "the
 * Maillard reaction", "this sauce is sick", "a faint smell") count only in a body or self context. When in doubt a
 * context counts: over-asking is safe.
 */
const SYMPTOM_IN_CONTEXT: readonly RegExp[] = [
  // swell: after a body word, or "my/her/his ... swell up" (swelled and swollen count anywhere)
  new RegExp(`\\b${BODY}(?: \\w+){0,3} swell\\w*`),
  /\b(?:my|her|his|their|i|he|she|they|we|you)(?:'\w+)?(?: \w+)? swell(?:s|ing)? up\b/,
  // fix round 5 (G1): "swell up after selfish" (after/from only: "the beans swell up when soaked" is chatter)
  /\bswell(?:s|ing)? up (?:after|from)\b/,
  // break out in / after; come up in hives, a rash, spots, lumps or welts
  /\b(?:break|breaks|breaking|broke|broken) out (?:in|into|after|from|all over)\b/,
  /\b(?:came|come|comes|coming) up in (?:\w+ )?(?:hives|rash\w*|spots?|lumps?|welts?|bumps?|blotch\w*|blisters?)\b/,
  // sick, ill: after a be, feel or get form, a person and is/am/are, a cause ("made me"), or before after/from;
  // never "sick of"
  new RegExp(`\\b${BE_GET}\\s+${DEG}(?:sick|ill)\\b(?! of\\b)`),
  new RegExp(`${PERSON_IS}\\s+${DEG}(?:sick|ill)\\b(?! of\\b)`),
  new RegExp(`\\b${CAUSE}(?:sick|ill)\\b(?! of\\b)`),
  /\b(?:sick|ill) (?:after|from|with|again|all night|all day)\b/,
  // reaction: (bad/allergic/a) reaction, or reaction to/after/from; react(ed) to/badly/after, or at a clause end
  /\b(?:bad|allergic|severe|serious|nasty|mild|big|awful|terrible|horrible|skin|another|a|an|same|my|his|her|their) reactions?\b/,
  /\breactions? (?:to|after|from)\b/,
  /\breact(?:s|ed|ing)?(?=\s+(?:to|badly|severely|strongly|after|from|again|really|terribly|straight|immediately|instantly)\b|\s*(?:[,.;:!?]|$))/,
  // faint: felt/went/almost faint (fainted counts anywhere); never "a faint smell"
  /\b(?:felt|feel|feels|feeling|went|go|goes|going|almost|nearly|might|could|would|gonna) (?:(?:a bit|a little|really|so|very) )?faint\b/,
  // fix round 5 (G1): "selfish makes me faint"; "the selfish is making me dizzy" (a noun subject, never
  // it/this/that/all: "it's making me dizzy, all this stirring"); "selfish leaves me feeling awful"
  /\b(?:made|makes|make|making) (?:me|him|her|them|us) (?:feel )?(?:(?:a bit|really|so|very) )?faint\b/,
  /\b(?!(?:it|this|that|all)\b)[a-z]+ (?:is|are|was|were|keeps|kept) making (?:me|him|her|them|us) (?:feel )?(?:(?:a bit|really|so|very) )?(?:dizzy|sick|ill|faint)\b(?! of\b)/,
  /\b(?:leaves|left|leave|leaving) (?:me|him|her|them|us) (?:feeling )?(?:awful|bad|terrible|rough|sick|ill|dizzy|funny|horrible|faint)\b/,
  // itch: after a body word, or itch(ing) but never "itching to"
  new RegExp(`\\b${BODY}(?: \\w+){0,2} itch\\w*`),
  /\bitch(?:ing)?\b(?!\s+to\b)/,
  // numb: after a body word, or went/felt/gets numb
  new RegExp(`\\b${BODY}(?: \\w+){0,2} numb\\b`),
  /\b(?:went|go|goes|gone|going|felt|feel|feels|feeling|got|gets|getting) (?:(?:all|really|a bit|so) )?numb\b/,
  // throw up with no object after it ("I'll throw up the lid" is not)
  /\bthrow(?:s|ing)? up\b(?!\s+(?:the|a|an|some|your|my|his|her|their|our|this|that|these|those|it|them|its)\b)/,
  // dizzy: after a be, feel or get form, a person, a past or plain cause ("made me"), or before after/from
  new RegExp(`\\b(?:${BE_GET}|am|is|i'?m|he'?s|she'?s|(?:made|makes|make) (?:me|him|her|them|us))\\s+${DEG}dizzy\\b`),
  /\bdizzy (?:after|from|again)\b/,
  // feel bad, awful, ...: with a cause, before after/from, or with eating in the text ("felt bad, I burned it" is not)
  new RegExp(`\\b${CAUSE}(?:bad|awful|terrible|rough|funny|horrible|weird|off)\\b`),
  /\b(?:felt|feel|feels|feeling) (?:bad|awful|terrible|rough|funny|horrible|weird|off) (?:after|from|since|when|whenever|every time)\b/,
];
/** A present-tense "feel awful" (and any "feel bad") is health wording when eating is in the text. */
const FEEL_MOOD = /\b(?:felt|feel|feels|feeling) (?:bad|awful|terrible|rough|funny|horrible|weird|off)\b/;
const EATING = /\b(?:ate|eaten|eat|eats|eating|had|having|drank|drunk|drink|drinking)\b/;

/**
 * Health wording (Ruling 4), read on the normal form: the mentor's health, rule-trigger, diet and severity patterns,
 * plus symptom and reaction words (fix round 3, R1; fix round 4, F2: a cooking-sense word in a body or self context
 * only). A meal word alone ("what's for dinner", "I had toast") is not health wording (fix round 2, N5), but a meal
 * word with a symptom word is. Without health wording a transcript gets a heard card only for a food or rule term it
 * names (or after an exclusion opener: `heardCheck`).
 */
export function hasHealthWording(normal: string): boolean {
  const health = new RegExp(HEALTH_PATTERN.source, 'g');
  return (
    SYMPTOM_PATTERN.test(normal) ||
    SYMPTOM_IN_CONTEXT.some((p) => p.test(normal)) ||
    (FEEL_MOOD.test(normal) && EATING.test(normal)) ||
    [...normal.matchAll(health)].some((m) => !MEAL_ONLY.test(m[0])) ||
    normal.search(RULE_TRIGGER_PATTERN) >= 0 ||
    normal.search(DIET_WORD_PATTERN) >= 0 ||
    // a bare "swell up" (the shared anaphylactic cue) is read in context above: "the rice will swell up" is chatter
    SEVERITY_PATTERNS.some(([p]) => p.test(normal.replace(/\bswell(?:s|ing)? up\b/g, ' ')))
  );
}

interface Phrases {
  /** normalised phrase → id (graph id or `term:<name>`), graph names winning a tie */
  map: Map<string, string>;
  longest: number;
}
const phraseCache = new WeakMap<IngredientGraph, WeakMap<readonly RuleTerm[], Phrases>>();

/** Every graph label and rule-term phrase, with plural forms, as `words` normalises them (what `textMentions` matches). */
function phrasesOf(graph: IngredientGraph, terms: readonly RuleTerm[]): Phrases {
  let byTerms = phraseCache.get(graph);
  if (byTerms === undefined) phraseCache.set(graph, (byTerms = new WeakMap()));
  const cached = byTerms.get(terms);
  if (cached !== undefined) return cached;
  const map = new Map<string, string>();
  let longest = 1;
  const add = (label: string, id: string): void => {
    const key = words(label).trim();
    if (key === '') return;
    longest = Math.max(longest, key.split(' ').length);
    for (const form of pluralForms(key)) if (!map.has(form)) map.set(form, id);
  };
  for (const label of graph.labels()) add(label, graph.resolve(label)!);
  for (const term of terms) for (const p of term.phrases) add(p, termId(term));
  const out = { map, longest };
  byTerms.set(terms, out);
  return out;
}

interface Token {
  word: string;
  start: number;
  end: number;
  /** Inside a rule trigger, a negation or a severity cue (`exemptSpans`): never a sound-alike term, bar one case. */
  exempt: boolean;
  /** Starts exactly where a rule trigger ends: the term position ("allergic to |so"). */
  afterTrigger: boolean;
  /** A clause break (, . ; : ! ?) comes before this word. */
  broken: boolean;
  /** Which break: the last punctuation mark before this word, or null. A comma continues a list (N8). */
  brk: string | null;
  /** An "&" comes before this word: it joins list items as "and" does (fix round 4, F1). */
  amp: boolean;
}

function tokensOf(normal: string): Token[] {
  const spans = exemptSpans(normal);
  const triggerEnds = new Set([...normal.matchAll(new RegExp(RULE_TRIGGER_PATTERN.source, 'g'))].map((m) => m.index + m[0].length));
  const out: Token[] = [];
  let brk: string | null = null;
  let amp = false;
  for (const m of normal.matchAll(/[\p{L}\p{N}]+|[,.;:!?&]/gu)) {
    // a sentence or clause end outranks a comma between the same two words
    if (m[0] === '&') amp = true;
    else if (/^[,.;:!?]$/.test(m[0])) brk = brk !== null && brk !== ',' ? brk : m[0];
    else {
      const [start, end] = [m.index, m.index + m[0].length];
      out.push({ word: m[0], start, end, broken: brk !== null, brk, amp, exempt: spans.some(([a, b]) => a < end && start < b), afterTrigger: triggerEnds.has(start) });
      brk = null;
      amp = false;
    }
  }
  return out;
}

/**
 * [start, end) of the words whose swap would change what the rule parsers read: rule triggers ("allergic to",
 * "can't eat"), allergy negations and severity cues ("allerg", "epipen", "deadly", "almost died"). These were heard
 * as what they are, so they are never sound-alike terms (fix round 1, I3). Fix round 2 (N2): only these; meal, diet
 * and symptom words are ordinary words again, so "allergic to dietary" (dairy) and "allergic to ate" (oat) ask.
 */
function exemptSpans(normal: string): [number, number][] {
  const patterns = [RULE_TRIGGER_PATTERN, ALLERGY_NEGATIONS, ...SEVERITY_PATTERNS.map(([p]) => p)];
  const out: [number, number][] = [];
  for (const p of patterns)
    for (const m of normal.matchAll(new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`)))
      if (m[0].length > 0) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Words that join the items of a list ("nuts and so", "nuts or it", "nuts plus so"); "&" is the token flag `amp`. */
const LIST_JOINS: ReadonlySet<string> = new Set(['and', 'or', 'plus']);

/** Words that may come before a clause-initial opener, and the subjects of "[I] can't do". */
const OPENER_LEADS: ReadonlySet<string> = new Set(['ok', 'okay', 'oh', 'and', 'but', 'so', 'please', 'yeah', 'yes', 'also', 'um', 'uh', 'well', 'actually', 'just']);
const SUBJECTS: ReadonlySet<string> = new Set(['i', 'we', 'he', 'she', 'they']);

/** Cook-mode words (the command phrases, plus kitchen kit and actions) that an opener never makes a term (G2). */
const COOK_WORDS: ReadonlySet<string> = new Set([
  ...[...COMMAND_WORDS].filter((w) => !isStop(w)),
  ...'lid lids phone stir stirr stirring whisk chop chopping boil boiling simmer simmering heat pan pot oven hob timer timers alarm clock mic music radio rush hurry'.split(' '),
]);

const ARTICLES: ReadonlySet<string> = new Set(['the', 'a', 'an', 'any', 'some']);

/** "no X" idioms that are never an exclusion of a food ("no problem", "no worries"). */
const NO_IDIOMS: ReadonlySet<string> = new Set(
  'problem problems worries worry idea rush hurry clue chance bother matter need longer sense point doubt kidding joke wonder big deal fuss hassle luck difference change sign answer clue sir mate dear'.split(' '),
);

/**
 * Fix round 4: the clause-initial exclusion openers ("no", "without", "hold the", "leave out (the)", "[I] can't do"),
 * as the index of the word after the opener, or -1. Clause-initial: the first word, or the first after a break.
 * "no" counts only before a food-position word: not a stop word, not a break, not an idiom ("no thanks", "no, the
 * other one", "no problem" are no opener). The others take the same, or a 1–2 letter allergen echo ("hold the so").
 */
function openerEnd(toks: readonly Token[], i: number, echoes: (word: string) => boolean): { from: number; at: number; kind: 'no' | 'opener' } | null {
  if (i > 0 && !toks[i].broken) return null;
  const w = (k: number): string | undefined => (k < toks.length && (k === i || !toks[k].broken) ? toks[k].word : undefined);
  // a lead word may come first ("ok, no selfish", "ok no selfish", "and without selfish")
  const base = OPENER_LEADS.has(w(i) ?? '') && w(i + 1) !== undefined ? i + 1 : i;
  const k = SUBJECTS.has(w(base) ?? '') && (w(base + 1) === 'can' || w(base + 1) === 'cannot') ? base + 1 : base;
  let at = -1;
  let kind: 'no' | 'opener' = 'opener';
  if (k === base && w(k) === 'no') [at, kind] = [w(k + 1) === 'more' ? k + 2 : k + 1, 'no'];
  else if (k === base && w(k) === 'nope') [at, kind] = [k + 1, 'no'];
  else if (k === base && w(k) === 'without') at = w(k + 1) === 'the' || w(k + 1) === 'any' ? k + 2 : k + 1;
  else if (k === base && w(k) === 'hold' && w(k + 1) === 'the') at = k + 2;
  else if (k === base && w(k) === 'leave' && w(k + 1) === 'out') at = w(k + 2) === 'the' ? k + 3 : k + 2;
  else if (w(k) === 'can' && w(k + 1) === 't' && w(k + 2) === 'do') at = k + 3;
  else if (w(k) === 'cannot' && w(k + 1) === 'do') at = k + 2;
  else if (w(k) === 'can' && w(k + 1) === 'not' && w(k + 2) === 'do') at = k + 3;
  if (at < 0 || w(at) === undefined) return null;
  const word = toks[at].word;
  // a cook word is never what an opener excludes ("no lid", "hold the phone", "no more timers": G2)
  if (COOK_WORDS.has(word) || COOK_WORDS.has(word.replace(/(?:s|ing)$/, ''))) return null;
  if (kind === 'no' && (isStop(word) || NO_IDIOMS.has(word))) return null;
  // the others take a food-position word, or a short word that sounds exactly like an allergen ("hold the so")
  if (kind === 'opener' && isStop(word) && !([...word].length <= 2 && echoes(word))) return null;
  return { from: k, at, kind };
}

/**
 * The term position of every word (N2, N8, fix round 4 F1): the word right after a rule trigger or an exclusion
 * opener, and the first word of each later item of its list. An item is any word or words, a food or not ("allergic
 * to latex and so", "raw nuts and so"); the next starts past "and", "or", "plus", "&" or a comma, and the list ends at
 * a clause end. The value says what opened the list; a "no" list never takes the short-word fail-safe ("no it").
 * An opener's own words are marked exempt here.
 */
function listPositions(toks: Token[], echoes: (word: string) => boolean): ('trigger' | 'opener' | 'no' | null)[] {
  const out: ('trigger' | 'opener' | 'no' | null)[] = toks.map(() => null);
  let kind: 'trigger' | 'opener' | 'no' | null = null;
  let joined = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.brk !== null && t.brk !== ',') kind = null;
    const opener = openerEnd(toks, i, echoes);
    if (t.afterTrigger) [kind, joined] = ['trigger', false];
    else if (kind !== null && !LIST_JOINS.has(t.word) && (joined || t.brk === ',' || t.amp)) out[i] = kind;
    if (t.afterTrigger) out[i] = 'trigger';
    // an item that starts with an article ("hold the so and the nots"): the word after it is in the term position too
    if (out[i] !== null && ARTICLES.has(t.word) && i + 1 < toks.length && !toks[i + 1].broken) out[i + 1] = out[i];
    joined = kind !== null && LIST_JOINS.has(t.word);
    if (opener !== null && (kind === null || kind !== 'trigger')) {
      // the opener's own words were heard as what they are, as a trigger's are: never sound-alike terms
      for (let j = opener.from; j < opener.at; j++) toks[j].exempt = true;
      out[opener.at] = opener.kind;
      kind = opener.kind;
      joined = false;
      i = opener.at;
    }
  }
  return out;
}

/** A transcript longer than this many UTF-16 units is refused before any work (bounded cost on hostile input). */
const HARD_MAX_UNITS = MAX_TEXT * 8;

/** The phonetically closest of a ranking (which puts allergen neighbours first): what a two-word run is judged on. */
const closest = (list: readonly SoundAlike[]): SoundAlike | undefined =>
  list.reduce<SoundAlike | undefined>((m, s) => (m === undefined || s.distance < m.distance || (s.distance === m.distance && s.spelling < m.spelling) ? s : m), undefined);

const better = (a: SoundAlike, b: SoundAlike | undefined): boolean =>
  b === undefined || a.distance < b.distance || (a.distance === b.distance && a.spelling <= b.spelling);

/**
 * The heard check of a transcript, or null when it names nothing. It reads the stripped, canonical text; its terms
 * are, in text order and each heard word once:
 *  1. every graph food named (a `textMentions` hit, longest name first, so "hazel nut" is one term, not two);
 *  2. every rule term;
 *  3. with health wording only, every other word or two-word run that is not a stop word and has sound-alikes. Two
 *     words heard for one food ("pea cans", "chick pea") win over a food heard inside them only when they sound
 *     exactly like a different food.
 * Every term carries its sound-alikes as alternatives, so a real food heard for another offers the other. The heard
 * words are never corrected: `id` is what they name as heard. Rule triggers, negations and severity cues are never
 * sound-alike terms (unless one sits in the term position and sounds exactly like an allergen); a stop word is one only
 * when it sounds like a major allergen; a 1–2 letter word only in the term position on an exact allergen sound. Over MAX_TEXT (page events stripped first) it returns
 * a blocking `tooLong` check, never null: the caller refuses the turn and asks the player to type.
 */
// Contract (fix round 2, N7) for Steps 5, 6 and 9:
//  - test `check.tooLong` FIRST: a blocking check has `terms: []`, which never means "names nothing" (that is null);
//    refuse the turn and ask the player to type;
//  - apply a card choice with `tryHeardChoice(transcript, check, choice, graph)` and keep asking on any refusal;
//  - a turn's input is validated with core `parseTurnInput` (bounded, never truncated).
export function heardCheck(transcript: string, graph: IngredientGraph, terms: readonly RuleTerm[]): HeardCheck | null {
  // Fix round 1 (I2): fail closed. Page events are stripped from the whole text first, then the length is measured;
  // over MAX_TEXT the check blocks instead of reading a cut text (a food past the cap would go unseen).
  const blocked: HeardCheck = { tooLong: true, terms: [], speakSpelling: false };
  if (transcript.length > HARD_MAX_UNITS) return blocked;
  const normal = normalizeText(stripPageEventsFull(transcript).text);
  if (codePoints(normal, MAX_TEXT) > MAX_TEXT) return blocked;
  const toks = tokensOf(normal);
  const listPos = listPositions(toks, (w) => allergenEchoes(w, graph).length > 0);
  const health = hasHealthWording(normal);
  // An exclusion opener's list positions take sound-alikes as health wording would (fix round 4), but only there,
  // and the opener is no health wording: the spelling is not spoken for it (fix round 5, G2: "no salt please").
  const opened = (i: number): boolean => listPos[i] === 'opener' || listPos[i] === 'no';
  const { map, longest } = phrasesOf(graph, terms);
  const rank = new Map<string, SoundAlike[]>();
  const ranked = (phrase: string): SoundAlike[] => {
    let r = rank.get(phrase);
    if (r === undefined) rank.set(phrase, (r = rankSoundAlikes(phrase, graph, terms)));
    return r;
  };
  const exactAt = (i: number): { len: number; id: string } | null => {
    for (let len = Math.min(longest, toks.length - i); len >= 1; len--) {
      const id = map.get(toks.slice(i, i + len).map((t) => t.word).join(' '));
      if (id !== undefined) return { len, id };
    }
    return null;
  };
  /**
   * The best sound-alike of one word, if it may be a term: not health wording, and not a stop word unless it is a
   * phonetic neighbour of a major allergen ("what" / wheat, "ache" / egg: fix round 1, I1; over-asking is safe).
   */
  const soundAt = (i: number): SoundAlike | undefined => {
    const list = ranked(toks[i].word);
    // An exempt word stays out, unless it sits in the term position and sounds exactly like an allergen (N2).
    if (toks[i].exempt && !(toks[i].afterTrigger && list.some((s) => s.allergen && s.distance <= 0))) return undefined;
    if (!isStop(toks[i].word)) return closest(list);
    return list.some((s) => s.allergen) && [...toks[i].word].length >= 3 && !/\d/.test(toks[i].word) ? closest(list) : undefined;
  };
  /** Two words heard for one food, when they win over what their words name alone. */
  const pairAt = (i: number, exact: { len: number; id: string } | null): boolean => {
    if (!(health || opened(i)) || i + 1 >= toks.length || toks[i + 1].broken || toks[i].exempt || toks[i + 1].exempt) return false;
    const [a, b] = [toks[i].word, toks[i + 1].word];
    if (/\d/.test(a + b)) return false;
    const pair = ranked(`${a} ${b}`);
    const best = closest(pair);
    // With a stop word in it ("loop in"), only an exact sound counts: "my son" is not miso. Two stop words count only
    // when they sound exactly like a major allergen ("says me" / sesame: fix round 1, I1).
    if (best === undefined || ((isStop(a) || isStop(b)) && best.distance > 0)) return false;
    if (isStop(a) && isStop(b) && !pair.some((s) => s.allergen && s.distance <= 0)) return false;
    if (exact !== null) return exact.len === 1 && !isStop(a) && best.distance <= 0 && best.id !== exact.id;
    const next = exactAt(i + 1);
    if (next !== null) return next.len === 1 && !isStop(a) && best.distance <= 0 && best.id !== next.id;
    const alone = [soundAt(i), soundAt(i + 1)].reduce<SoundAlike | undefined>((m, s) => (s !== undefined && better(s, m) ? s : m), undefined);
    return better(best, alone);
  };

  /**
   * Fix round 2 (N2), the short-word fail-safe: a word of 1–2 letters in the term position (right after a rule
   * trigger or an exclusion opener, or a later item of its list: N8, F1), then the end, a clause break, "and", "or"
   * or "&", that sounds exactly like an allergen ("allergic to so" / soy, "to it." / oat, "allergic to nuts and so").
   */
  const shortAt = (i: number): { id: string; name: string }[] => {
    const t = toks[i];
    if (!listPos[i] || listPos[i] === 'no' || [...t.word].length > 2 || /\d/.test(t.word)) return [];
    const next = toks.at(i + 1);
    if (next !== undefined && !next.broken && !next.amp && !LIST_JOINS.has(next.word)) return [];
    return allergenEchoes(t.word, graph);
  };

  const found: { heard: string; id: string | null; at: number; echoes?: { id: string; name: string }[] }[] = [];
  for (let i = 0; i < toks.length; ) {
    const exact = exactAt(i);
    const echoes = exact === null ? shortAt(i) : [];
    if (echoes.length > 0) {
      found.push({ heard: toks[i].word, id: null, at: i, echoes });
      i += 1;
    } else if (pairAt(i, exact)) {
      found.push({ heard: `${toks[i].word} ${toks[i + 1].word}`, id: null, at: i });
      i += 2;
    } else if (exact !== null) {
      found.push({ heard: toks.slice(i, i + exact.len).map((t) => t.word).join(' '), id: exact.id, at: i });
      i += exact.len;
    } else {
      if ((health || opened(i)) && soundAt(i) !== undefined) found.push({ heard: toks[i].word, id: null, at: i });
      i += 1;
    }
  }

  const byHeard = new Map<string, HeardTerm>();
  for (const f of found) {
    const seen = byHeard.get(f.heard);
    if (seen !== undefined) {
      seen.at.push(f.at);
      continue;
    }
    const alts = f.echoes ?? ranked(f.heard);
    byHeard.set(f.heard, {
      heard: f.heard,
      spelled: spell(f.heard),
      id: f.id,
      at: [f.at],
      alternatives: alts.slice(0, MAX_ALTERNATIVES).map(({ id, name }) => ({ id, name, spelled: spell(name) })),
    });
  }
  const out = [...byHeard.values()];
  return out.length === 0 ? null : { tooLong: false, terms: out, speakSpelling: health };
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { preference: 1, intolerance: 2, allergy: 3, anaphylactic: 4 };
/** Severity exactly as production reads it (fix round 2, N1: with the graph, so intolerance and preference count). */
const severityRank = (normal: string, graph: IngredientGraph): number => {
  const s = severityFromText(normal, graph);
  return s === null ? 0 : SEVERITY_RANK[s];
};

/** Why a heard choice was not applied: a chosen term's words are not where it was heard, it would lower severity, or too long. */
export type HeardChoiceRefusal = 'not_applied' | 'severity_lowered' | 'too_long';

/**
 * The transcript with each chosen term replaced by its chosen alternative's name, at the positions the check heard
 * it (`term.at`) and nowhere else (fix round 2, N3: "it could kill me" keeps its "kill"). `choice[i]` is an index
 * into `check.terms[i].alternatives`, or null to keep the words as heard; anything else is ignored. It works on the
 * text the check read: page events stripped, NFKC, invisible characters removed (fix round 1, M1).
 *
 * Refused, with the transcript unchanged, so the card keeps asking:
 *  - `too_long`: a blocking check, or a text whose normal form is over MAX_TEXT (N4: the same measure as heardCheck);
 *  - `not_applied`: a chosen term's words are not at its recorded position;
 *  - `severity_lowered`: `severityFromText(…, graph)`, on the normal form as the turn reads it, would be lower after
 *    the choice (I3, N1: a choice may only keep or raise severity, intolerance and preference included).
 */
export function tryHeardChoice(
  transcript: string,
  check: HeardCheck,
  choice: readonly (number | null)[],
  graph: IngredientGraph,
): { ok: true; text: string } | { ok: false; reason: HeardChoiceRefusal; text: string } {
  if (!(graph instanceof IngredientGraph)) throw new TypeError('tryHeardChoice: the ingredient graph is required (severity guard)');
  const refuse = (reason: HeardChoiceRefusal) => ({ ok: false as const, reason, text: transcript });
  if (check.tooLong || transcript.length > HARD_MAX_UNITS) return refuse('too_long');
  const base = stripPageEventsFull(transcript).text;
  const normalBase = normalizeText(base);
  if (codePoints(normalBase, MAX_TEXT) > MAX_TEXT) return refuse('too_long');
  const folded = foldConfusables(base);
  const toks = [...folded.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length }));
  const spans: { start: number; end: number; name: string }[] = [];
  for (const [i, term] of check.terms.entries()) {
    const k = choice.at(i);
    if (k === null || k === undefined || !Number.isInteger(k) || k < 0 || k >= term.alternatives.length) continue;
    const words = term.heard.split(' ');
    for (const at of term.at) {
      const run = toks.slice(at, at + words.length);
      if (run.length !== words.length || run.some((t, j) => t.word !== words[j])) return refuse('not_applied');
      spans.push({ start: run[0].start, end: run[run.length - 1].end, name: term.alternatives[k].name });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue;
    out += base.slice(pos, s.start) + s.name;
    pos = s.end;
  }
  out += base.slice(pos);
  const normalOut = normalizeText(out);
  if (codePoints(normalOut, MAX_TEXT) > MAX_TEXT) return refuse('too_long');
  if (severityRank(normalOut, graph) < severityRank(normalBase, graph)) return refuse('severity_lowered');
  return { ok: true, text: out };
}

/** `tryHeardChoice`'s text: the chosen text, or the transcript unchanged when the choice is refused. */
export function applyHeardChoice(transcript: string, check: HeardCheck, choice: readonly (number | null)[], graph: IngredientGraph): string {
  return tryHeardChoice(transcript, check, choice, graph).text;
}

/** Ruling 4: the tap confirmed exactly these heard words, in order. Anything else (or nothing) is not a confirmation. */
export function heardConfirmed(check: HeardCheck, words: readonly string[] | undefined): boolean {
  // A blocking or empty check is never confirmed (fix round 1, I2).
  return !check.tooLong && check.terms.length > 0 && words !== undefined && words.length === check.terms.length && check.terms.every((t, i) => words[i] === t.heard);
}

/** The heard card's spoken and written line triggers (pan.yaml; `voice.heard_check_spelled` with health wording). */
export const HEARD_CHECK_TRIGGER = 'voice.heard_check';
export const HEARD_CHECK_SPELLED_TRIGGER = 'voice.heard_check_spelled';

/**
 * M7 Step 6 (carry: one shared place): the heard card's line, `voice.heard_check {terms}` or, with health wording,
 * `voice.heard_check_spelled {terms, spelled}`. The words are as heard, the spelling is core `spell`'s (§7.6b.2: from
 * code, never the model). The mentor turn sends it beside the `heard` part; the voice route speaks it. A blocking
 * (`tooLong`) check has no heard line: the caller says `voice.too_long`.
 */
export function heardLine(check: HeardCheck): LineRef {
  if (check.tooLong) throw new Error('heardLine: a tooLong check has no heard line (say voice.too_long)');
  const terms = listWords(check.terms.map((t) => t.heard));
  if (!check.speakSpelling) return { trigger: HEARD_CHECK_TRIGGER, vars: { terms } };
  return { trigger: HEARD_CHECK_SPELLED_TRIGGER, vars: { terms, spelled: check.terms.map((t) => t.spelled).join(', ') } };
}
