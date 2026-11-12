// M7 Step 1 (Ruling 4, §7.6): the heard check. Any transcript naming a food, a rule term or (with health wording) a
// sound-alike of one is stopped by a heard card until a tap confirms the exact words.
import { describe, expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import ruleTerms from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import { HEALTH_PATTERN, MAX_TEXT } from '../mentor/intents';
import { ALLERGY_NEGATIONS, RULE_TRIGGER_PATTERN, SEVERITY_PATTERNS, severityFromText } from '../mentor/parse';
import { isMajorAllergen } from '../mentor/route';
import type { RuleTerm } from '../mentor/rule-terms';
import { spell } from '../mentor/spell';
import { MAX_ALTERNATIVES } from './constants';
import { applyHeardChoice, hasHealthWording, heardCheck, heardConfirmed, STOP_WORDS, tryHeardChoice, type HeardCheck } from './heard';
import { editDistance, phoneticKey } from './phonetic';

const graph = IngredientGraph.fromData(ingredients);
const terms = ruleTerms as RuleTerm[];
const check = (text: string) => heardCheck(text, graph, terms);
const tryChoice = (text: string, chk: HeardCheck, choice: readonly (number | null)[]) => tryHeardChoice(text, chk, choice, graph);
const applyChoice = (text: string, chk: HeardCheck, choice: readonly (number | null)[]) => applyHeardChoice(text, chk, choice, graph);
const altIds = (text: string, heard: string) => check(text)!.terms.find((t) => t.heard === heard)!.alternatives.map((a) => a.id);

describe('heardCheck', () => {
  test('"I can\'t eat sesame" → [{ heard: "sesame", spelled: "S-E-S-A-M-E", id: "sesame" }], speakSpelling true', () => {
    const chk = check("I can't eat sesame")!;
    expect(chk.speakSpelling).toBe(true);
    expect(chk.terms.map(({ heard, spelled, id }) => ({ heard, spelled, id }))).toEqual([{ heard: 'sesame', spelled: 'S-E-S-A-M-E', id: 'sesame' }]);
  });

  test('"got the shallots" → one term, speakSpelling false', () => {
    const chk = check('got the shallots')!;
    expect(chk.speakSpelling).toBe(false);
    expect(chk.terms).toHaveLength(1);
    expect(chk.terms[0]).toMatchObject({ heard: 'shallots', spelled: 'S-H-A-L-L-O-T-S', id: 'shallot' });
  });

  test('"next step", "set a timer for ten minutes", "how long do I stir it" → null', () => {
    for (const t of ['next step', 'set a timer for ten minutes', 'how long do I stir it', '', '   ']) expect(check(t), t).toBeNull();
  });

  test('"allergic to selfish" → heard "selfish", alternatives include shellfish; "that was selfish" → null', () => {
    const chk = check('allergic to selfish')!;
    expect(chk.speakSpelling).toBe(true);
    const t = chk.terms.find((x) => x.heard === 'selfish')!;
    expect(t).toMatchObject({ heard: 'selfish', spelled: 'S-E-L-F-I-S-H', id: null });
    expect(t.alternatives.map((a) => a.id)).toContain('shellfish');
    expect(t.alternatives.find((a) => a.id === 'shellfish')).toEqual({ id: 'shellfish', name: 'shellfish', spelled: 'S-H-E-L-L-F-I-S-H' });
    expect(check('that was selfish')).toBeNull();
  });

  test('"allergic to rice" → heard "rice", never auto-corrected; alternatives include rye', () => {
    const chk = check('allergic to rice')!;
    const t = chk.terms.find((x) => x.heard === 'rice')!;
    expect(t.id).toBe('rice_grain');
    expect(t.spelled).toBe('R-I-C-E');
    expect(altIds('allergic to rice', 'rice')).toContain('rye');
    expect(t.alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
  });

  test('"[Player tapped yes] peanut" → one term "peanut"', () => {
    const chk = check('[Player tapped yes] peanut')!;
    expect(chk.terms.map((t) => t.heard)).toEqual(['peanut']);
    expect(chk.terms[0].id).toBe('peanut');
  });

  test('terms come in text order, each heard word once; a rule term counts; a food heard for another offers the other', () => {
    const chk = check("I'm vegan and allergic to sesame, sesame and lemons")!;
    expect(chk.terms.map((t) => t.heard)).toEqual(['vegan', 'sesame', 'lemons']);
    expect(chk.terms.find((t) => t.heard === 'lemons')!.id).toBe('lemon');
    expect(altIds("I can't eat lemons", 'lemons')).toContain('lentil');
  });

  test('split words: "allergic to pea cans" → heard "pea cans" with pecan; "chick pea" → chickpea', () => {
    expect(altIds('allergic to pea cans', 'pea cans')).toContain('pecan');
    expect(altIds("can't eat chick peas", 'chick peas')).toContain('chickpea');
  });
});

describe('applyHeardChoice and heardConfirmed', () => {
  test('applyHeardChoice replaces only the chosen term in place; heardConfirmed is order- and word-exact', () => {
    const text = 'Allergic to Selfish and rice, thanks';
    const chk = check(text)!;
    expect(chk.terms.map((t) => t.heard)).toEqual(['selfish', 'rice']);
    const shell = chk.terms[0].alternatives.findIndex((a) => a.id === 'shellfish');
    expect(applyChoice(text, chk, [shell, null])).toBe('Allergic to shellfish and rice, thanks');
    expect(applyChoice(text, chk, [null, null])).toBe(text);
    expect(applyChoice(text, chk, [])).toBe(text);
    const rye = chk.terms[1].alternatives.findIndex((a) => a.id === 'rye');
    expect(applyChoice(text, chk, [null, rye])).toBe('Allergic to Selfish and rye, thanks');
    // an out-of-range choice changes nothing
    expect(applyChoice(text, chk, [99, -1])).toBe(text);
    // a word inside another word is never touched
    const rices = 'allergic to rice, not ricecakes';
    expect(applyChoice(rices, check(rices)!, [check(rices)!.terms[0].alternatives.findIndex((a) => a.id === 'rye')])).toBe('allergic to rye, not ricecakes');

    expect(heardConfirmed(chk, ['selfish', 'rice'])).toBe(true);
    expect(heardConfirmed(chk, ['rice', 'selfish'])).toBe(false);
    expect(heardConfirmed(chk, ['selfish'])).toBe(false);
    expect(heardConfirmed(chk, ['selfish', 'rice', 'peanut'])).toBe(false);
    expect(heardConfirmed(chk, ['Selfish', 'rice'])).toBe(false);
    expect(heardConfirmed(chk, ['shellfish', 'rice'])).toBe(false);
    expect(heardConfirmed(chk, undefined)).toBe(false);
    expect(heardConfirmed(chk, [])).toBe(false);
  });

  test('after a choice, the new text checks to the chosen food', () => {
    const text = 'allergic to selfish';
    const chk = check(text)!;
    const fixed = applyChoice(text, chk, [chk.terms[0].alternatives.findIndex((a) => a.id === 'shellfish')]);
    expect(check(fixed)!.terms.map((t) => [t.heard, t.id])).toEqual([['shellfish', 'shellfish']]);
  });
});

// Fix round 1 (review-task1.md I1–I3, M1).
describe('fix round 1: allergen-shaped stop words (I1)', () => {
  test.each([
    ['allergic to what', 'what', 'wheat'],
    ["can't eat not", 'not', 'nut'],
    ['allergic to been', 'been', 'bean'],
    ['allergic to says me', 'says me', 'sesame'],
    ['allergic to ache', 'ache', 'egg'],
  ])('"%s" → a card for "%s" offering %s', (text, heard, allergen) => {
    const chk = check(text);
    expect(chk, text).not.toBeNull();
    const t = chk!.terms.find((x) => x.heard === heard);
    expect(t, JSON.stringify(chk!.terms.map((x) => x.heard))).toBeDefined();
    expect(t!.alternatives.map((a) => a.id)).toContain(allergen);
    expect(chk!.speakSpelling).toBe(true);
  });

  test('no allergen sound-alike is suppressed under health wording: every stop word that keys like a major allergen gets a card offering it', () => {
    // allergens as core defines them (isMajorAllergen), plus bean, by every name and alias without digits
    const allergens = graph
      .labels()
      .filter((l) => !/\d/.test(l))
      .map((l) => ({ id: graph.resolve(l)!, key: phoneticKey(l) }))
      .filter((a) => a.id === 'bean' || isMajorAllergen(a.id, graph));
    let tried = 0;
    for (const w of STOP_WORDS) {
      // Fix round 2 (N2): no skip for short words or health words. Words of 1–2 letters count on an exact allergen
      // sound in the term position (right after "allergic to"), which is where this sentence puts them.
      if (/[^a-z]/.test(w)) continue;
      const k = phoneticKey(w);
      // a trigger, negation or severity word ("anaphylaxis") is exempt unless it sounds EXACTLY like an allergen (N2)
      const exempt = [RULE_TRIGGER_PATTERN, ALLERGY_NEGATIONS, ...SEVERITY_PATTERNS.map(([p]) => p)].some((p) => `${w} `.search(p) >= 0);
      const oneEdit = !exempt && [...w].length >= 4;
      const near = allergens.filter((a) => a.key.length > 0 && (editDistance(k, a.key) === 0 || (oneEdit && Math.min(k.length, a.key.length) > 1 && editDistance(k, a.key) === 1)));
      if (near.length === 0) continue;
      tried++;
      const t = check(`I'm allergic to ${w}`)?.terms.find((x) => x.heard === w);
      expect(t, w).toBeDefined();
      // the card offers a major allergen (the nearest ones may crowd out the one this key matched, never all of them)
      const offered = t!.alternatives.map((a) => a.id).filter((id) => !id.startsWith('term:') && (id === 'bean' || isMajorAllergen(id, graph)));
      expect(offered.length, `${w}: ${JSON.stringify(t!.alternatives)}`).toBeGreaterThan(0);
    }
    expect(tried).toBeGreaterThan(5);
  });

  test('without health wording a stop word never gets a card', () => {
    void hasHealthWording;
    for (const t of ['what now', 'not yet', 'say that again', 'wait a moment']) expect(check(t), t).toBeNull();
  });
});

describe('fix round 1: over-long transcripts fail closed (I2)', () => {
  const pad = (n: number) => 'and then we stirred the pot for a while '.repeat(Math.ceil(n / 40)).slice(0, n);

  test('over MAX_TEXT after page events are stripped → a blocking tooLong check, never null, never confirmable', () => {
    for (const tail of ["I'm allergic to peanuts", "I'm allergic to selfish", 'just chatting']) {
      const chk = check(`${pad(504)} ${tail}`);
      expect(chk, tail).not.toBeNull();
      expect(chk!.tooLong).toBe(true);
      expect(chk!.terms).toEqual([]);
      expect(heardConfirmed(chk!, [])).toBe(false);
      expect(heardConfirmed(chk!, ['peanuts'])).toBe(false);
    }
    const huge = check('peanut '.repeat(10_000))!;
    expect(huge.tooLong).toBe(true);
  });

  test('page-event padding is stripped before the length is measured: the food behind it still gets a card', () => {
    const chk = check(`${'[Player tapped yes] '.repeat(26)}I'm allergic to peanuts`)!;
    expect(chk.tooLong).toBe(false);
    expect(chk.terms.map((t) => [t.heard, t.id])).toEqual([['peanuts', 'peanut']]);
  });

  test('at exactly MAX_TEXT the text is checked normally', () => {
    const tail = " I'm allergic to peanuts";
    const chk = check(`${pad(MAX_TEXT - tail.length)}${tail}`)!;
    expect(chk.tooLong).toBe(false);
    expect(chk.terms.map((t) => t.heard)).toContain('peanuts');
  });
});

describe('fix round 1: severity is never lowered by a heard choice (I3)', () => {
  test('severity words are never heard terms and offer no food', () => {
    for (const cue of ['I carry an epipen', "it's deadly", 'it can be fatal', 'I go into shock', 'I almost died', 'anaphylaxis', 'I nearly died once']) {
      const chk = check(`I'm allergic to selfish, ${cue}`)!;
      const heard = chk.terms.map((t) => t.heard);
      expect(heard, cue).toContain('selfish');
      for (const w of ['epipen', 'epi', 'pen', 'deadly', 'fatal', 'shock', 'almost', 'died', 'nearly', 'anaphylaxis']) expect(heard.some((h) => h.split(' ').includes(w)), `${cue}: ${w}`).toBe(false);
    }
  });

  test('the epipen → apple case: a choice that would lower severityFromText is rejected and the ask is kept', () => {
    const text = "I'm allergic to selfish, I carry an epipen";
    const forged: HeardCheck = {
      tooLong: false,
      speakSpelling: true,
      terms: [
        { heard: 'selfish', spelled: 'S-E-L-F-I-S-H', id: null, at: [4], alternatives: [{ id: 'shellfish', name: 'shellfish', spelled: 'S-H-E-L-L-F-I-S-H' }] },
        { heard: 'epipen', spelled: 'E-P-I-P-E-N', id: null, at: [8], alternatives: [{ id: 'apple', name: 'apple', spelled: 'A-P-P-L-E' }] },
      ],
    };
    expect(tryChoice(text, forged, [null, 0])).toEqual({ ok: false, reason: 'severity_lowered', text });
    expect(applyChoice(text, forged, [null, 0])).toBe(text);
    // the same choice set with only the safe swap is applied
    expect(tryChoice(text, forged, [0, null])).toEqual({ ok: true, text: "I'm allergic to shellfish, I carry an epipen" });
    // both together: rejected as a whole
    expect(tryChoice(text, forged, [0, 0]).ok).toBe(false);
  });

  test('every choice on every fixture-like transcript keeps severity at or above the original', () => {
    const rank = (s: string | null) => (s === null ? 0 : ['preference', 'intolerance', 'allergy', 'anaphylactic'].indexOf(s) + 1);
    for (const text of ["I'm allergic to selfish, I carry an epipen", "I'm allergic to rice, it's deadly", 'No nots for me, severe allergy', "I'm vegan, allergic to pea cans"]) {
      const chk = check(text)!;
      chk.terms.forEach((t, i) =>
        t.alternatives.forEach((_, k) => {
          const choice = chk.terms.map((_, j) => (j === i ? k : null));
          const r = tryChoice(text, chk, choice);
          if (r.ok) expect(rank(severityFromText(r.text, graph)), `${text} / ${t.heard}→${k}`).toBeGreaterThanOrEqual(rank(severityFromText(text, graph)));
        }),
      );
    }
  });
});

describe('fix round 1: a choice applies to the text the check read (M1)', () => {
  const fullwidth = (s: string) => [...s].map((c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0)).join('');
  const zwsp = String.fromCharCode(0x200b);
  test.each([
    [`allergic to ${fullwidth('selfish')}`, 'shellfish', 'allergic to shellfish'],
    [`allergic to sel${zwsp}fish`, 'shellfish', 'allergic to shellfish'],
    ['allergic to pea [Player tapped yes] cans', 'pecan', 'allergic to pecan'],
  ])('%s → %s', (text, id, want) => {
    const chk = check(text)!;
    const k = chk.terms[0].alternatives.findIndex((a) => a.id === id);
    expect(k).toBeGreaterThanOrEqual(0);
    const r = tryChoice(text, chk, [k]);
    expect(r).toEqual({ ok: true, text: want });
    expect(check(r.text)!.terms.map((t) => t.id)).toEqual([id]);
  });

  test('a choice that matches nothing is reported, not silently dropped', () => {
    const chk = check('allergic to selfish')!;
    expect(tryChoice('allergic to something else', chk, [0])).toEqual({ ok: false, reason: 'not_applied', text: 'allergic to something else' });
  });
});

// Fix round 2 (review-task1-fix1.md N1–N6).
describe('fix round 2: the severity guard reads severity as production does (N1)', () => {
  const sev = (s: string | null) => (s === null ? 0 : ['preference', 'intolerance', 'allergy', 'anaphylactic'].indexOf(s) + 1);
  const at = (heard: string, index: number, alt: { id: string; name: string }): HeardCheck => ({
    tooLong: false,
    speakSpelling: true,
    terms: [{ heard, spelled: spell(heard), id: null, at: [index], alternatives: [{ ...alt, spelled: spell(alt.name) }] }],
  });

  test('intolerance and preference: a choice that drops them is refused', () => {
    // tokens: i m intolerant to milk → milk is token 4; i don t like egg → egg is token 4
    expect(tryChoice("I'm intolerant to milk", at('milk', 4, { id: 'term:coeliac', name: 'coeliac' }), [0]).ok).toBe(false);
    expect(tryChoice("I don't like egg", at('egg', 4, { id: 'term:vegetarian', name: 'vegetarian' }), [0])).toEqual({ ok: false, reason: 'severity_lowered', text: "I don't like egg" });
    expect(tryChoice("I'm intolerant to bean and milk", at('bean and', 4, { id: 'peanut', name: 'peanut' }), [0]).ok).toBe(false);
    // a swap that keeps the level is applied
    expect(tryChoice("I'm intolerant to milk", at('milk', 4, { id: 'egg', name: 'egg' }), [0])).toEqual({ ok: true, text: "I'm intolerant to egg" });
  });

  test('the graph is required', () => {
    const chk = check("I'm allergic to selfish")!;
    // @ts-expect-error: the guard needs the graph (N1)
    expect(() => tryHeardChoice("I'm allergic to selfish", chk, [0])).toThrow();
  });

  test('sweep: across allergy, anaphylaxis, intolerance and preference templates and graph foods, 0 accepted choices lower severity', () => {
    const templates = [
      "I'm allergic to X",
      "I'm allergic to X, I carry an epipen",
      "I'm intolerant to X",
      "I'm intolerant to X and milk",
      "I don't like X",
      'X makes me bloated, I avoid it',
    ];
    const labels = graph.labels().filter((_, i) => i % 3 === 0);
    let tried = 0;
    let lowered = 0;
    const levels = new Set<number>();
    for (const tpl of templates)
      for (const label of labels) {
        const text = tpl.replace('X', label);
        const before = sev(severityFromText(text, graph));
        levels.add(before);
        const chk = check(text);
        if (chk === null || chk.tooLong) continue;
        chk.terms.forEach((t, i) =>
          t.alternatives.forEach((_, k) => {
            tried++;
            const r = tryChoice(text, chk, chk.terms.map((_, j) => (j === i ? k : null)));
            if (r.ok && sev(severityFromText(r.text, graph)) < before) lowered++;
          }),
        );
      }
    for (const level of [1, 2, 3, 4]) expect(levels.has(level), String(level)).toBe(true);
    expect(tried).toBeGreaterThan(1000);
    expect(lowered).toBe(0);
  });
});

describe('fix round 2: allergen sound-alikes inside health wording and short words (N2)', () => {
  test.each([
    ["I'm allergic to dietary", 'dietary', 'milk'],
    ["I'm allergic to ate", 'ate', 'oats'],
    ["I can't eat ate", 'ate', 'oats'],
    ["I'm allergic to so", 'so', 'soy'],
    ["can't eat so", 'so', 'soy'],
    ['allergic to so and milk', 'so', 'soy'],
    ["I'm allergic to it.", 'it', 'oats'],
    ['allergic to ok', 'ok', 'egg'],
  ])('"%s" → a card for "%s" offering %s', (text, heard, allergen) => {
    const t = check(text)?.terms.find((x) => x.heard === heard);
    expect(t, JSON.stringify(check(text)?.terms.map((x) => x.heard))).toBeDefined();
    expect(t!.alternatives.map((a) => a.id)).toContain(allergen);
  });

  test('a short word counts only in the term position: right after the trigger, then the end, a break, "and" or "or"', () => {
    for (const text of ['so I am allergic to sesame', "I'm allergic to it because of the sauce", 'allergic to sesame so far']) {
      const heard = check(text)!.terms.map((t) => t.heard);
      expect(heard, text).not.toContain('so');
      expect(heard, text).not.toContain('it');
    }
  });

  test('the trigger words themselves stay out: "I can\'t eat sesame" is still one term', () => {
    expect(check("I can't eat sesame")!.terms.map((t) => t.heard)).toEqual(['sesame']);
    expect(check("I'm allergic to sesame")!.terms.map((t) => t.heard)).toEqual(['sesame']);
  });
});

describe('fix round 2: a choice rewrites only its own occurrences (N3)', () => {
  test('"kill" the term is rewritten; "kill me" the severity cue is not', () => {
    const text = "I'm allergic to kill, it could kill me";
    const chk = check(text)!;
    const t = chk.terms.findIndex((x) => x.heard === 'kill');
    expect(t).toBeGreaterThanOrEqual(0);
    const k = chk.terms[t].alternatives.findIndex((a) => graph.has(a.id));
    const r = tryChoice(text, chk, chk.terms.map((_, j) => (j === t ? k : null)));
    expect(r).toEqual({ ok: true, text: `I'm allergic to ${chk.terms[t].alternatives[k].name}, it could kill me` });
  });

  test('every occurrence the check made a term is rewritten; a position whose words differ is not_applied', () => {
    const text = 'allergic to selfish, yes selfish';
    const chk = check(text)!;
    expect(chk.terms[0].at).toEqual([2, 4]);
    expect(tryChoice(text, chk, [0])).toEqual({ ok: true, text: 'allergic to shellfish, yes shellfish' });
    expect(tryChoice('allergic to sesame, yes selfish', chk, [0]).ok).toBe(false);
  });
});

describe('fix round 2: the guard and the cap measure the same normal text (N4)', () => {
  test('whitespace padding that keeps the normal form under the cap is still guarded', () => {
    const text = `I'm allergic to selfish,${' '.repeat(480)} I carry an epipen`;
    const forged: HeardCheck = {
      tooLong: false,
      speakSpelling: true,
      terms: [{ heard: 'epipen', spelled: 'E-P-I-P-E-N', id: null, at: [8], alternatives: [{ id: 'apple', name: 'apple', spelled: 'A-P-P-L-E' }] }],
    };
    expect(tryChoice(text, forged, [0])).toEqual({ ok: false, reason: 'severity_lowered', text });
  });

  test('a normal form over MAX_TEXT is refused as too_long, even with a check that says otherwise', () => {
    const text = `${'and then we stirred the pot '.repeat(20)}allergic to selfish`;
    const forged: HeardCheck = { tooLong: false, speakSpelling: true, terms: [{ heard: 'selfish', spelled: 'S-E-L-F-I-S-H', id: null, at: [122], alternatives: [{ id: 'shellfish', name: 'shellfish', spelled: 'S-H-E-L-L-F-I-S-H' }] }] };
    expect(tryChoice(text, forged, [0])).toEqual({ ok: false, reason: 'too_long', text });
  });
});

describe('fix round 2: cook chatter without health wording gets no card (N5)', () => {
  test.each(["what's for dinner", 'what should I make for lunch', 'what did I have for lunch yesterday', 'I had toast for lunch', 'what is for supper tonight', 'any snacks left'])(
    '"%s" → null',
    (text) => {
      expect(check(text)).toBeNull();
    },
  );

  test('a named food in chatter still gets a card, without spoken spelling; I1 still holds under health wording', () => {
    expect(check('I had peanuts for lunch')).toMatchObject({ speakSpelling: false, terms: [{ heard: 'peanuts', id: 'peanut' }] });
    expect(check("what's for dinner, I'm allergic to what")!.terms.map((t) => t.heard)).toContain('what');
  });
});

// Fix round 3 (review-task1-fix2.md R1, N8, N9).
describe('fix round 3: a symptom or reaction report is health wording, with or without a meal word (R1)', () => {
  test.each([
    ['I ate selfish and got sick', 'selfish', 'shellfish'],
    ['we had selfish for dinner and he was ill', 'selfish', 'shellfish'],
    ['I had a bad reaction at dinner to selfish', 'selfish', 'shellfish'],
    ['I had nots at lunch and felt awful', 'nots', 'nut'],
    ['eaten selfish, felt sick', 'selfish', 'shellfish'],
    ['had selfish for lunch, my tongue swelled', 'selfish', 'shellfish'],
    ['my son had selfish at lunch and reacted', 'selfish', 'shellfish'],
    ['I ate nots and my lips went funny', 'nots', 'nut'],
    ['she gets ill from selfish at lunch', 'selfish', 'shellfish'],
    ['I ate selfish and threw up', 'selfish', 'shellfish'],
    ['had selfish at dinner and I was wheezing', 'selfish', 'shellfish'],
    ['ate selfish, now my stomach hurts', 'selfish', 'shellfish'],
    ['selfish at dinner made me sick', 'selfish', 'shellfish'],
    ['I had selfish and broke out in hives', 'selfish', 'shellfish'],
    ['had selfish, then cramps all night', 'selfish', 'shellfish'],
    ["ate selfish and couldn't breathe", 'selfish', 'shellfish'],
  ])('"%s" → asks about "%s" with %s, spelling spoken', (text, heard, id) => {
    const chk = check(text);
    expect(chk, text).not.toBeNull();
    expect(chk!.speakSpelling).toBe(true);
    expect(chk!.terms.find((t) => t.heard === heard)?.alternatives.map((a) => a.id)).toContain(id);
  });

  test.each(["what's for dinner", 'what should I make for lunch', 'what did I have for lunch yesterday', "let's make dinner", 'I had toast for lunch', 'is lunch ready'])(
    'chatter control: "%s" → null',
    (text) => {
      expect(check(text)).toBeNull();
    },
  );

  test('the symptom words are the heard check\'s own: the shared mentor HEALTH_PATTERN is unchanged', () => {
    expect(HEALTH_PATTERN.test('i ate selfish and got sick')).toBe(true); // via "ate", as before
    expect(HEALTH_PATTERN.test('selfish made me sick')).toBe(false);
    expect(hasHealthWording('selfish made me sick')).toBe(true);
  });
});

describe('fix round 3: the short-word fail-safe runs along the whole list (N8)', () => {
  test.each([
    ['allergic to nuts and so', 'so', 'soy'],
    ['allergic to soy and so', 'so', 'soy'],
    ['allergic to nuts, so', 'so', 'soy'],
    ['allergic to nuts, sesame and so', 'so', 'soy'],
    ['allergic to nuts, sesame, and ok', 'ok', 'egg'],
    ["I can't eat milk or it.", 'it', 'oats'],
  ])('"%s" → a card for "%s" offering %s', (text, heard, id) => {
    expect(check(text)?.terms.find((t) => t.heard === heard)?.alternatives.map((a) => a.id), text).toContain(id);
  });

  test('the list ends at the clause end: "allergic to nuts. so I cook" and "allergic to nuts and so I cook" stay silent on "so"', () => {
    for (const text of ['allergic to nuts. so I cook', 'allergic to nuts and so I cook', 'allergic to nuts; so what']) expect(check(text)!.terms.map((t) => t.heard), text).not.toContain('so');
  });
});

describe('fix round 3: meal stop words in allergy sentences (N9, sanctioned over-asking, pinned)', () => {
  test('"I\'m allergic to peanuts at dinner" asks about peanuts and dinner', () => {
    expect(check("I'm allergic to peanuts at dinner")!.terms.map((t) => t.heard)).toEqual(['peanuts', 'dinner']);
  });
});

// Fix round 4 (review-task1-fix3.md F1, F2, and the exclusion opener).
describe('fix round 4: a symptom word with a cooking sense counts only in a body or self context (F2)', () => {
  // The reviewer's 21-line cook-chatter set (review-task1-fix3.md F2), all null.
  test.each([
    'the dough will swell as it proves',
    'break out the wok',
    "I'll come up in a minute",
    'Ill check the oven',
    "that's the Maillard reaction, right",
    'this sauce is sick',
    'I feel bad, I burned it',
    'my hands are numb from the cold',
    "I'm itching to start",
    "what's for dinner, I feel awful today",
    'how do I react if it spits',
    'the pan is sick hot',
    "I'm sick of stirring",
    "it's making me dizzy, all this stirring",
    "I'll throw up the lid",
    "let it rest, what's next",
    'not yet, wait',
    'can you say that again',
    "I've been stirring for ages",
  ])('cook chatter: "%s" → null', (text) => {
    expect(check(text), JSON.stringify(check(text)?.terms.map((t) => t.heard))).toBeNull();
  });

  // Two lines of the set name a graph food. Ruling 4 cards every named food, so these keep that card, and only it:
  // no symptom-word health wording, so no stop-word terms and no spoken spelling.
  test.each([
    ['a faint smell of garlic', 'garlic'],
    ['the rice will swell up', 'rice'],
  ])('cook chatter naming a food: "%s" → only "%s", spelling not spoken', (text, food) => {
    expect(check(text)).toMatchObject({ speakSpelling: false, terms: [{ heard: food }] });
    expect(check(text)!.terms).toHaveLength(1);
  });

  test.each([
    ['my lips started to swell after selfish', 'selfish'],
    ["he'll swell up from selfish", 'selfish'],
    ['her face swelled up from selfish', 'selfish'],
    ['he broke out in spots after selfish', 'selfish'],
    ['I came up in lumps after selfish', 'selfish'],
    ["I'm ill after selfish", 'selfish'],
    ['selfish made me ill', 'selfish'],
    ['I was sick after selfish', 'selfish'],
    ['selfish makes her sick', 'selfish'],
    ['he had an allergic reaction from selfish', 'selfish'],
    ['she reacted badly after selfish', 'selfish'],
    ['I felt faint after selfish', 'selfish'],
    ['my mouth is itchy from selfish', 'selfish'],
    ['my throat itched after selfish', 'selfish'],
    ['my tongue went numb after selfish', 'selfish'],
    ['selfish makes me throw up', 'selfish'],
    ['I felt dizzy after selfish', 'selfish'],
    ['selfish made me feel bad', 'selfish'],
  ])('a body or self context still asks: "%s" → "%s" offers shellfish', (text, heard) => {
    const chk = check(text);
    expect(chk?.speakSpelling, text).toBe(true);
    expect(chk!.terms.find((t) => t.heard === heard)?.alternatives.map((a) => a.id)).toContain('shellfish');
  });

  test.each(['I threw up', 'I vomited', 'hives', 'a rash', "I couldn't breathe", 'wheezing', 'I feel nauseous'])(
    'an unambiguous symptom is health wording on its own: "%s"',
    (text) => {
      expect(hasHealthWording(text.toLowerCase())).toBe(true);
    },
  );
});

describe('fix round 4: the short-word list walk passes any item, named or not (F1)', () => {
  test.each([
    ['allergic to latex and so', 'so', 'soy'],
    ['allergic to raw nuts and so', 'so', 'soy'],
    ['allergic to nuts & so', 'so', 'soy'],
  ])('"%s" → a card for "%s" offering %s', (text, heard, id) => {
    expect(check(text)?.terms.find((t) => t.heard === heard)?.alternatives.map((a) => a.id), text).toContain(id);
  });

  test('the walk still stops at the clause end', () => {
    for (const text of ['allergic to latex. so I cook', 'allergic to raw nuts and so I cook', 'allergic to latex; so what'])
      expect(check(text)?.terms.map((t) => t.heard) ?? [], text).not.toContain('so');
  });
});

describe('fix round 4: a clause-initial exclusion opener is a trigger for the heard check', () => {
  test.each([
    ['No selfish at dinner please', 'selfish', 'shellfish'],
    ['without selfish please', 'selfish', 'shellfish'],
    ['hold the selfish', 'selfish', 'shellfish'],
    ['leave out the selfish', 'selfish', 'shellfish'],
    ["I can't do selfish at dinner", 'selfish', 'shellfish'],
    ['ok, no selfish or nots', 'nots', 'nut'],
    ['hold the so', 'so', 'soy'],
  ])('"%s" asks about "%s" offering %s', (text, heard, id) => {
    const chk = check(text);
    expect(chk, text).not.toBeNull();
    // fix round 5 (G2): an opener is no health wording, so the spelling is not spoken
    expect(chk!.speakSpelling).toBe(false);
    expect(chk!.terms.find((t) => t.heard === heard)?.alternatives.map((a) => a.id)).toContain(id);
  });

  test('the opener\'s own words are never terms; a lead word may come first', () => {
    expect(check('leave out the selfish')!.terms.map((t) => t.heard)).toEqual(['selfish']);
    expect(check('without selfish please')!.terms.map((t) => t.heard)).toEqual(['selfish']);
    expect(check('ok no selfish')!.terms.map((t) => t.heard)).toEqual(['selfish']);
  });

  test.each(['no thanks', 'no, the other one', 'no not yet', 'no problem', 'no worries, what is next', 'there is no rush'])('a "no" without a food-position word gets no card: "%s"', (text) => {
    expect(check(text), JSON.stringify(check(text)?.terms.map((t) => t.heard))).toBeNull();
  });
});

// Fix round 5 (review-task1-fix4.md G1, G2).
describe('fix round 5: the reaction phrasings round 4 lost ask again (G1)', () => {
  test.each([
    ['the selfish is making me dizzy', 'selfish'],
    ['selfish is making me dizzy', 'selfish'],
    ['selfish makes me faint', 'selfish'],
    ['selfish leaves me feeling awful', 'selfish'],
    ['swell up after selfish', 'selfish'],
  ])('"%s" asks about "%s" offering shellfish, spelling spoken', (text, heard) => {
    const chk = check(text);
    expect(chk?.speakSpelling, text).toBe(true);
    expect(chk!.terms.find((t) => t.heard === heard)?.alternatives.map((a) => a.id)).toContain('shellfish');
  });

  // The reviewer's chatter set (review-task1-fix4.md: the 21 chatter lines, both cook corpora and 10 extra cook lines).
  test.each([
    "the dough will swell as it proves",
    "break out the wok",
    "I'll come up in a minute",
    "Ill check the oven",
    "that's the Maillard reaction, right",
    "this sauce is sick",
    "I feel bad, I burned it",
    "my hands are numb from the cold",
    "I'm itching to start",
    "what's for dinner, I feel awful today",
    "how do I react if it spits",
    "the pan is sick hot",
    "I'm sick of stirring",
    "it's making me dizzy, all this stirring",
    "I'll throw up the lid",
    "let it rest, what's next",
    "not yet, wait",
    "can you say that again",
    "I've been stirring for ages",
    "next step",
    "repeat that",
    "how long do I stir it",
    "set a timer for ten minutes",
    "we're out of butter",
    "can I use olive oil instead",
    "is this safe for me",
    "what's for dinner",
    "I'm allergic to latex",
    "turn the heat down",
    "is the oven hot enough",
    "what should I make for lunch",
    "I had the oven on already",
    "what do I do next, I had it out",
    "I ate too much, what's next",
    "is it ok to wait",
    "what's next",
    "what did I have for lunch yesterday",
    "is it done yet, it's been ten minutes",
    "what goes in next for dinner",
    "hold on, I had to get the kids",
    "let's make dinner",
    "I'm not sure, I had a snack",
    "that is making me dizzy watching it spin",
    "the smell is making me hungry",
    "leave the lid off",
    "leave it to rest",
    "leave me alone",
    "this is making me sick of waiting",
  ])('chatter: "%s" → null', (text) => {
    expect(check(text), JSON.stringify(check(text)?.terms.map((t) => t.heard))).toBeNull();
  });

  test.each([
    "a faint smell of garlic",
    "the rice will swell up",
    "got the shallots",
    "what can I use instead of eggs",
    "how do I chop an onion",
    "I had to wait for the water to boil",
    "the onions are making me cry",
    "the beans swell up when soaked",
  ])('chatter naming a food: "%s" → one card, spelling not spoken', (text) => {
    expect(check(text)).toMatchObject({ speakSpelling: false });
    expect(check(text)!.terms).toHaveLength(1);
  });

  test.each([
    "I'm allergic to peanuts",
    "I can't eat sesame",
    "my daughter is allergic to milk and eggs",
    "I'm vegan",
    "I'm vegetarian but I eat fish",
    "no nuts for me, I'm allergic",
    "I'm coeliac so no gluten",
    "I'm allergic to shellfish and I carry an epipen",
    "I had a reaction to prawns last week",
    "I'm lactose intolerant",
    "my son can't have dairy",
    "I avoid pork",
    "I'm allergic to tree nuts but not peanuts",
    "I ate wheat and got hives",
    "allergic to pea cans",
    "I'm allergic to kiwi",
    "gluten free please",
    "I'm allergic to cats",
    "my wife is allergic to mustard",
    "I almost died from a peanut",
    "I can't eat anything with soy in it",
  ])('a health line of the set still speaks spelling: "%s"', (text) => {
    expect(check(text)?.speakSpelling).toBe(true);
  });
});

describe('fix round 5: more openers; cook words after an opener make no terms; spelling only under health wording (G2)', () => {
  test.each([
    ['without the selfish', 'selfish'],
    ['no more selfish', 'selfish'],
    ['nope selfish', 'selfish'],
  ])('"%s" asks about "%s" offering shellfish', (text, heard) => {
    expect(check(text)?.terms.find((t) => t.heard === heard)?.alternatives.map((a) => a.id), text).toContain('shellfish');
  });

  test.each(['no lid', 'hold the lid', 'hold the phone', 'no stirring yet', 'no more stirring', 'no more timers', 'without the timer', 'no next step please', 'hold the ingredients'])(
    'a cook word after an opener: "%s" → null',
    (text) => {
      expect(check(text), JSON.stringify(check(text)?.terms.map((t) => t.heard))).toBeNull();
    },
  );

  test('a food after an opener keeps its card, spelling spoken only under health wording', () => {
    expect(check('no salt please')).toMatchObject({ speakSpelling: false, terms: [{ heard: 'salt', id: 'salt' }] });
    expect(check('no selfish at dinner please')).toMatchObject({ speakSpelling: false });
    expect(check('no selfish at dinner please')!.terms.map((t) => t.heard)).toEqual(['selfish']);
    expect(check("no salt please, I'm allergic")!.speakSpelling).toBe(true);
  });
});
