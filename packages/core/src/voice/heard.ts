// M7 Ruling 4 (§7.6): the heard check, the safety gate for speech. Any transcript naming a graph food, a rule term or
// (with health wording) a sound-alike of one is stopped by a heard card showing the words as heard, spelled, with the
// foods they may have been. Only a tap confirms it (`heardConfirmed`); nothing reaches a rule, a card or the model
// before. Speech-to-text output is untrusted user text (§7.6): it is stripped of page events first. Browser-safe.
import type { IngredientGraph } from '../ingredients/graph';
import { pluralForms, words } from '../ingredients/mentions';
import { foldConfusables, HEALTH_PATTERN, MAX_TEXT, normalizeText, stripPageEventsFull } from '../mentor/intents';
import { ALLERGY_NEGATIONS, DIET_WORD_PATTERN, RULE_TRIGGER_PATTERN, SEVERITY_PATTERNS, severityFromText } from '../mentor/parse';
import type { RuleTerm } from '../mentor/rule-terms';
import { spell } from '../mentor/spell';
import { MAX_ALTERNATIVES } from './constants';
import { rankSoundAlikes, termId, type SoundAlike } from './phonetic';
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

/** Health wording (Ruling 4): the mentor's health, rule-trigger, diet and severity patterns, read on the normal form. */
export function hasHealthWording(normal: string): boolean {
  return (
    HEALTH_PATTERN.test(normal) ||
    normal.search(RULE_TRIGGER_PATTERN) >= 0 ||
    normal.search(DIET_WORD_PATTERN) >= 0 ||
    SEVERITY_PATTERNS.some(([p]) => p.test(normal))
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
  /** Inside health wording (`healthSpans`): never a sound-alike term. */
  health: boolean;
  /** A clause break (, . ; : ! ?) comes before this word. */
  broken: boolean;
}

function tokensOf(normal: string): Token[] {
  const spans = healthSpans(normal);
  const out: Token[] = [];
  let broken = false;
  for (const m of normal.matchAll(/[\p{L}\p{N}]+|[,.;:!?]/gu)) {
    if (/^[,.;:!?]$/.test(m[0])) broken = true;
    else {
      const [start, end] = [m.index, m.index + m[0].length];
      out.push({ word: m[0], broken, health: spans.some(([a, b]) => a < end && start < b) });
      broken = false;
    }
  }
  return out;
}

/**
 * [start, end) of every piece of health wording in the normal form: rule triggers, diet words, severity and anaphylaxis
 * cues, negations and the health pattern. Those words were heard as what they are, so they are never sound-alike
 * terms (fix round 1, I3: "epipen", "deadly" or "almost died" never offer a food to swap them for).
 */
function healthSpans(normal: string): [number, number][] {
  const patterns = [HEALTH_PATTERN, RULE_TRIGGER_PATTERN, DIET_WORD_PATTERN, ALLERGY_NEGATIONS, ...SEVERITY_PATTERNS.map(([p]) => p)];
  const out: [number, number][] = [];
  for (const p of patterns)
    for (const m of normal.matchAll(new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`)))
      if (m[0].length > 0) out.push([m.index, m.index + m[0].length]);
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
 * words are never corrected: `id` is what they name as heard. Health wording itself is never a sound-alike term, and
 * a stop word is one only when it sounds like a major allergen. Over MAX_TEXT (page events stripped first) it returns
 * a blocking `tooLong` check, never null: the caller refuses the turn and asks the player to type.
 */
export function heardCheck(transcript: string, graph: IngredientGraph, terms: readonly RuleTerm[]): HeardCheck | null {
  // Fix round 1 (I2): fail closed. Page events are stripped from the whole text first, then the length is measured;
  // over MAX_TEXT the check blocks instead of reading a cut text (a food past the cap would go unseen).
  const blocked: HeardCheck = { tooLong: true, terms: [], speakSpelling: false };
  if (transcript.length > HARD_MAX_UNITS) return blocked;
  const normal = normalizeText(stripPageEventsFull(transcript).text);
  if (codePoints(normal, MAX_TEXT) > MAX_TEXT) return blocked;
  const health = hasHealthWording(normal);
  const toks = tokensOf(normal);
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
    if (toks[i].health) return undefined;
    const list = ranked(toks[i].word);
    if (!isStop(toks[i].word)) return closest(list);
    return list.some((s) => s.allergen) && [...toks[i].word].length >= 3 && !/\d/.test(toks[i].word) ? closest(list) : undefined;
  };
  /** Two words heard for one food, when they win over what their words name alone. */
  const pairAt = (i: number, exact: { len: number; id: string } | null): boolean => {
    if (!health || i + 1 >= toks.length || toks[i + 1].broken || toks[i].health || toks[i + 1].health) return false;
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

  const found: { heard: string; id: string | null }[] = [];
  for (let i = 0; i < toks.length; ) {
    const exact = exactAt(i);
    if (pairAt(i, exact)) {
      found.push({ heard: `${toks[i].word} ${toks[i + 1].word}`, id: null });
      i += 2;
    } else if (exact !== null) {
      found.push({ heard: toks.slice(i, i + exact.len).map((t) => t.word).join(' '), id: exact.id });
      i += exact.len;
    } else {
      if (health && soundAt(i) !== undefined) found.push({ heard: toks[i].word, id: null });
      i += 1;
    }
  }

  const seen = new Set<string>();
  const out: HeardTerm[] = [];
  for (const f of found) {
    if (seen.has(f.heard)) continue;
    seen.add(f.heard);
    out.push({
      heard: f.heard,
      spelled: spell(f.heard),
      id: f.id,
      alternatives: ranked(f.heard)
        .slice(0, MAX_ALTERNATIVES)
        .map(({ id, name }) => ({ id, name, spelled: spell(name) })),
    });
  }
  return out.length === 0 ? null : { tooLong: false, terms: out, speakSpelling: health };
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SEVERITY_RANK: Readonly<Record<string, number>> = { preference: 1, intolerance: 2, allergy: 3, anaphylactic: 4 };
const severityRank = (text: string): number => {
  const s = severityFromText(text);
  return s === null ? 0 : SEVERITY_RANK[s];
};

/** Why a heard choice was not applied: a chosen term matched nothing, it would lower severity, or the check blocks. */
export type HeardChoiceRefusal = 'not_applied' | 'severity_lowered' | 'too_long';

/**
 * The transcript with each chosen term replaced in place by its chosen alternative's name. `choice[i]` is an index
 * into `check.terms[i].alternatives`, or null to keep the words as heard; anything else is ignored. It works on the
 * text the check read (page events stripped, NFKC, invisible characters removed: fix round 1, M1); every whole-word
 * occurrence of a chosen term's heard words is replaced (matching ignores case, accents and lookalikes).
 *
 * Refused, with the transcript unchanged, so the card keeps asking: when a chosen term matches nothing; when the
 * result's `severityFromText` would be lower than the transcript's (fix round 1, I3: a choice may only keep or raise
 * severity); and for a blocking (`tooLong`) check.
 */
export function tryHeardChoice(
  transcript: string,
  check: HeardCheck,
  choice: readonly (number | null)[],
): { ok: true; text: string } | { ok: false; reason: HeardChoiceRefusal; text: string } {
  if (check.tooLong) return { ok: false, reason: 'too_long', text: transcript };
  const base = stripPageEventsFull(transcript).text;
  const folded = foldConfusables(base);
  const spans: { start: number; end: number; name: string }[] = [];
  for (const [i, term] of check.terms.entries()) {
    const k = choice.at(i);
    if (k === null || k === undefined || !Number.isInteger(k) || k < 0 || k >= term.alternatives.length) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${term.heard.split(' ').map(escape).join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'giu');
    const before = spans.length;
    for (const m of folded.matchAll(pattern)) spans.push({ start: m.index, end: m.index + m[0].length, name: term.alternatives[k].name });
    if (spans.length === before) return { ok: false, reason: 'not_applied', text: transcript };
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
  if (severityRank(out) < Math.max(severityRank(transcript), severityRank(base))) return { ok: false, reason: 'severity_lowered', text: transcript };
  return { ok: true, text: out };
}

/** `tryHeardChoice`'s text: the chosen text, or the transcript unchanged when the choice is refused. */
export function applyHeardChoice(transcript: string, check: HeardCheck, choice: readonly (number | null)[]): string {
  return tryHeardChoice(transcript, check, choice).text;
}

/** Ruling 4: the tap confirmed exactly these heard words, in order. Anything else (or nothing) is not a confirmation. */
export function heardConfirmed(check: HeardCheck, words: readonly string[] | undefined): boolean {
  // A blocking or empty check is never confirmed (fix round 1, I2).
  return !check.tooLong && check.terms.length > 0 && words !== undefined && words.length === check.terms.length && check.terms.every((t, i) => words[i] === t.heard);
}
