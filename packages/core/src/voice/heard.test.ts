// M7 Step 1 (Ruling 4, §7.6): the heard check. Any transcript naming a food, a rule term or (with health wording) a
// sound-alike of one is stopped by a heard card until a tap confirms the exact words.
import { describe, expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import ruleTerms from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import { MAX_TEXT } from '../mentor/intents';
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
