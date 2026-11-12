// M7 Step 1 (Ruling 4, §7.6): the heard check. Any transcript naming a food, a rule term or (with health wording) a
// sound-alike of one is stopped by a heard card until a tap confirms the exact words.
import { describe, expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import ruleTerms from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import type { RuleTerm } from '../mentor/rule-terms';
import { MAX_ALTERNATIVES } from './constants';
import { applyHeardChoice, heardCheck, heardConfirmed } from './heard';

const graph = IngredientGraph.fromData(ingredients);
const terms = ruleTerms as RuleTerm[];
const check = (text: string) => heardCheck(text, graph, terms);
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
    expect(applyHeardChoice(text, chk, [shell, null])).toBe('Allergic to shellfish and rice, thanks');
    expect(applyHeardChoice(text, chk, [null, null])).toBe(text);
    expect(applyHeardChoice(text, chk, [])).toBe(text);
    const rye = chk.terms[1].alternatives.findIndex((a) => a.id === 'rye');
    expect(applyHeardChoice(text, chk, [null, rye])).toBe('Allergic to Selfish and rye, thanks');
    // an out-of-range choice changes nothing
    expect(applyHeardChoice(text, chk, [99, -1])).toBe(text);
    // a word inside another word is never touched
    const rices = 'allergic to rice, not ricecakes';
    expect(applyHeardChoice(rices, check(rices)!, [check(rices)!.terms[0].alternatives.findIndex((a) => a.id === 'rye')])).toBe('allergic to rye, not ricecakes');

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
    const fixed = applyHeardChoice(text, chk, [chk.terms[0].alternatives.findIndex((a) => a.id === 'shellfish')]);
    expect(check(fixed)!.terms.map((t) => [t.heard, t.id])).toEqual([['shellfish', 'shellfish']]);
  });
});
