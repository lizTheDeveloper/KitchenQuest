import { describe, expect, test } from 'vitest';
import { check } from '../rules/check';
import type { Rule } from '../rules/types';
import { faqFor, questionStatus, stallBank, stallVariant, tipFor } from './bank';
import { normalizeCountry } from './country';
import { ALLERGEN_LINE, avoid, BRAM, ctx, DAY, graph, MEDICAL_LINE, NO_PORK, question, SEASONAL_STRAWBERRY, SPICE, subs, VEGAN, VEGETARIAN, WEN } from './fixtures';

const ids = (rules: Rule[], stall = BRAM, over = {}) => stallBank(stall, ctx(rules, over)).questions.map((q) => q.id);
const FODMAP: Rule = { id: 'r-fodmap', target: { kind: 'category', ids: ['fodmap_fructan'] }, type: 'avoid', severity: 'intolerance' };
const SOY = avoid('soy');
const COELIAC: Rule = { id: 'r-coeliac', target: { kind: 'component', ids: ['gluten'] }, type: 'avoid', severity: 'allergy' };

describe('questionStatus and stallBank (spec §2.2, §3.5)', () => {
  test('a question whose contains is blocked is dropped; one whose correct option names a blocked item is dropped', () => {
    const beef = avoid('beef');
    expect(questionStatus(BRAM.questions[0], ctx([beef]))).toBe('blocked');
    expect(ids([beef])).not.toContain('bram-braise-cut');
    expect(ids([beef])).toContain('bram-curry-chicken');
    // The correct option's own contains (no question-level contains).
    const q = question('t-opt', { options: [{ text: 'This one', correct: true, reaction: 'Yes.', contains: ['chickpea'] }, { text: 'B', correct: false, reaction: 'No.' }, { text: 'C', correct: false, reaction: 'No.' }] });
    expect(questionStatus(q, ctx([avoid('chickpea')]))).toBe('blocked');
    expect(questionStatus(q, ctx([avoid('cumin_seed')]))).toBe('ok');
    // A wrong option naming a blocked item drops it too: anything the question names.
    const wrong = question('t-wrong', { options: [{ text: 'A', correct: true, reaction: 'Yes.' }, { text: 'Peanuts', correct: false, reaction: 'No.' }, { text: 'C', correct: false, reaction: 'No.' }] });
    expect(questionStatus(wrong, ctx([avoid('peanut')]))).toBe('blocked');
  });

  test('a curated swap never keeps a question: lard under "no pork", garlic under a fructan rule, soy sauce under a soy rule are dropped although subs has swaps for them', () => {
    // The swaps exist, and the rules engine would offer them for a recipe line.
    for (const [rules, name] of [[[NO_PORK], 'lard'], [[FODMAP], 'garlic'], [[SOY], 'soy sauce']] as const) {
      const r = check({ meta: { title: 't', country: '', region: '', credit: '', cook: '', difficulty: 1, skills: [], servings: 1, license: '', status: 'draft', sacred: false, contributors: [] }, ingredients: [{ name, displayName: null, quantity: null, unit: null, note: null }], timers: [], steps: [], source: '' }, [...rules], graph, subs, DAY);
      expect(r.findings.some((f) => f.swap !== undefined), name).toBe(true);
    }
    expect(questionStatus(BRAM.questions[3], ctx([NO_PORK], { subs }))).toBe('blocked');
    expect(ids([NO_PORK])).not.toContain('bram-lard-pastry');
    expect(questionStatus(WEN.questions[1], ctx([FODMAP], { subs }))).toBe('blocked');
    expect(ids([FODMAP], WEN)).not.toContain('wen-garlic-store');
    expect(questionStatus(WEN.questions[2], ctx([SOY], { subs }))).toBe('blocked');
    expect(ids([SOY], WEN)).not.toContain('wen-soy-sauce');
  });

  test('a question that only NAMES a blocked item in its prompt text (no contains) is dropped: textMentions counts', () => {
    const hing = SPICE.questions[0];
    expect(hing.contains).toBeUndefined();
    expect(questionStatus(hing, ctx([avoid('allium')]))).toBe('blocked'); // "onion and garlic" in the prompt
    expect(questionStatus(hing, ctx([COELIAC]))).toBe('blocked'); // the Spice Merchant's asafoetida answer for a coeliac
    expect(ids([COELIAC], SPICE)).toEqual(['spice-cumin']);
    // In a reaction or the explanation, too.
    const inReaction = question('t-react', { options: [{ text: 'A', correct: true, reaction: 'Like peanuts, but not.' }, { text: 'B', correct: false, reaction: 'No.' }, { text: 'C', correct: false, reaction: 'No.' }] });
    expect(questionStatus(inReaction, ctx([avoid('peanut')]))).toBe('blocked');
    expect(questionStatus(question('t-explain', { explain: 'Sesame seeds toast fast.' }), ctx([avoid('sesame')]))).toBe('blocked');
    // A plural counts.
    expect(questionStatus(question('t-plural', { prompt: 'Which strawberries are ripe?' }), ctx([avoid('strawberry')]))).toBe('blocked');
  });

  test('❓ is never shown: a label-dependent item named in a question drops it under any restricting rule', () => {
    // Soy sauce is label-dependent: under an unrelated rule it can't be verified.
    expect(questionStatus(WEN.questions[2], ctx([avoid('peanut')]))).toBe('unverified');
    expect(ids([avoid('peanut')], WEN)).not.toContain('wen-soy-sauce');
    // With no rules at all there is nothing to verify against.
    expect(questionStatus(WEN.questions[2], ctx([]))).toBe('ok');
    // A category the line might be (meat → pork) under a partial rule is ❓ too.
    expect(questionStatus(question('t-meat', { prompt: 'Which meat for a stew?' }), ctx([NO_PORK]))).toBe('unverified');
  });

  test('an unknown contains id makes the question ❓, never ok', () => {
    const tofu = BRAM.variants!.protein_counter!.questions.find((q) => q.id === 'bram-pc-tofu')!;
    expect(graph.has('tofu')).toBe(false);
    expect(questionStatus(tofu, ctx([]))).toBe('unverified');
    expect(questionStatus(tofu, ctx([SOY]))).toBe('unverified'); // a tofu question for a soy rule, while tofu isn't in the graph
    expect(ids([VEGETARIAN])).not.toContain('bram-pc-tofu');
    // An unknown id beside a blocked one is still at least ❓ (here ⛔, the worse).
    expect(questionStatus(question('t-both', { contains: ['tofu', 'beef'] }), ctx([avoid('beef')]))).toBe('blocked');
    // Nothing named at all is ✅.
    expect(questionStatus(BRAM.questions[5], ctx([VEGAN]))).toBe('ok');
  });

  test('vegetarian rule (meat ⛔) → protein_counter; "no pork" only → base with pork and lard questions dropped', () => {
    expect(stallVariant(BRAM, ctx([]))).toBe('base');
    expect(stallVariant(BRAM, ctx([VEGETARIAN]))).toBe('protein_counter');
    expect(stallVariant(BRAM, ctx([avoid('meat')]))).toBe('protein_counter'); // a custom rule covering all meat
    const veg = stallBank(BRAM, ctx([VEGETARIAN]));
    expect(veg.variant).toBe('protein_counter');
    expect(veg.questions.map((q) => q.id)).toEqual(['bram-pc-lentils', 'bram-pc-eggs', 'bram-pc-paneer', 'bram-pc-chickpeas']);
    // Bram's beef braise never reaches a vegetarian.
    expect(veg.questions.some((q) => q.id.startsWith('bram-') && !q.id.startsWith('bram-pc-'))).toBe(false);

    expect(stallVariant(BRAM, ctx([NO_PORK]))).toBe('base');
    const pork = stallBank(BRAM, ctx([NO_PORK]));
    expect(pork.variant).toBe('base');
    expect(pork.questions.map((q) => q.id)).toEqual(['bram-braise-cut', 'bram-curry-chicken', 'bram-thermometer']);
    // A stall with no Protein Counter is always base, whatever the rules.
    expect(stallVariant(SPICE, ctx([VEGAN]))).toBe('base');
  });

  test('vegan → protein_counter with egg and milk questions dropped', () => {
    const b = stallBank(BRAM, ctx([VEGAN]));
    expect(b.variant).toBe('protein_counter');
    expect(b.questions.map((q) => q.id)).toEqual(['bram-pc-lentils', 'bram-pc-chickpeas']);
  });

  test('countries scope: a [United States] question shows for country "USA"/"United States", not for "UK" or null', () => {
    for (const c of ['USA', 'United States', 'U.S.A.', 'united states of america', 'US']) expect(ids([], BRAM, { country: c }), c).toContain('bram-usda-label');
    for (const c of ['UK', 'United Kingdom', 'Canada', '', null]) expect(ids([], BRAM, { country: c }), String(c)).not.toContain('bram-usda-label');
    // The scope's own names normalise too.
    const scoped = { ...BRAM, questions: [question('t-uk', { countries: ['Great Britain'] })] };
    expect(ids([], scoped, { country: 'UK' })).toEqual(['t-uk']);
    expect(ids([], scoped, { country: 'England' })).toEqual(['t-uk']);
    expect(ids([], scoped, { country: 'Ireland' })).toEqual([]);
    expect(ids([], { ...BRAM, questions: [question('t-empty', { countries: [] })] }, { country: 'USA' })).toEqual([]);
  });

  test('normalizeCountry folds case, accents, punctuation and common names to one', () => {
    expect(normalizeCountry('  México ')).toBe('mexico');
    expect(normalizeCountry('Côte d’Ivoire')).toBe(normalizeCountry('Ivory Coast'));
    expect(normalizeCountry('The Netherlands')).toBe('netherlands');
    expect(normalizeCountry('Holland')).toBe('netherlands');
    expect(normalizeCountry('U.K.')).toBe('united kingdom');
    expect(normalizeCountry('Türkiye')).toBe(normalizeCountry('Turkey'));
    expect(normalizeCountry('...')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
  });

  test('stallBank reports how many were dropped, never which', () => {
    const b = stallBank(BRAM, ctx([NO_PORK]));
    expect(b.dropped).toBe(3); // pork, lard and the US-only label (no country)
    expect(Object.keys(b).sort()).toEqual(['dropped', 'questions', 'variant']);
    expect(JSON.stringify(b)).not.toContain('bram-pork-shoulder');
    expect(JSON.stringify(b)).not.toContain('bram-lard-pastry');
    expect(stallBank(BRAM, ctx([], { country: 'USA' })).dropped).toBe(0);
  });

  test('seasonal questions are filtered the same way: a seasonal round naming strawberries for a strawberry allergy', () => {
    expect(stallBank(WEN, ctx([]), [SEASONAL_STRAWBERRY]).questions.map((q) => q.id)).toContain('wen-pnw-6-strawberry');
    const b = stallBank(WEN, ctx([avoid('strawberry')]), [SEASONAL_STRAWBERRY]);
    expect(b.questions.map((q) => q.id)).not.toContain('wen-pnw-6-strawberry');
    expect(b.dropped).toBe(2); // and the soy sauce question: label-dependent, ❓ under any rule
    expect(stallBank(WEN, ctx([])).questions).toHaveLength(WEN.questions.length);
  });

  test('tipFor: null for a ⛔ or ❓ item; faqFor: a_if_blocked when the answer names a ⛔ or ❓ item, else the generic line (allergen_note at the spice stall)', () => {
    expect(tipFor(BRAM, 'chuck', ctx([]))).toEqual(BRAM.item_tips.chuck);
    expect(tipFor(BRAM, 'chuck', ctx([avoid('beef')]))).toBeNull(); // ⛔ through the graph
    expect(tipFor(BRAM, 'chicken_thigh', ctx([NO_PORK]))).not.toBeNull();
    expect(tipFor(BRAM, 'pork', ctx([NO_PORK]))).toBeNull();
    expect(tipFor(BRAM, 'cabbage', ctx([NO_PORK]))).toBeNull(); // its text names lard
    expect(tipFor(BRAM, 'cabbage', ctx([]))).not.toBeNull();
    expect(tipFor(BRAM, 'nothing_here', ctx([]))).toBeNull();
    expect(tipFor(SPICE, 'asafoetida', ctx([COELIAC]))).toBeNull();
    expect(tipFor(SPICE, 'asafoetida', ctx([avoid('peanut')]))).not.toBeNull();
    // ❓: an item the graph doesn't know, and a label-dependent one under any rule.
    const odd = { ...SPICE, item_tips: { tofu: { pick: 'Firm.', store: 'In water.' }, soy_sauce: { pick: 'Brewed.', store: 'Cupboard.' } } };
    expect(tipFor(odd, 'tofu', ctx([]))).toBeNull();
    expect(tipFor(odd, 'soy_sauce', ctx([avoid('peanut')]))).toBeNull();
    // The Protein Counter's own tips.
    expect(tipFor(BRAM, 'paneer', ctx([VEGETARIAN]))).toEqual(BRAM.variants!.protein_counter!.item_tips.paneer);
    expect(tipFor(BRAM, 'paneer', ctx([VEGAN]))).toBeNull();
    expect(tipFor(BRAM, 'chuck', ctx([VEGETARIAN]))).toBeNull();

    // FAQ: the plain answer when it names nothing the rules hit.
    expect(faqFor(BRAM, ctx([]))).toEqual([
      { q: 'how much meat per person', a: 'About 150–225 g of raw meat per person.' },
      { q: 'is pink pork safe', a: 'Whole cuts of pork are safe at 63°C with a rest.' },
      { q: 'what fat for pastry', a: 'Lard makes it flaky.' },
    ]);
    const noPork = faqFor(BRAM, ctx([NO_PORK]));
    expect(noPork[0].a).toBe(MEDICAL_LINE); // "meat" is ❓ under a partial rule, and there is no a_if_blocked
    expect(noPork[1].a).toBe('Use a thermometer for any whole cut.');
    expect(noPork[2].a).toBe(MEDICAL_LINE); // lard: ⛔, no a_if_blocked
    // At the Protein Counter, its own FAQ; a_if_blocked is itself checked.
    expect(faqFor(BRAM, ctx([VEGETARIAN, SOY]))[0]).toEqual({ q: 'is tempeh fermented', a: 'Ask me about chickpeas instead: they keep for a year.' });
    expect(faqFor(BRAM, ctx([VEGETARIAN, SOY, avoid('chickpea')]))[0]).toEqual({ q: 'is tempeh fermented', a: MEDICAL_LINE });
    // The spice stall has no medical line: its allergen note.
    expect(faqFor(SPICE, ctx([COELIAC]))[0]).toEqual({ q: 'spice blend allergens', a: ALLERGEN_LINE });
    expect(faqFor(SPICE, ctx([]))[0].a).toBe('Asafoetida usually has wheat flour in it.');
    // Nothing safe to say → the entry is left out.
    const silent = { ...SPICE, triggers: {} };
    expect(faqFor(silent, ctx([COELIAC])).map((f) => f.q)).toEqual(['how long do spices last']);
  });

  test('the check runs on the local date: a phased rule only bites while it is active', () => {
    const phased: Rule = { ...avoid('beef'), phase: { start: '2026-11-01', end: '2026-11-30' } };
    expect(ids([phased])).not.toContain('bram-braise-cut');
    expect(ids([phased], BRAM, { date: '2026-12-05' })).toContain('bram-braise-cut');
  });

  test('fix round 1, C1: a name past character 500 of the joined texts counts (the 572-character explain)', () => {
    const explain = `${'Bram taps the chalkboard and talks about cost per serving for a long while. '.repeat(7)}Peanuts are the cheapest protein of all.`;
    expect(explain.length).toBeGreaterThan(560);
    const q = question('t-long', { explain });
    expect(questionStatus(q, ctx([avoid('peanut')]))).toBe('blocked');
    expect(stallBank({ ...BRAM, questions: [q] }, ctx([avoid('peanut')])).questions).toEqual([]);
    expect(questionStatus(q, ctx([avoid('sesame')]))).toBe('ok');
  });
});

