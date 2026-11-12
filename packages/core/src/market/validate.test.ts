import { describe, expect, test } from 'vitest';
import { BRAM, graph, question, SPICE, WEN } from './fixtures';
import type { StallFile, StallQuestion } from './types';
import { validateStallFile } from './validate';

const KNOWN = new Set(['cut_match', 'value', 'label', 'safety', 'sniff', 'freshness', 'substitute', 'ripeness', 'storage', 'seasonal']);
const opts = { knownGames: KNOWN };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A Bram file that passes: the fixture without its tofu question (tofu isn't in the graph), plus a priced value question. */
function goodBram(): StallFile {
  const d = clone(BRAM);
  pc(d).questions = pc(d).questions.filter((q: StallQuestion) => q.id !== 'bram-pc-tofu');
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
    expect(with_((d) => { q(d, 'bram-pc-lentils').options[2].contains = ['tofu']; })).toEqual(['bram: variants.protein_counter.questions[0] (bram-pc-lentils): options[2].contains "tofu" is not in the ingredient graph']);
    expect(problems(BRAM)).toEqual(['bram: variants.protein_counter.questions[3] (bram-pc-tofu): contains "tofu" is not in the ingredient graph']);
    // An unknown game for the stall, and a game key nothing knows.
    expect(with_((d) => { q(d, 'bram-braise-cut').game = 'sniff'; })).toEqual(['bram: questions[0] (bram-braise-cut): game "sniff" is not one of this stall\'s games']);
    expect(with_((d) => { Reflect.deleteProperty(q(d, 'bram-braise-cut'), 'game'); })).toEqual(['bram: questions[0] (bram-braise-cut): game undefined is not one of this stall\'s games']);
    expect(with_((d) => { d.games.darts = 'Throw things.'; })).toEqual(['bram: games.darts: not a known game']);
    // An item_tips key not in the graph, in the base and the variant.
    expect(with_((d) => { d.item_tips.wagyu = { pick: 'Marbled.', store: 'Fridge.' }; })).toEqual(['bram: item_tips.wagyu: not in the ingredient graph']);
    expect(with_((d) => { pc(d).item_tips.seitan = { pick: 'Springy.', store: 'Fridge.' }; })).toEqual(['bram: variants.protein_counter.item_tips.seitan: not in the ingredient graph']);
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
    expect(with_((d) => { board(d)[0].price = 30; q(d, 'bram-value-braise').options[0].reaction = 'Chuck.'; })).toEqual([
      'bram: questions[6] (bram-value-braise): options[0] is correct but is not the strict cheapest per serving',
    ]);
    // A tie is not a strict minimum: 24 ÷ 5 = 4.80, and 28.80 ÷ 6 = 4.80.
    expect(with_((d) => { board(d)[0].price = 28.8; q(d, 'bram-value-braise').options[0].reaction = 'Chuck.'; })).toEqual([
      'bram: questions[6] (bram-value-braise): options[0] is correct but is not the strict cheapest per serving',
    ]);
    expect(with_((d) => { q(d, 'bram-value-braise').options[0].reaction = 'Chuck: 22.50 ÷ 6 = 3.80 a serving.'; })).toEqual([
      'bram: questions[6] (bram-value-braise): options[0].reaction states = 3.80 but its chalkboard entry gives 3.75 a serving',
    ]);
    // A figure from another entry inside a reaction is checked against the reaction's own entry.
    expect(with_((d) => { q(d, 'bram-value-braise').options[1].reaction = 'Chuck = 3.75.'; })).toEqual([
      'bram: questions[6] (bram-value-braise): options[1].reaction states = 3.75 but its chalkboard entry gives 9.50 a serving',
    ]);
    // "≈" and figures with no "=" are not checked.
    expect(with_((d) => { q(d, 'bram-value-braise').options[1].reaction = 'About ≈ 9.5. Chuck is 3.75.'; })).toEqual([]);
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
});
