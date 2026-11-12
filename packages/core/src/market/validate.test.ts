import { describe, expect, test } from 'vitest';
import { BRAM, graph, question, SPICE, WEN } from './fixtures';
import type { StallFile, StallQuestion } from './types';
import { validateStallFile } from './validate';

const KNOWN = new Set(['cut_match', 'value', 'label', 'safety', 'sniff', 'freshness', 'substitute', 'ripeness', 'storage', 'seasonal']);
const opts = { knownGames: KNOWN };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A Bram file that passes: the fixture (tofu is a graph node since M6 Step 4), plus a priced value question. */
function goodBram(): StallFile {
  const d = clone(BRAM);
  d.questions.push(clone(VALUE));
  return d;
}

const VALUE: StallQuestion = {
  id: 'bram-value-braise',
  game: 'value',
  prompt: 'Best value for a braise for four. Bram slides the chalkboard over: chuck 22.50 for 6 servings; short ribs 38 for 4; shank 24 for 5.',
  contains: ['beef'],
  options: [
    { text: 'Chuck', correct: true, reaction: 'Chuck: 22.50 ÷ 6 = 3.75 a serving.' },
    { text: 'Short ribs', correct: false, reaction: 'Half bone: 38 ÷ 4 = 9.50 a serving. Chuck is 3.75.' },
    { text: 'Shank', correct: false, reaction: 'With the bone it is 24 ÷ 5 = 4.80 a serving.' },
  ],
  explain: 'Compare cost per serving, not per pound.',
  chalkboard: [{ price: 22.5, servings: 6 }, { price: 38, servings: 4 }, { price: 24, servings: 5 }],
};

const pc = (d: StallFile) => d.variants!.protein_counter!;
const problems = (d: unknown) => validateStallFile(d, graph, opts);
/** The problems for a good Bram with one change made by `edit`. */
function with_(edit: (d: StallFile) => void): string[] {
  const d = goodBram();
  edit(d);
  return problems(d);
}
const q = (d: StallFile, id: string): StallQuestion => [...d.questions, ...pc(d).questions].find((x) => x.id === id)!;
/** The chalkboard of the priced value question. */
const board = (d: StallFile) => q(d, 'bram-value-braise').chalkboard!;

describe('validateStallFile (never throws; each problem names the stall, the key path and the id)', () => {
  test('the good fixtures pass', () => {
    expect(problems(goodBram())).toEqual([]);
    expect(problems(SPICE)).toEqual([]);
    expect(problems({ ...WEN, seasonal: { 'pnw-usa': { 11: [question('wen-pnw-11-squash', { game: 'seasonal', contains: ['corn'] })] } } })).toEqual([]);
  });

  test('each validateStallFile problem above, one fixture each, named by stall, key path and id', () => {
    // Not exactly one correct; not 3–4 options.
    expect(with_((d) => { q(d, 'bram-braise-cut').options[1].correct = true; })).toEqual(['bram: questions[0] (bram-braise-cut): has 2 correct options, not exactly one']);
    expect(with_((d) => { q(d, 'bram-braise-cut').options[0].correct = false; })).toEqual(['bram: questions[0] (bram-braise-cut): has 0 correct options, not exactly one']);
    expect(with_((d) => { q(d, 'bram-braise-cut').options.pop(); })).toEqual(['bram: questions[0] (bram-braise-cut): has 2 options, not 3–4']);
    expect(with_((d) => { const o = q(d, 'bram-braise-cut').options; o.push(clone(o[1]), clone(o[2])); })).toEqual(['bram: questions[0] (bram-braise-cut): has 5 options, not 3–4']);
    // A contains id missing from the graph, at question and option level, in the base and the variant.
    expect(with_((d) => { q(d, 'bram-braise-cut').contains = ['beef', 'wagyu']; })).toEqual(['bram: questions[0] (bram-braise-cut): contains "wagyu" is not in the ingredient graph']);
    expect(with_((d) => { q(d, 'bram-pc-lentils').options[2].contains = ['natto']; })).toEqual(['bram: variants.protein_counter.questions[0] (bram-pc-lentils): options[2].contains "natto" is not in the ingredient graph']);
    expect(with_((d) => { q(d, 'bram-pc-tofu').contains = ['natto']; })).toEqual(['bram: variants.protein_counter.questions[3] (bram-pc-tofu): contains "natto" is not in the ingredient graph']);
    // An unknown game for the stall, and a game key nothing knows.
    expect(with_((d) => { q(d, 'bram-braise-cut').game = 'sniff'; })).toEqual(['bram: questions[0] (bram-braise-cut): game "sniff" is not one of this stall\'s games']);
    expect(with_((d) => { Reflect.deleteProperty(q(d, 'bram-braise-cut'), 'game'); })).toEqual(['bram: questions[0] (bram-braise-cut): game undefined is not one of this stall\'s games']);
    expect(with_((d) => { d.games.darts = 'Throw things.'; })).toEqual(['bram: games.darts: not a known game']);
    // An item_tips key not in the graph, in the base and the variant.
    expect(with_((d) => { d.item_tips.wagyu = { pick: 'Marbled.', store: 'Fridge.' }; })).toEqual(['bram: item_tips.wagyu: not in the ingredient graph']);
    expect(with_((d) => { pc(d).item_tips.natto = { pick: 'Springy.', store: 'Fridge.' }; })).toEqual(['bram: variants.protein_counter.item_tips.natto: not in the ingredient graph']);
    // A duplicate question id across questions, variants and seasonal.
    expect(with_((d) => { q(d, 'bram-pc-lentils').id = 'bram-braise-cut'; })).toEqual(['bram: variants.protein_counter.questions[0] (bram-braise-cut): duplicate question id, also at questions[0]']);
    expect(with_((d) => { d.seasonal = { 'pnw-usa': { 11: [question('bram-thermometer', { game: 'safety' })] } }; })).toEqual(['bram: seasonal.pnw-usa.11[0] (bram-thermometer): duplicate question id, also at questions[5]']);
    // An agency named with no countries scope (Ruling 8), in any text.
    expect(with_((d) => { Reflect.deleteProperty(q(d, 'bram-usda-label'), 'countries'); })).toEqual(['bram: questions[4] (bram-usda-label): prompt names USDA but has no countries scope']);
    expect(with_((d) => { q(d, 'bram-thermometer').explain = 'The FSA says to cool rice within an hour.'; })).toEqual(['bram: questions[5] (bram-thermometer): explain names FSA but has no countries scope']);
    expect(with_((d) => { q(d, 'bram-thermometer').options[1].reaction = 'FSIS charts say otherwise.'; })).toEqual(['bram: questions[5] (bram-thermometer): options[1].reaction names FSIS but has no countries scope']);
    expect(with_((d) => { q(d, 'bram-usda-label').countries = []; })).toEqual(['bram: questions[4] (bram-usda-label): countries is not a non-empty list of country names']);
    // A faq entry with an empty q, in the base and the variant.
    expect(with_((d) => { d.faq[0].q = []; })).toEqual(['bram: faq[0].q is empty: it needs at least one non-empty question']);
    expect(with_((d) => { pc(d).faq[1].q = ['']; })).toEqual(['bram: variants.protein_counter.faq[1].q is empty: it needs at least one non-empty question']);
  });

  test('value question: correct option not the cheapest per serving → problem; a reaction "= 3.80" when the entry gives 3.75 → problem', () => {
    const reprice = (d: StallFile, price: number) => {
      board(d)[0].price = price;
      const v = q(d, 'bram-value-braise');
      v.prompt = v.prompt.replace('22.50', String(price));
      v.options[0].reaction = 'Chuck.';
      v.options[1].reaction = 'Half bone.';
    };
    expect(with_((d) => { reprice(d, 30); })).toEqual([
      'bram: questions[6] (bram-value-braise): options[0] is correct but is not the strict cheapest per serving',
    ]);
    // A tie is not a strict minimum: 24 ÷ 5 = 4.80, and 28.80 ÷ 6 = 4.80.
    expect(with_((d) => { reprice(d, 28.8); })).toEqual([
      'bram: questions[6] (bram-value-braise): options[0] is correct but is not the strict cheapest per serving',
    ]);
    expect(with_((d) => { q(d, 'bram-value-braise').options[0].reaction = 'Chuck: 22.50 ÷ 6 = 3.80 a serving.'; })).toEqual([
      'bram: questions[6] (bram-value-braise): options[0].reaction states 22.50 ÷ 6 = 3.80, but 22.50 ÷ 6 = 3.75',
    ]);
    // A bare "= N" is not a sum the player can follow: it needs its "A ÷ B".
    expect(with_((d) => { q(d, 'bram-value-braise').options[1].reaction = 'Chuck = 3.75.'; })).toEqual([
      'bram: questions[6] (bram-value-braise): options[1].reaction states "= 3.75" outside an "A ÷ B = C" sum',
    ]);
    // Shape: one entry per option, positive numbers, and only on a value question.
    expect(with_((d) => { board(d).pop(); })).toEqual(['bram: questions[6] (bram-value-braise): chalkboard needs one entry per option']);
    expect(with_((d) => { board(d)[2].servings = 0; })).toEqual(['bram: questions[6] (bram-value-braise): chalkboard[2] is not { price, servings } with positive numbers']);
    expect(with_((d) => { q(d, 'bram-value-braise').game = 'label'; })).toEqual(['bram: questions[6] (bram-value-braise): has a chalkboard but is not a value question']);
    // A value question that states a price needs a chalkboard.
    expect(with_((d) => { Reflect.deleteProperty(q(d, 'bram-value-braise'), 'chalkboard'); })).toEqual(['bram: questions[6] (bram-value-braise): prompt states a price but the question has no chalkboard']);
    expect(with_((d) => { q(d, 'bram-pc-lentils').options[1].reaction = 'Tempeh is 1.75 a serving.'; })).toEqual(['bram: variants.protein_counter.questions[0] (bram-pc-lentils): options[1].reaction states a price but the question has no chalkboard']);
    expect(with_((d) => { q(d, 'bram-pc-lentils').prompt = 'Lentils 1.79 a bag (7 servings): cheap?'; })).toEqual(['bram: variants.protein_counter.questions[0] (bram-pc-lentils): prompt states a price but the question has no chalkboard']);
  });

  test('a $ in a prompt or a ¢ in a reaction → problem; a value question about protein per 100 g needs no chalkboard', () => {
    expect(with_((d) => { q(d, 'bram-value-braise').prompt = q(d, 'bram-value-braise').prompt.replace('22.50', '$22.50'); })).toEqual(['bram: questions[6] (bram-value-braise): prompt has a currency symbol ($); chalkboard prices name no currency']);
    expect(with_((d) => { q(d, 'bram-pc-lentils').options[0].reaction = 'About 26¢ a serving.'; })).toEqual([
      'bram: variants.protein_counter.questions[0] (bram-pc-lentils): options[0].reaction has a currency symbol (¢); chalkboard prices name no currency',
      'bram: variants.protein_counter.questions[0] (bram-pc-lentils): options[0].reaction states a price but the question has no chalkboard',
    ]);
    for (const sym of ['£', '€', '¥', '₹', '₩', '₦', '₱']) expect(with_((d) => { q(d, 'bram-thermometer').explain = `Costs 3${sym}.`; }), sym).toHaveLength(1);
    // Comparisons that name no price.
    const noPrice = (prompt: string, reaction = 'Lentils win.') => with_((d) => {
      const x = q(d, 'bram-pc-lentils');
      x.prompt = prompt;
      x.options[0].reaction = reaction;
    });
    expect(noPrice('Which has the most protein per 100 g?', 'Lentils: about 9 g per 100 g cooked.')).toEqual([]);
    expect(noPrice('One pound (450 g) of dried black beans cooks up to about…', 'About 6 cups, or 12 servings.')).toEqual([]);
    expect(noPrice('Two tablespoons of peanut butter: mostly protein or mostly fat?')).toEqual([]);
  });

  test('never throws, whatever the input', () => {
    for (const d of [null, undefined, 3, 'bram', [], {}, { id: 'x', questions: [null, 1, { id: 2 }], variants: [], seasonal: { r: { 13: [], fallback: 'us-north' }, s: 'no' }, item_tips: [], faq: [null, { q: 'x' }] }]) {
      expect(() => validateStallFile(d, graph, opts)).not.toThrow();
      expect(validateStallFile(d, graph, opts).length).toBeGreaterThan(0);
    }
    expect(validateStallFile(null, graph, opts)).toEqual(['stall: not an object']);
    const odd = validateStallFile({ ...goodBram(), seasonal: { 'pnw-usa': { fallback: 'us-north', 11: [] } } }, graph, opts);
    expect(odd).toEqual(['bram: seasonal.pnw-usa.fallback: not a month 1–12']);
  });

  test('fix round 1, M5: the agency check ignores case and knows FSS, FSAI and the full names', () => {
    for (const text of ['The fsa says so.', 'Food Standards Scotland advises it.', 'FSS guidance.', 'The FSAI says so.', 'The Food Standards Agency says so.', 'Per the U.S. Food and Drug Administration.', 'The usda grades it.', 'The Food Safety Authority of Ireland says so.']) {
      expect(with_((d) => { q(d, 'bram-thermometer').explain = text; }), text).toHaveLength(1);
    }
    expect(with_((d) => { const x = q(d, 'bram-thermometer'); x.explain = 'Food Standards Scotland advises it.'; x.countries = ['Scotland']; })).toEqual([]);
    // Words that merely contain the letters are not agencies.
    expect(with_((d) => { q(d, 'bram-thermometer').explain = 'Fussy fsaish nhsx words.'; })).toEqual([]);
  });

  test('fix round 1, M6: an unknown country name in countries is a problem', () => {
    expect(with_((d) => { q(d, 'bram-usda-label').countries = ['Untied States']; })).toEqual(['bram: questions[4] (bram-usda-label): countries[0] "Untied States" is not a known country name']);
    expect(with_((d) => { q(d, 'bram-usda-label').countries = ['USA', 'Scotland']; })).toEqual([]);
  });

  // Fix round 1, I3 (Task 1 M4 ruling): chalkboard arithmetic is exact, and every figure is the board's.
  describe('fix round 1, I3: the chalkboard arithmetic is real', () => {
    const set = (d: StallFile, k: number, reaction: string) => { q(d, 'bram-value-braise').options[k].reaction = reaction; };
    const AT = 'bram: questions[6] (bram-value-braise)';
    test('a false sum fails: 24.00 ÷ 6 = 3.75', () => {
      expect(with_((d) => set(d, 0, 'Chuck: 24.00 ÷ 6 = 3.75 a serving.'))).toEqual([`${AT}: options[0].reaction states 24.00 ÷ 6, but its chalkboard entry is 22.50 for 6`]);
      expect(with_((d) => set(d, 0, 'Chuck: 22.50 ÷ 6 = 3.70 a serving.'))).toEqual([`${AT}: options[0].reaction states 22.50 ÷ 6 = 3.70, but 22.50 ÷ 6 = 3.75`]);
      // In the explain, a sum names some entry of the board, and must be true.
      expect(with_((d) => { q(d, 'bram-value-braise').explain = 'Divide: 38 ÷ 4 = 9.00.'; })).toEqual([`${AT}: explain states 38 ÷ 4 = 9.00, but 38 ÷ 4 = 9.50`]);
      expect(with_((d) => { q(d, 'bram-value-braise').explain = 'Divide: 30 ÷ 4 = 7.50.'; })).toEqual([`${AT}: explain states 30 ÷ 4, which is no chalkboard entry`]);
    });
    test('"≈" fails anywhere in a chalkboard question', () => {
      expect(with_((d) => set(d, 0, 'Chuck: 22.50 ÷ 6 ≈ 3.70 a serving.'))).toContain(`${AT}: options[0].reaction uses "≈"; chalkboard arithmetic is exact`);
      expect(with_((d) => set(d, 1, 'About ≈ 9.5. Chuck is 3.75.'))).toContain(`${AT}: options[1].reaction uses "≈"; chalkboard arithmetic is exact`);
    });
    test('an inexact entry fails: 22.49 for 6 is 3.748…', () => {
      expect(with_((d) => { board(d)[0].price = 22.49; set(d, 0, 'Chuck is the cheapest.'); q(d, 'bram-value-braise').prompt = q(d, 'bram-value-braise').prompt.replace('22.50', '22.49'); }))
        .toEqual([`${AT}: chalkboard[0] 22.49 ÷ 6 is not exact to the cent; pick numbers that divide exactly`]);
    });
    test('the prompt lists every board entry, in order, with the same numbers', () => {
      expect(with_((d) => { q(d, 'bram-value-braise').prompt = q(d, 'bram-value-braise').prompt.replace('22.50', '21.00'); }))
        .toEqual([`${AT}: prompt does not list chalkboard[0] (22.50 for 6) in order`]);
      expect(with_((d) => { q(d, 'bram-value-braise').prompt = q(d, 'bram-value-braise').prompt.replace('38 for 4', '38 for 5'); }))
        .toEqual([`${AT}: prompt does not list chalkboard[1] (38 for 4) in order`]);
      // An extra number between a price and its servings, or entries swapped, fails too.
      expect(with_((d) => { q(d, 'bram-value-braise').prompt = 'Shank 24 for 5; chuck 22.50 for 6 servings; short ribs 38 for 4.'; }))
        .toEqual([`${AT}: prompt does not list chalkboard[2] (24 for 5) in order`]);
    });
    test('a cross-option figure must be some option\'s price per serving: "Chuck is 3.50" fails', () => {
      expect(with_((d) => set(d, 1, 'Half bone: 38 ÷ 4 = 9.50 a serving. Chuck is 3.50.'))).toEqual([`${AT}: options[1].reaction states 3.50, which is no option's price per serving (3.75, 9.50, 4.80)`]);
      expect(with_((d) => set(d, 1, 'Half bone: 38 ÷ 4 = 9.50 a serving. Shank is 4.80, chuck 3.75.'))).toEqual([]);
    });
    test('the shipped wording passes: "60 ÷ 6 = 10" equals 10.00', () => {
      expect(with_((d) => { board(d)[2] = { price: 60, servings: 6 }; set(d, 2, '60 ÷ 6 = 10 a serving.'); q(d, 'bram-value-braise').prompt = 'Chuck 22.50 for 6 servings; short ribs 38 for 4; tenderloin 60 for 6.'; set(d, 1, 'Half bone: 38 ÷ 4 = 9.50 a serving. Chuck is 3.75.'); })).toEqual([]);
    });
  });

  test('fix round 1, M1: a currency symbol anywhere in a stall file fails the build, not only in a question', () => {
    expect(with_((d) => { d.triggers.greet.lines.push('That is £4 today.'); })).toEqual(['bram: triggers.greet.lines[1] has a currency symbol (£); stall prices name no currency']);
    expect(with_((d) => { pc(d).triggers.greet.lines[0] = 'That is ₹50.'; })).toEqual(['bram: variants.protein_counter.triggers.greet.lines[0] has a currency symbol (₹); stall prices name no currency']);
    expect(with_((d) => { d.item_tips.chuck = { pick: 'Marbled.', store: 'Fridge. About $8.' }; })).toEqual(['bram: item_tips.chuck.store has a currency symbol ($); stall prices name no currency']);
    expect(with_((d) => { d.faq.push({ q: ['Cost?'], a: 'About 3€.' }); })).toEqual(['bram: faq[3].a has a currency symbol (€); stall prices name no currency']);
  });

  test('fix round 1, I1: every keeper line declares the graph foods it names in its contains (by line index)', () => {
    expect(with_((d) => { d.triggers.idle = { ai: 'allowed', lines: ['Take your time.', "The chuck isn't going anywhere."] }; }))
      .toEqual(['bram: triggers.idle.lines[1] names "chuck" but its contains does not declare it (triggers.idle.contains["1"])']);
    expect(with_((d) => { d.triggers.idle = { ai: 'allowed', lines: ['Take your time.', "The chuck isn't going anywhere."], contains: { '1': ['chuck'] } }; })).toEqual([]);
    // A {var} is filled by code, not named by the line.
    expect(with_((d) => { d.triggers.idle = { ai: 'never', lines: ['No {item} today.'] }; })).toEqual([]);
    // The Protein Counter's lines too; a bad index or an unknown id fails.
    expect(with_((d) => { pc(d).triggers.greet = { ai: 'allowed', lines: ['Lentils today!'] }; }))
      .toEqual(['bram: variants.protein_counter.triggers.greet.lines[0] names "lentil" but its contains does not declare it (variants.protein_counter.triggers.greet.contains["0"])']);
    expect(with_((d) => { d.triggers.idle = { ai: 'allowed', lines: ['Hi.'], contains: { '3': ['beef'] } }; })).toEqual(['bram: triggers.idle.contains["3"] is not the index of a line']);
    expect(with_((d) => { d.triggers.idle = { ai: 'allowed', lines: ['Hi.'], contains: { '0': ['unobtainium'] } }; })).toEqual(['bram: triggers.idle.contains["0"] "unobtainium" is not in the ingredient graph']);
  });
});

