// M7 Ruling 4 (§7.6): the heard check, the safety gate for speech. Any transcript naming a graph food, a rule term or
// (with health wording) a sound-alike of one is stopped by a heard card showing the words as heard, spelled, with the
// foods they may have been. Only a tap confirms it (`heardConfirmed`); nothing reaches a rule, a card or the model
// before. Speech-to-text output is untrusted user text (§7.6): it is stripped of page events first. Browser-safe.
import type { IngredientGraph } from '../ingredients/graph';
import { pluralForms, words } from '../ingredients/mentions';
import { foldConfusables, HEALTH_PATTERN, normalizeTurn, stripPageEvents } from '../mentor/intents';
import { DIET_WORD_PATTERN, RULE_TRIGGER_PATTERN, SEVERITY_PATTERNS } from '../mentor/parse';
import type { RuleTerm } from '../mentor/rule-terms';
import { spell } from '../mentor/spell';
import { MAX_ALTERNATIVES } from './constants';
import { rankSoundAlikes, termId, type SoundAlike } from './phonetic';

export interface HeardTerm {
  /** The words as heard: normalised (lower-cased, letters and digits), space-separated. */
  heard: string;
  /** `heard` spelled out by core `spell` (§7.6b.2: from code, never the model). */
  spelled: string;
  /** The graph id the heard words name (a rule term as `term:<name>`), or null when they name none. Never corrected. */
  id: string | null;
  /** What the words may have been instead, closest first, at most MAX_ALTERNATIVES. */
  alternatives: { id: string; name: string; spelled: string }[];
}

export interface HeardCheck {
  terms: HeardTerm[];
  /** Health wording is present: the card's spelling is spoken too (Ruling 4). */
  speakSpelling: boolean;
}

/**
 * Words that never start a sound-alike term by themselves: function words, common verbs, and the health, symptom,
 * cooking and command words a health-worded utterance carries. A stop word still counts inside an exact food name.
 */
const STOP = new Set(
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
    'loves hate hates eat eats eating ate eaten drink drinks try tried keep keeps let lets use used using cook cooking ' +
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

const isStop = (w: string): boolean => STOP.has(w) || /\d/.test(w) || [...w].length < 3;

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
  /** A clause break (, . ; : ! ?) comes before this word. */
  broken: boolean;
}

function tokensOf(normal: string): Token[] {
  const out: Token[] = [];
  let broken = false;
  for (const m of normal.matchAll(/[\p{L}\p{N}]+|[,.;:!?]/gu)) {
    if (/^[,.;:!?]$/.test(m[0])) broken = true;
    else {
      out.push({ word: m[0], broken });
      broken = false;
    }
  }
  return out;
}

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
 * words are never corrected: `id` is what they name as heard.
 */
export function heardCheck(transcript: string, graph: IngredientGraph, terms: readonly RuleTerm[]): HeardCheck | null {
  const normal = normalizeTurn(stripPageEvents(transcript).text);
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
  const soundAt = (i: number): SoundAlike | undefined => (isStop(toks[i].word) ? undefined : ranked(toks[i].word).at(0));
  /** Two words heard for one food, when they win over what their words name alone. */
  const pairAt = (i: number, exact: { len: number; id: string } | null): boolean => {
    if (!health || i + 1 >= toks.length || toks[i + 1].broken) return false;
    const [a, b] = [toks[i].word, toks[i + 1].word];
    if (/\d/.test(a + b) || (isStop(a) && isStop(b))) return false;
    const best = ranked(`${a} ${b}`).at(0);
    // With a stop word in it ("all mond", "loop in"), only an exact sound counts: "my son" is not miso.
    if (best === undefined || ((isStop(a) || isStop(b)) && best.distance > 0)) return false;
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
  return out.length === 0 ? null : { terms: out, speakSpelling: health };
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The transcript with each chosen term replaced in place by its chosen alternative's name. `choice[i]` is an index
 * into `check.terms[i].alternatives`, or null to keep the words as heard; anything else changes nothing. Every
 * whole-word occurrence of a chosen term's heard words is replaced (matching ignores case, accents and lookalikes);
 * everything else is kept exactly.
 */
export function applyHeardChoice(transcript: string, check: HeardCheck, choice: readonly (number | null)[]): string {
  const folded = foldConfusables(transcript);
  const spans: { start: number; end: number; name: string }[] = [];
  check.terms.forEach((term, i) => {
    const k = choice.at(i);
    if (k === null || k === undefined || !Number.isInteger(k) || k < 0 || k >= term.alternatives.length) return;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${term.heard.split(' ').map(escape).join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of folded.matchAll(pattern)) spans.push({ start: m.index, end: m.index + m[0].length, name: term.alternatives[k].name });
  });
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue;
    out += transcript.slice(pos, s.start) + s.name;
    pos = s.end;
  }
  return out + transcript.slice(pos);
}

/** Ruling 4: the tap confirmed exactly these heard words, in order. Anything else (or nothing) is not a confirmation. */
export function heardConfirmed(check: HeardCheck, words: readonly string[] | undefined): boolean {
  return words !== undefined && words.length === check.terms.length && check.terms.every((t, i) => words[i] === t.heard);
}
