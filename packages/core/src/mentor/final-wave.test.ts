// M5 final review fix wave (final-review.md). Every probe of the review is a test here.
// I2: restriction and diet phrasings outside the N7 lists are health (when in doubt, health), and the weight-loss
// forms take a fixed deflection line, never the model.
import { describe, expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import ruleTerms from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import { classifyTurn } from './intents';
import type { RuleTerm } from './rule-terms';
import { codeCardHealth, isHealthText, preRoute } from './route';

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
