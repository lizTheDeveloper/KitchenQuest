// M5 Step 8 fix round 4 (review-task8-fix2.md N6, N7, N9, N11). Every probe of the review is a test here.
// N6: a code card is built only when EVERY clause of the message is a closed clause or a closed neutral clause.
// N7: when in doubt, health: restriction patterns, food emoji, diet and religious terms, conditions and symptoms.
// N9: a child who spells out their age, or names a school year, is a child (before any code card).
// N11: the code-card exclusion keeps all of M4's health gate except the bare meal-time words.
import { describe, expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import ruleTerms from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import { canon } from '../week/fixtures';
import { classifyTurn } from './intents';
import type { RuleTerm } from './rule-terms';
import { codeCardHealth, correctionAsks, correctionCue, isHealthText, marketDayStated, planIntent, planWordsIn, reminderSlots } from './route';

const graph = IngredientGraph.fromData(ingredients);
const terms = ruleTerms as RuleTerm[];
const DISHES = [...canon].map(([slug, r]) => ({ slug, title: r.meta.title }));

describe('N6: every clause closed or neutral, else no code card for the whole message', () => {
  test('reminder probes: a correction, another person, a past day or a withdrawal in another clause → no card', () => {
    for (const t of [
      'remind me to eat dinner at 6pm, no wait, 7pm',
      'remind me about dinner at 6pm, no, 7pm',
      'remind me about dinner at 6pm, for my brother',
      'remind me about dinner at 6pm, my son too',
      'remind me about dinner at 6pm, for my daughter',
      'remind me about dinner at 6pm, yesterday',
      "remind me about dinner at 6pm, don't",
      'remind me about dinner at 6pm, kidding',
      'remind me about dinner at 6pm. never mind',
      'remind me about dinner at 6pm, actually no',
    ]) {
      expect(reminderSlots(t, DISHES), t).toEqual([]);
    }
  });

  test('market probes → no card', () => {
    for (const t of [
      'my market day is saturday, for my brother',
      "my market day is saturday, my brother's",
      'my market day is saturday, not mine',
      'my market day is saturday, actually no',
      'my market day is saturday, maybe',
      'my market day is saturday, i think',
      'my market day is saturday, used to be',
      'my market day is saturday, last year',
      "market's saturday, or not",
    ]) {
      expect(marketDayStated(t, DISHES), t).toBeNull();
    }
  });

  test('plan probes → no card', () => {
    for (const t of [
      'put parippu on monday, actually tuesday',
      'put parippu on monday, no wait',
      'put parippu on monday, or not',
      "put parippu on monday, don't",
      'put parippu on monday, for my brother',
      'put parippu on monday, last week',
      'pick 2, no mushrooms',
      'pick 2. i hate mushrooms',
      'pick 2. no spicy',
    ]) {
      expect(planWordsIn(t, DISHES), t).toBeNull();
      expect(planIntent(t, DISHES), t).toBeNull();
    }
  });

  test('the non-English filler probes ("bitte", "por favor", "s\'il vous plaît") → no card', () => {
    for (const t of ['put parippu on monday, bitte', 'put parippu on monday, por favor', "put parippu on monday, s'il vous plaît"]) {
      expect(planWordsIn(t, DISHES), t).toBeNull();
    }
    for (const t of ['my market day is saturday, bitte', 'remind me about dinner at 6pm, por favor']) {
      expect(marketDayStated(t, DISHES), t).toBeNull();
      expect(reminderSlots(t, DISHES), t).toEqual([]);
    }
  });

  test('closed clauses with closed neutral clauses still make their cards; closed clauses of different kinds combine', () => {
    expect(reminderSlots('remind me about dinner at 6pm, thanks', DISHES)).toEqual([{ name: 'dinner', start: '18:00' }]);
    expect(reminderSlots('ok, remind me about dinner at 6pm please', DISHES)).toEqual([{ name: 'dinner', start: '18:00' }]);
    expect(marketDayStated("ok, market's saturday", DISHES)).toBe(6);
    expect(planWordsIn('put parippu on monday, thank you', DISHES)?.days).toEqual([{ weekday: 'monday', dish: 'parippu' }]);
    expect(planIntent('plan my week: parippu on monday, thanks', DISHES)?.days).toEqual([{ weekday: 'monday', dish: 'parippu' }]);
    const mixed = "put onigiri on monday, my market's saturday and remind me about dinner at 6:30 pm";
    expect(planWordsIn(mixed, DISHES)?.days).toEqual([{ weekday: 'monday', dish: 'onigiri' }]);
    expect(reminderSlots(mixed, DISHES)).toEqual([{ name: 'dinner', start: '18:30' }]);
    expect(marketDayStated(mixed, DISHES)).toBeNull(); // two weekdays in the message
    expect(marketDayStated("market's saturday and remind me about dinner at 6:30 pm", DISHES)).toBe(6);
  });

  test('a neutral clause alone is no plan; a second pick or a second time for one meal is a doubt, so no card', () => {
    expect(planIntent('thanks', DISHES)).toBeNull();
    expect(planIntent('ok', DISHES)).toBeNull();
    expect(planWordsIn('pick 2, pick 3', DISHES)).toBeNull();
    expect(reminderSlots('remind me about dinner at 6pm and dinner at 7pm', DISHES)).toEqual([]);
  });

  test('without the dish list a plan clause is not closed, so a reminder next to it is no card (never a guess)', () => {
    expect(reminderSlots('put onigiri on monday, remind me about dinner at 6:30 pm')).toEqual([]);
  });
});

describe('N7: when in doubt, health (M4 gate and code-card exclusion)', () => {
  const PROBES = [
    // diets and religious restrictions
    'no beef', 'beef free', 'sugar free', 'no sugar', 'no alcohol', "i'm fasting", 'ramadan', "it's lent", 'halal', 'kosher', 'keto',
    'low carb', 'low fat', 'low salt', 'zero sugar', 'sin cacahuetes', 'without onions',
    // conditions
    'type 2', 'type 1', 'i have gout', 'my cholesterol is high', 'high blood pressure', "i'm hypertensive", 'kidney disease', 'ckd',
    'anemic', 'anaemic', 'low iron', "i'm breastfeeding", 'coeliac', 'celiac', 'ibs', "crohn's", "i'm pregnant", 'pku', 'diabetic',
    // symptoms
    'i get dizzy', 'i get headaches', 'i feel shaky after', 'my throat gets scratchy', 'nausea',
    // restrictions on foods outside the graph
    'no mushrooms', 'no rice', 'no lentils', 'no seaweed', 'no spice', 'not too spicy', 'nothing spicy',
    // other forms
    '🥜', '🦐', '🥛', '🌾',
  ];

  test('each probe is health text on its own and in a plan or market message', () => {
    for (const p of PROBES) {
      expect(isHealthText(p, graph, terms), p).toBe(true);
      for (const t of [`put parippu on monday, ${p}`, `market's saturday, ${p}`, `put parippu on monday. ${p}`]) {
        expect(isHealthText(t, graph, terms), t).toBe(true);
        expect(codeCardHealth(t, graph, terms), t).toBe(true);
      }
    }
  });

  test('the reminder probes: health, and no code card', () => {
    for (const p of ['no beef', 'or i get dizzy', 'my blood sugar drops', 'type 2', 'sugar free']) {
      const t = `remind me to eat dinner at 6pm, ${p}`;
      expect(codeCardHealth(t, graph, terms), t).toBe(true);
      expect(reminderSlots(t, DISHES), t).toEqual([]);
    }
  });

  test('plain plan, reminder and market words are not health beyond the meal-time words', () => {
    for (const t of ['put parippu on monday', 'pick 3', "market's saturday", 'my market day is saturday', 'remind me to eat dinner at 6pm', 'remind me about lunch at half twelve']) {
      expect(codeCardHealth(t, graph, terms), t).toBe(false);
    }
    // "no thanks" is a polite refusal, not a restriction.
    expect(isHealthText('no thanks', graph, terms)).toBe(false);
  });
});

describe('N9: a child who spells out their age', () => {
  test.each([
    'im seven, market\'s saturday',
    "i'm seven",
    'i am seven years old',
    "i'm twelve",
    'im seventeen',
    "i'm one",
    'seven years old',
    'a seven-year-old here',
    'year 4',
    'grade 3',
    "i'm in primary",
    'i go to elementary school',
    "i'm in 3rd grade",
  ])('%s → child', (t) => expect(classifyTurn(t)).toBe('child'));

  test('clock times and lengths of time are not ages', () => {
    for (const t of ["i'm seven thirty", "i'm ten minutes away", "I'm 12:30 free", "i'm one of those people who plan"]) expect(classifyTurn(t), t).not.toBe('child');
  });

  test('the emergency line still comes first', () => {
    expect(classifyTurn("i'm seven and my throat is closing")).toBe('emergency');
  });

  test('no code card for a child', () => {
    expect(marketDayStated("im seven, market's saturday", DISHES)).toBeNull();
    expect(planWordsIn("i'm twelve, put parippu on monday", DISHES)).toBeNull();
    expect(planIntent("i'm twelve. plan my week: parippu on monday", DISHES)).toBeNull();
    expect(reminderSlots('im nine. remind me about dinner at 6pm', DISHES)).toEqual([]);
  });
});

describe('N11: the code-card exclusion keeps all of HEALTH_PATTERN except the bare meal-time words', () => {
  test('the review probes are health for code cards', () => {
    for (const t of [
      "market's saturday, i'm on a diet",
      "market's saturday, i'm dieting",
      "market's saturday, mushrooms are rough after",
      "put parippu on monday, i'm on a diet",
      "put parippu on monday, i don't eat pork",
      "market's saturday, i avoid onions",
    ]) {
      expect(codeCardHealth(t, graph, terms), t).toBe(true);
    }
  });
});

describe('N10: each layer of the code-card exclusion, by behaviour', () => {
  test('codeCardHealth reads the diet cue on the text as written: a "no <meal>" restriction the meal-word mask would hide', () => {
    expect(codeCardHealth('my market day is saturday, no dinner', graph, terms)).toBe(true);
    expect(codeCardHealth('remind me about lunch at 1pm, no breakfast', graph, terms)).toBe(true);
  });

  test('the readers keep their own symptom and diet gate: a closed message whose dish title holds a health word makes no reminder or market card', () => {
    const dishes = [...DISHES, { slug: 'test/tummy-soup', title: 'Tummy Soup' }, { slug: 'test/keto-bowl', title: 'Keto Bowl' }];
    expect(reminderSlots('put the tummy soup on monday and remind me about dinner at 6pm', dishes)).toEqual([]);
    expect(marketDayStated("put the tummy soup on saturday and my market's saturday", dishes)).toBeNull();
    expect(reminderSlots('put the keto bowl on monday and remind me about dinner at 6pm', dishes)).toEqual([]);
    // The same messages with a plain title make their cards.
    expect(reminderSlots('put onigiri on monday and remind me about dinner at 6pm', dishes)).toEqual([{ name: 'dinner', start: '18:00' }]);
    expect(marketDayStated("put onigiri on saturday and my market's saturday", dishes)).toBe(6);
  });
});

describe('fix round 5 (5a): every clause consumed by an existing grammar or a closed neutral filler', () => {
  test('the fillers idk, lol, ok, please, thanks (also, and, so already break clauses) are neutral', () => {
    for (const t of ['idk put parippu on monday', 'put parippu on monday lol', 'ok put parippu on monday please', 'put parippu on monday thanks', 'so put parippu on monday']) {
      expect(planWordsIn(t, DISHES)?.days, t).toEqual([{ weekday: 'monday', dish: 'parippu' }]);
    }
    expect(reminderSlots('idk, remind me about dinner at 6pm lol', DISHES)).toEqual([{ name: 'dinner', start: '18:00' }]);
  });

  test('a greeting is no filler of the ruled list: no card', () => {
    for (const t of ["hi pan, market's saturday", "cheers, market's saturday", "great, market's saturday"]) expect(marketDayStated(t, DISHES), t).toBeNull();
  });

  test("a clause M4's meal-log parser reads whole is consumed", () => {
    expect(planWordsIn('had toast for lunch. put onigiri on monday', DISHES)?.days).toEqual([{ weekday: 'monday', dish: 'onigiri' }]);
    expect(reminderSlots('i ate porridge for breakfast, remind me about dinner at 6:30 pm', DISHES)).toEqual([{ name: 'dinner', start: '18:30' }]);
    // Not a meal M4 reads ("had a long day"), or not the player's own clause: not consumed.
    expect(planWordsIn('had a long day. put onigiri on monday', DISHES)).toBeNull();
    expect(planWordsIn('my brother had toast. put onigiri on monday', DISHES)).toBeNull();
  });

  test("a clause M4's pantry parser reads whole is consumed", () => {
    expect(marketDayStated("ran out of rice, my market's saturday", DISHES)).toBe(6);
    expect(planWordsIn('i finished the rice. put onigiri on monday', DISHES)?.days).toEqual([{ weekday: 'monday', dish: 'onigiri' }]);
    expect(planWordsIn('bought spinach. put onigiri on monday', DISHES)?.days).toEqual([{ weekday: 'monday', dish: 'onigiri' }]);
    expect(planWordsIn('my mum finished the rice. put onigiri on monday', DISHES)).toBeNull();
  });

  test('no form is added for an eval text: T08\'s "idk just pick 3 things…" and "do the beans after that" stay unconsumed', () => {
    const t08 = "idk just pick 3 things for this week. market's saturday so do the beans after that";
    expect(marketDayStated(t08, DISHES)).toBeNull();
    expect(planWordsIn(t08, DISHES)).toBeNull();
    const t13 = "Had dal for dinner. Also put the frijoles on Saturday's plan, and remind me about dinner at 6:30 pm.";
    expect(reminderSlots(t13, DISHES)).toEqual([]);
  });
});

describe('fix round 5 (5c): a correction cue means no plan or profile card for the message, and an ask', () => {
  test('the cues', () => {
    for (const t of ['dinner at 6pm, no wait, 7pm', 'put parippu on monday, actually tuesday', 'onigiri instead', 'scratch that, lunch at 1', 'i mean tuesday', 'I meant Friday'])
      expect(correctionCue(t), t).toBe(true);
    for (const t of ['remind me about dinner at 6pm', 'put parippu on monday', 'no thanks', 'my market day is saturday']) expect(correctionCue(t), t).toBe(false);
  });

  test('no code card from a corrected message, even when every clause is closed', () => {
    expect(planIntent('plan my week: parippu on monday, actually', DISHES)).toBeNull();
    expect(planWordsIn('put parippu on monday instead', DISHES)).toBeNull();
    expect(planWordsIn('i mean, put parippu on tuesday', DISHES)).toBeNull();
    expect(reminderSlots('i mean, remind me about dinner at 7pm', DISHES)).toEqual([]);
    expect(marketDayStated("actually, market's sunday", DISHES)).toBeNull();
  });

  test('the asks: which time for a timed meal, which day for a named dish, the market day for a market day', () => {
    expect(correctionAsks('remind me to eat dinner at 6pm, no wait, 7pm', DISHES)).toEqual([{ trigger: 'profile.which_time', vars: { meal: 'dinner' } }]);
    expect(correctionAsks('put parippu on monday, actually tuesday', DISHES)).toEqual([{ trigger: 'plan.which_day', vars: { dish: 'parippu' } }]);
    expect(correctionAsks('my market day is saturday, actually sunday', DISHES)).toEqual([{ trigger: 'intake.market_day.ask', vars: {} }]);
    expect(correctionAsks('put parippu on monday', DISHES)).toEqual([]);
  });
});

describe('adjudication B: the narrowed correction cues', () => {
  test('"actually" is a cue only when a time, weekday or dish follows within 3 words', () => {
    expect(correctionCue('I actually like parippu', DISHES)).toBe(false);
    expect(correctionCue('i actually love mondays at the market', DISHES)).toBe(false);
    for (const t of ['dinner at 6, actually 7', 'put parippu on monday, actually tuesday', 'actually make it 7pm', 'actually, the onigiri', 'put it on monday, actually on friday'])
      expect(correctionCue(t, DISHES), t).toBe(true);
    // The other cues are unchanged.
    for (const t of ['dinner at 6pm, no wait, 7pm', 'onigiri instead', 'i mean tuesday']) expect(correctionCue(t, DISHES), t).toBe(true);
  });

  test('"dinner at 6, actually 7" asks which time; "I actually like parippu" asks nothing', () => {
    expect(correctionAsks('remind me to eat dinner at 6, actually 7', DISHES)).toEqual([{ trigger: 'profile.which_time', vars: { meal: 'dinner' } }]);
    expect(correctionAsks('I actually like parippu', DISHES)).toEqual([]);
    expect(planWordsIn('I actually like parippu. put parippu on monday', DISHES)).toBeNull(); // "i actually like parippu" is no closed clause
  });

  test('"no wait" is no restriction (N7 exception, like money and time)', () => {
    expect(isHealthText('remind me to eat dinner at 6pm, no wait, 7pm', graph, terms)).toBe(true); // the meal time, M4's gate
    expect(codeCardHealth('put parippu on monday, no wait', graph, terms)).toBe(false);
    expect(isHealthText('put parippu on monday, no wait', graph, terms)).toBe(false);
    expect(isHealthText('put parippu on monday, no wheat', graph, terms)).toBe(true);
  });
});
