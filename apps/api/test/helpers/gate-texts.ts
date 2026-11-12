// The N6 and N7 probe texts (M5 fix round 4), shared by the direct gate test and the /mentor/turn smoke probes.
export const N6_TEXTS = [
  'remind me to eat dinner at 6pm, no wait, 7pm', 'remind me about dinner at 6pm, no, 7pm', 'remind me about dinner at 6pm, for my brother',
  'remind me about dinner at 6pm, my son too', 'remind me about dinner at 6pm, for my daughter', 'remind me about dinner at 6pm, yesterday',
  "remind me about dinner at 6pm, don't", 'remind me about dinner at 6pm, kidding', 'remind me about dinner at 6pm. never mind',
  'remind me about dinner at 6pm, actually no', 'my market day is saturday, for my brother', "my market day is saturday, my brother's",
  'my market day is saturday, not mine', 'my market day is saturday, actually no', 'my market day is saturday, maybe',
  'my market day is saturday, i think', 'my market day is saturday, used to be', 'my market day is saturday, last year',
  "market's saturday, or not", 'put parippu on monday, actually tuesday', 'put parippu on monday, no wait', 'put parippu on monday, or not',
  "put parippu on monday, don't", 'put parippu on monday, for my brother', 'put parippu on monday, last week', 'put parippu on monday, bitte',
  'put parippu on monday, por favor', 'pick 2, no mushrooms', 'pick 2. i hate mushrooms', 'pick 2. no spicy',
];

export const N7_TEXTS = [
  "market's saturday, i get headaches", "market's saturday, no beef", 'put parippu on monday, i have gout', 'put parippu on monday, no beef',
  'pick 2, no mushrooms', 'put parippu on monday. 🥜', 'put parippu on monday, sin cacahuetes', 'remind me to eat dinner at 6pm, no beef',
  'remind me to eat dinner at 6pm, or i get dizzy', 'remind me to eat dinner at 6pm, my blood sugar drops', 'remind me to eat dinner at 6pm, type 2',
  'remind me to eat dinner at 6pm, sugar free',
  ...[
    'beef free', 'sugar free', 'no sugar', 'no alcohol', "i'm fasting", 'ramadan', "it's lent", 'type 2', 'i have gout',
    'my cholesterol is high', 'high blood pressure', "i'm hypertensive", 'kidney disease', 'ckd', 'anemic', 'low iron',
    "i'm breastfeeding", 'i get dizzy', 'i feel shaky after', 'my throat gets scratchy', 'no mushrooms', 'no rice',
    'no lentils', 'no seaweed', 'no spice', 'not too spicy', 'nothing spicy', 'halal', 'kosher', 'low carb', '🦐', '🥛', '🌾',
  ].map((x) => `put parippu on monday, ${x}`),
];

