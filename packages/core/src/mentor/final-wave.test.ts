// M5 final review fix wave (final-review.md). Every probe of the review is a test here.
// I2: restriction and diet phrasings outside the N7 lists are health (when in doubt, health), and the weight-loss
// forms take a fixed deflection line, never the model.
import { describe, expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import ruleTerms from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import { classifyTurn } from './intents';
import type { RuleTerm } from './rule-terms';
import { canon } from '../week/fixtures';
import { codeCardHealth, correctionAsks, correctionCue, correctionScope, isHealthText, marketDayStated, planWordsIn, preRoute, reminderClauses, reminderSlots } from './route';

const DISHES = [...canon].map(([slug, r]) => ({ slug, title: r.meta.title }));
const graph = IngredientGraph.fromData(ingredients);
const terms = ruleTerms as RuleTerm[];

describe('I2: restriction and diet phrasings are health text', () => {
  const PROBES = [
    // the review's probes
    'im off sugar', "i'm off mushrooms", 'beans dont agree with me', "mushrooms don't agree with me", 'onions do not agree with me',
    'cutting carbs this month', 'cut sugar', 'fewer carbs', 'less bread', 'pas de lait', 'my doctor said fewer carbs', 'my gp told me to',
    'the dietitian says so', 'i am watching my weight', 'i need to lose weight',
    // the same forms on a word outside the graph
    'nothing with mushrooms', 'stay away from mushrooms', 'staying away from mushrooms', 'steer clear of mushrooms', "won't touch mushrooms",
    'keine milch', 'kein zucker', 'sem acucar', 'sem açúcar', 'bez cukru', 'geen suiker', 'sans sucre',
    // weight
    'weight loss', 'losing weight', 'i lost weight', 'my bmi', 'my weight', 'calorie counting', 'calorie deficit', 'counting calories',
  ];
  test.each(PROBES)('%s → isHealthText and codeCardHealth, alone and beside a plan clause', (p) => {
    expect(isHealthText(p, graph, terms)).toBe(true);
    for (const t of [p, `put parippu on monday, ${p}`, `plan my week: parippu sunday, ${p}`]) expect(codeCardHealth(t, graph, terms), t).toBe(true);
  });

  test('structural backstop: an avoid verb or a negator directly before any word', () => {
    for (const t of ['avoiding mushrooms', 'keep away from mushrooms', 'none of the mushrooms', 'never any mushrooms', "can't do mushrooms"]) {
      expect(isHealthText(t, graph, terms), t).toBe(true);
    }
  });

  test('plain plan, pick, reminder and market words stay non-health', () => {
    for (const t of ['put parippu on monday', 'pick 2 more', "market's saturday", 'remind me to eat dinner at 6pm', "i'm off to the market on saturday"]) {
      expect(codeCardHealth(t, graph, terms), t).toBe(false);
    }
  });
});

describe('I2: weight-loss forms take the fixed weight deflection, never the model', () => {
  test.each([
    'i need to lose weight', 'plan my week, I need to lose weight', 'i am watching my weight', 'weight loss tips', 'trying to lose some weight',
    'my bmi is high', 'calorie deficit plan', 'help me count calories', 'i want to slim down',
  ])('%s → weight', (t) => {
    expect(classifyTurn(t)).toBe('weight');
    expect(preRoute(classifyTurn(t))).toEqual({ trigger: 'rule.weight_deflect', vars: {} });
  });

  test('the emergency line, a child and a medical question still come first', () => {
    expect(classifyTurn('i need to lose weight and my throat is closing')).toBe('emergency');
    expect(classifyTurn("i'm 9 and i need to lose weight")).toBe('child');
    expect(classifyTurn('should i take tablets to lose weight')).toBe('medical');
  });
});

describe('m7: child self-statements', () => {
  test.each([
    'im 7yo', 'i’m 7yo', '7 yo', '8 y.o. here', 'im 8yrs', 'i am 9 yrs', 'im a kid', "i'm just a kid", 'i am a child', 'i am age 8', 'age 10',
    'ich bin 9 jahre alt', 'tengo 9 años', "j'ai 8 ans", 'tenho 10 anos', 'ho 9 anni',
  ])('%s → child', (t) => expect(classifyTurn(t)).toBe('child'));

  test('the emergency line still comes first', () => {
    expect(classifyTurn('im 7yo and my throat is closing')).toBe('emergency');
  });
});

describe('parked m3: "actually:" with punctuation is still a correction cue', () => {
  test.each(['put parippu on monday, actually: tuesday', 'put parippu on monday, actually- tuesday', 'put parippu on monday, actually, tuesday'])('%s', (t) => {
    expect(correctionCue(t, DISHES)).toBe(true);
    expect(correctionAsks(t, DISHES)).toContainEqual({ trigger: 'plan.which_day', vars: { dish: 'parippu' } });
    expect(planWordsIn(t, DISHES)).toBeNull();
  });
});

describe('parked m4: two clocks in one reminder clause are no card', () => {
  test.each(['remind me about dinner at 6pm 7pm', 'remind me about dinner at 6:30 7:30', 'remind me about dinner at half six half seven'])('%s', (t) => {
    expect(reminderSlots(t, DISHES)).toEqual([]);
    expect(reminderClauses(t)).toEqual([]);
  });
  test('one clock still makes its card', () => {
    expect(reminderSlots('remind me about dinner at 6pm', DISHES)).toEqual([{ name: 'dinner', start: '18:00' }]);
    expect(reminderSlots('remind me to eat lunch at like half twelve', DISHES)).toEqual([{ name: 'lunch', start: '12:30' }]);
    expect(reminderSlots('remind me about dinner at 6:30 pm', DISHES)).toEqual([{ name: 'dinner', start: '18:30' }]);
  });
});

describe('parked m5: a pantry clause is consumed only when every item it names is a food the graph knows', () => {
  test('non-food "pantry" clauses block code cards', () => {
    for (const t of ["ran out of patience, my market's saturday", "i got my brother. my market's saturday", "out of time. put onigiri on monday"]) {
      expect(marketDayStated(t, DISHES, graph), t).toBeNull();
      expect(planWordsIn(t, DISHES, graph), t).toBeNull();
    }
  });
  test('food pantry clauses are still consumed', () => {
    expect(marketDayStated("ran out of rice, my market's saturday", DISHES, graph)).toBe(6);
    expect(planWordsIn('bought spinach. put onigiri on monday', DISHES, graph)?.days).toEqual([{ weekday: 'monday', dish: 'onigiri' }]);
  });
  test('without the graph no pantry clause is consumed (never a guess)', () => {
    expect(marketDayStated("ran out of rice, my market's saturday", DISHES)).toBeNull();
  });
});

describe('m5: 5c drops only the corrected clause, not the whole message', () => {
  const T = 'remind me to eat dinner at 7, and parippu on monday, actually tuesday';
  test('the review probe: the dinner time stands, the corrected dish day does not', () => {
    const scope = correctionScope(T, DISHES)!;
    expect(scope).not.toBeNull();
    expect(scope.corrected('meal', 'dinner')).toBe(false);
    expect(scope.corrected('day', 'parippu')).toBe(true);
    expect(correctionAsks(T, DISHES)).toEqual([{ trigger: 'plan.which_day', vars: { dish: 'parippu' } }]);
  });
  test('the other half: a corrected time drops the time, and the dish day stands', () => {
    const t = 'put parippu on monday, and remind me to eat dinner at 6pm, no wait, 7pm';
    const scope = correctionScope(t, DISHES)!;
    expect(scope.corrected('day', 'parippu')).toBe(false);
    expect(scope.corrected('meal', 'dinner')).toBe(true);
    expect(correctionAsks(t, DISHES)).toEqual([{ trigger: 'profile.which_time', vars: { meal: 'dinner' } }]);
  });
  test('a correction that names no day, time, number or dish corrects everything (the safe side)', () => {
    const scope = correctionScope('remind me about dinner at 7, put parippu on monday, scratch that', DISHES)!;
    expect(scope.corrected('meal', 'dinner')).toBe(true);
    expect(scope.corrected('day', 'parippu')).toBe(true);
  });
  test('a part that is not in the player\'s words is corrected (never kept by guess)', () => {
    expect(correctionScope('put parippu on monday, actually tuesday', DISHES)!.corrected('day', 'onigiri')).toBe(true);
  });
  test('no cue, no scope', () => {
    expect(correctionScope('put parippu on monday', DISHES)).toBeNull();
  });
});

describe('m6: "pick 2, actually 3" gets the which-count ask', () => {
  test.each(['pick 2, actually 3', 'pick two, actually three', 'pick 2, no wait, 3', 'pick 2 dishes, actually make it 3'])('%s', (t) => {
    expect(correctionCue(t, DISHES)).toBe(true);
    expect(correctionAsks(t, DISHES)).toEqual([{ trigger: 'plan.which_count', vars: {} }]);
    expect(correctionScope(t, DISHES)!.corrected('pick', 'pick')).toBe(true);
    expect(planWordsIn(t, DISHES)).toBeNull();
  });
  test('"actually three" is no cue without a pick clause', () => {
    expect(correctionCue('i actually three times a week', DISHES)).toBe(false);
  });
});

describe('final re-review N1: cooking talk about fat is never a weight turn', () => {
  test.each([
    'this is too fatty', 'drop a little fat in the pan', 'lose the fat from the stock', 'burn the fat off the bacon',
    'trim the fat', 'skim the fat off the soup',
  ])('%s → not weight', (t) => {
    expect(classifyTurn(t)).not.toBe('weight');
  });
  test.each(['i need to lose some belly fat', 'i am too fat', 'burning body fat'])('%s → weight', (t) => {
    expect(classifyTurn(t)).toBe('weight');
  });
});
