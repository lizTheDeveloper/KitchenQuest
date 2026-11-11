import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { STALL_IDS } from '@kitchenquest/core';
import { REQUIRED_PAN_TRIGGERS } from '../../src/content/required';
import { compileContent, ContentError } from './compile';
import { readContentFiles } from './read';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

// ---- a minimal valid file set --------------------------------------------------------------
const trigger = (extra = '') => `    ai: never\n    when: test\n    lines:\n      - "a line"\n${extra}`;
const pan = (omit: string[] = []) =>
  `triggers:\n${REQUIRED_PAN_TRIGGERS.filter((t) => !omit.includes(t))
    .map((t) => `  ${t}:\n${trigger()}`)
    .join('')}`;

const option = (text: string, correct: boolean) => `{ text: "${text}", correct: ${correct}, reaction: "r" }`;
const options = (n: number, correct = 1) =>
  `[${Array.from({ length: n }, (_, i) => option(`o${i}`, i < correct)).join(', ')}]`;

const cook = (over: { id?: string; recipe?: string; questCook?: string; requires?: string; steps?: string; trust?: string } = {}) => `
id: ${over.id ?? 'ann'}
name: "Ann"
place: "Nowhere"
dish: "Dish"
recipe: ${over.recipe ?? 'x/y/z'}
persona: ["p"]
intro: ["i"]
story: ["s"]
quest:
  id: ann-quest
  cook: ${over.questCook ?? 'ann'}
  title: "T"
  unlock: { requires: [${over.requires ?? ''}], trust: 0 }
  steps:
${over.steps ?? '    - { type: talk, lines: ["hi"] }'}
  rewards: { xp: 1, trust: 1, skills: {} }
gift: ["g"]
trust_lines:
  ${over.trust ?? '1'}: ["t"]
reactions: { photo: ["p"], skip_photo: ["s"] }
introduction: ["i"]
faq: []
`;

const stall = (questionOptions = options(3), id = 'wen') => `
id: ${id}
name: "Stall ${id}"
persona: ["p"]
triggers:
  greet:
${trigger()}
questions:
  - id: q1
    prompt: "P"
    options: ${questionOptions}
    explain: "E"
variants:
  alt:
    questions:
      - id: q2
        prompt: "P"
        options: ${options(3)}
        explain: "E"
`;

const M5_FORMS = ['plan', 'margin_note', 'cooked_for', 'technique_certificate', 'frame'];
const bureau = (
  over: { stamp?: string; noTravel?: boolean; tag?: string; noCrossContact?: boolean; noAiCharacters?: boolean; omitForm?: string; noGeneralStall?: boolean; omitStampName?: string } = {},
) => {
  const form = (stamp: string, fields = '[]') =>
    `    number: "1"\n    title: "T"\n    fields: ${fields}\n    buttons: { confirm: "ok" }\n    stamp: ${stamp}\n`;
  const marketFields = over.noGeneralStall ? '[{ key: stall, label: "Stall" }]' : '[{ key: stall, label: "Stall" }, { key: general_stall, label: "The Counter" }]';
  const m5 = M5_FORMS.filter((f) => f !== over.omitForm).map((f) => `  ${f}:\n${form('approved')}`).join('');
  const market = over.omitForm === 'market_list' ? '' : `  market_list:\n${form('approved', marketFields)}`;
  const stampNames = ['quest_done', 'certificate', 'market_run'].filter((k) => k !== over.omitStampName).map((k) => `  ${k}: "${k}"\n`).join('');
  return `forms:
${over.noTravel ? '' : `  travel:\n${form(over.stamp ?? 'approved')}`}  certificate:\n${form('approved')}${m5}${market}stamps:
  approved: "APPROVED"
stamp_names:
  travel: "Travel"
${stampNames}footnotes:
  - { tag: ${over.tag ?? 'any'}, text: "*x" }
disclaimers:
  allergy: "plain"
${over.noCrossContact ? '' : '  cross_contact: "boards"\n'}  unverified: "label"
${over.noAiCharacters ? '' : '  ai_characters: "AI"\n'}`;
};

const recipe = (over: { cook?: string; skills?: string; timer?: string } = {}) => `---
title: Z
country: X
region: Y
credit: me
cook: ${over.cook ?? 'ann'}
difficulty: 1
skills: [${over.skills ?? 'knife'}]
servings: 2
license: CC-BY-SA-4.0
status: draft
---
Chop @onion{1} and wait. ${over.timer ?? '~{5%minutes}'}
`;

const ruleTerm = (name: string, phrases: string[], ids: string[]) => ({ name, phrases, ids, severity: null, form: 'rule_diet' });
const ruleTerms = (terms = [ruleTerm('no onion', ['no onion', 'onion free'], ['onion'])]) => JSON.stringify(terms);

const techniques = (warm = 42, rusty = 120, adjacent = '') =>
  `freshness: { warm_after_days: ${warm}, rusty_after_days: ${rusty} }\ntechniques:\n  - { id: knife, name: "Knife", adjacent: [${adjacent}], prereqs: [] }\n  - { id: stir-fry, name: "Stir-frying", adjacent: [], prereqs: [knife] }\n`;

const rewards = (levels = '[100, 250]') => `xp:
  lesson: 10
  drill: 10
  cook: 30
  frame: 20
  market_run: 20
  refresh: 15
  nourishment: { per_log: 5, max_per_day: 3, min_gap_minutes: 120 }
levels: ${levels}
stamps: { quest_done: 1, certificate: 1, market_run: 1 }
trust:
  names: [Stranger, Guest, Acquainted]
  weeks_for_level: [2]
`;

const frame = (over: { id?: string; accepts?: string; technique?: string } = {}) => `
id: ${over.id ?? 'onion-fry'}
title: "Fried onion"
technique: ${over.technique ?? 'stir-fry'}
status: draft
credit: "Drafted by Kitchen Quest editors"
slots:
  - { key: veg, accepts: [${over.accepts ?? 'onion'}], optional: false }
steps:
  - "Fry {veg}."
rescues: [onion]
`;

function valid(): Record<string, string> {
  return {
    'content/dialogue/pan.yaml': pan(),
    'content/cooks/ann.yaml': cook(),
    'content/market/wen.yaml': stall(),
    'content/market/bram.yaml': stall(options(3), 'bram'),
    'content/market/okafor-sato.yaml': stall(options(3), 'okafor-sato'),
    'content/market/spice.yaml': stall(options(3), 'spice'),
    'content/frames/onion-fry.yaml': frame(),
    'content/bureau/forms.yaml': bureau(),
    'recipes/x/y/z.cook': recipe(),
    'data/ingredients.json': JSON.stringify({ ingredients: [{ id: 'onion', name: 'onion' }, { id: 'shallot', name: 'shallot' }] }),
    'data/substitutions.json': JSON.stringify([{ from: 'onion', to: 'shallot' }]),
    'data/techniques.yaml': techniques(),
    'data/rule-terms.json': ruleTerms(),
    'data/rewards.yaml': rewards(),
    'data/keeps.json': JSON.stringify({ onion: 30 }),
    'data/stalls.json': JSON.stringify({ onion: 'wen', shallot: 'general' }),
    'data/food-groups.json': JSON.stringify({ onion: 'veg_fruit' }),
  };
}

function problemsOf(files: Record<string, string>): string[] {
  try {
    compileContent(files);
  } catch (e) {
    expect(e).toBeInstanceOf(ContentError);
    return (e as ContentError).problems;
  }
  throw new Error('expected compileContent to throw');
}

function expectProblem(files: Record<string, string>, ...needles: string[]): void {
  const problems = problemsOf(files);
  expect(problems.some((p) => needles.every((n) => p.includes(n))), problems.join('\n')).toBe(true);
}

describe('compileContent: the real repo', () => {
  const content = compileContent(readContentFiles(repoRoot));

  it('compiles, with the three canon recipes', () => {
    expect(Object.keys(content.recipes).sort()).toEqual([
      'india/kerala/parippu',
      'japan/osaka/onigiri',
      'mexico/oaxaca/frijoles-de-olla',
    ]);
    for (const recipe of Object.values(content.recipes)) expect(recipe.steps.length).toBeGreaterThan(0);
  });

  it('reads the freshness thresholds from data/techniques.yaml', () => {
    expect(content.techniques.freshness).toEqual({ warmAfterDays: 42, rustyAfterDays: 120 });
  });

  it('has every cook, the market stalls and the Pan triggers', () => {
    expect(Object.keys(content.cooks).sort()).toEqual(['haruka', 'leela', 'marisol']);
    expect(Object.keys(content.stalls).sort()).toEqual(['bram', 'okafor-sato', 'spice', 'wen']);
    for (const id of REQUIRED_PAN_TRIGGERS) expect(content.pan.triggers[id]).toBeDefined();
  });

  it('compiles data/rule-terms.json', () => {
    expect(content.ruleTerms.map((t) => t.name)).toContain('vegetarian');
  });

  it('compiles the M5 data: three draft frames, rewards, keeps, food groups, the stall map and every stall name (C35)', () => {
    expect(content.frames.map((f) => f.id)).toEqual(['fried-rice', 'green-sauce', 'quick-tomato-sauce']);
    expect(content.rewards.trust.names).toHaveLength(6);
    expect(content.keeps.cooked_rice).toBe(1);
    expect(content.stallOf.onion ?? content.stallOf.allium).toBe('wen');
    expect(content.foodGroups.rice).toBe('grain');
    expect(content.stallNames).toEqual({ wen: 'Old Wen', bram: 'Big Bram', 'okafor-sato': 'Mr. Okafor-Sato', spice: 'The Spice Merchant', general: 'The General Counter' });
    for (const id of ['quest_done', 'certificate', 'market_run']) expect(content.bureau.stamp_names[id], id).toBeTruthy();
    expect(content.techniques.techniques.find((t) => t.id === 'tempering')).toMatchObject({ adjacent: ['quick-sauce'], prereqs: ['heat-control'] });
  });

  it('ships one recognize step per cook, before the cook step, with empty lines until M10 (C2, audit M-3)', () => {
    const recognize = Object.fromEntries(
      Object.values(content.cooks).map((c) => [c.id, c.quest.steps.slice(-2).map((s) => (s.type === 'recognize' ? `${s.technique}:${s.lines.length}/${s.otherwise.length}` : s.type))]),
    );
    expect(recognize).toEqual({ leela: ['patience:0/0', 'cook'], marisol: ['tempering:0/0', 'cook'], haruka: ['patience:0/0', 'cook'] });
  });
});

describe('compileContent: a minimal valid set', () => {
  it('compiles', () => {
    expect(compileContent(valid()).recipes['x/y/z'].steps.length).toBe(1);
  });

  it('carries the M5 data through (C35): rewards, frames, keeps, food groups, the stall map, and a name for every StallId', () => {
    const c = compileContent(valid());
    expect(c.rewards.levels).toEqual([100, 250]);
    expect(c.frames.map((f) => f.id)).toEqual(['onion-fry']);
    expect(c.keeps).toEqual({ onion: 30 });
    expect(c.foodGroups).toEqual({ onion: 'veg_fruit' });
    expect(c.stallOf).toEqual({ onion: 'wen', shallot: 'general' });
    expect(Object.keys(c.stallNames).sort()).toEqual([...STALL_IDS].sort());
    expect(c.stallNames).toMatchObject({ wen: 'Stall wen', spice: 'Stall spice', general: 'The Counter' });
    expect(c.techniques.techniques[1]).toEqual({ id: 'stir-fry', name: 'Stir-frying', adjacent: [], prereqs: ['knife'] });
  });

  it('carries the rule terms through', () => {
    expect(compileContent(valid()).ruleTerms).toEqual([ruleTerm('no onion', ['no onion', 'onion free'], ['onion'])]);
  });
});

describe('compileContent: each check fails with the path and the offending value', () => {
  const cases: [string, (f: Record<string, string>) => void, string[]][] = [
    ['unparseable YAML', (f) => (f['content/dialogue/pan.yaml'] = 'triggers: [unclosed'), ['content/dialogue/pan.yaml', 'YAML']],
    ['a schema miss', (f) => (f['content/cooks/ann.yaml'] = cook().replace('dish: "Dish"\n', '')), ['content/cooks/ann.yaml', 'dish']],
    ['a bad trigger id', (f) => (f['content/dialogue/pan.yaml'] += `  Bad-Id:\n${trigger()}`), ['pan.yaml', 'Bad-Id']],
    ['a bad ai value', (f) => (f['content/dialogue/pan.yaml'] = pan().replace('ai: never', 'ai: sometimes')), ['pan.yaml', 'ai']],
    ['an empty lines list', (f) => (f['content/dialogue/pan.yaml'] = pan().replace('      - "a line"\n', '    lines: []\n').replace('    lines:\n    lines: []', '    lines: []')), ['pan.yaml', 'lines']],
    ['a line using an undeclared variable', (f) => (f['content/dialogue/pan.yaml'] += `  extra.vars:\n    ai: allowed\n    when: test\n    vars:\n      dish: "a dish"\n    lines:\n      - "Making {dish}."\n      - "Hello, {who}."\n`), ['content/dialogue/pan.yaml', 'extra.vars line 2 uses undeclared {who}']],
    ['an ai: never trigger declaring a variable no line uses', (f) => (f['content/dialogue/pan.yaml'] += `  extra.unused:\n    ai: never\n    when: test\n    vars:\n      dish: "a dish"\n    lines:\n      - "Hello."\n`), ['content/dialogue/pan.yaml', 'extra.unused', '{dish}', 'no line uses']],
    ['a missing required trigger', (f) => (f['content/dialogue/pan.yaml'] = pan(['cook.start'])), ['pan.yaml', 'cook.start']],
    ['a recipe with an unknown cook', (f) => (f['recipes/x/y/z.cook'] = recipe({ cook: 'nobody' })), ['recipes/x/y/z.cook', 'nobody']],
    ['a recipe with an unknown skill', (f) => (f['recipes/x/y/z.cook'] = recipe({ skills: 'knife, wizardry' })), ['recipes/x/y/z.cook', 'wizardry']],
    ['a recipe that does not parse', (f) => (f['recipes/x/y/z.cook'] = '---\ntitle: [\n---\nhi'), ['recipes/x/y/z.cook']],
    ['a recipe timer without a unit', (f) => (f['recipes/x/y/z.cook'] = recipe({ timer: '~{5}' })), ['recipes/x/y/z.cook', 'timer']],
    ['a cook file named differently from its id', (f) => (f['content/cooks/ann.yaml'] = cook({ id: 'bob' })), ['content/cooks/ann.yaml', 'bob']],
    ['a cook whose recipe is missing', (f) => (f['content/cooks/ann.yaml'] = cook({ recipe: 'no/such/dish' })), ['content/cooks/ann.yaml', 'no/such/dish']],
    ['a quest.cook mismatch', (f) => (f['content/cooks/ann.yaml'] = cook({ questCook: 'zed' })), ['content/cooks/ann.yaml', 'zed']],
    ['an unknown quest in unlock.requires', (f) => (f['content/cooks/ann.yaml'] = cook({ requires: 'ghost-quest' })), ['content/cooks/ann.yaml', 'ghost-quest']],
    ['a cook step with an unknown recipe', (f) => (f['content/cooks/ann.yaml'] = cook({ steps: '    - { type: cook, recipe: a/b/c }' })), ['content/cooks/ann.yaml', 'a/b/c']],
    ['an errand to an unknown stall', (f) => (f['content/cooks/ann.yaml'] = cook({ steps: '    - { type: errand, stall: nowhere, item: onion, lines: ["go"] }' })), ['content/cooks/ann.yaml', 'nowhere']],
    ['a riddle with two correct options', (f) => (f['content/cooks/ann.yaml'] = cook({ steps: `    - { type: riddle, prompt: "P", explain: "E", options: ${options(3, 2)} }` })), ['content/cooks/ann.yaml', 'exactly one']],
    ['a riddle option without a reaction', (f) => (f['content/cooks/ann.yaml'] = cook({ steps: '    - { type: riddle, prompt: "P", explain: "E", options: [{ text: "a", correct: true }, { text: "b", correct: false, reaction: "r" }] }' })), ['content/cooks/ann.yaml', 'reaction']],
    ['a drill with an unknown skill', (f) => (f['content/cooks/ann.yaml'] = cook({ steps: '    - { type: drill, skill: sorcery, prompt: "P", lines: ["l"] }' })), ['content/cooks/ann.yaml', 'sorcery']],
    ['trust_lines outside 1 to 5', (f) => (f['content/cooks/ann.yaml'] = cook({ trust: '6' })), ['content/cooks/ann.yaml', '6']],
    ['a stall question with two options', (f) => (f['content/market/wen.yaml'] = stall(options(2))), ['content/market/wen.yaml', 'q1', '3 or 4']],
    ['a stall question with two correct options', (f) => (f['content/market/wen.yaml'] = stall(options(3, 2))), ['content/market/wen.yaml', 'q1', 'exactly one']],
    ['a stall variant question with no correct option', (f) => (f['content/market/wen.yaml'] = stall().replace(`options: ${options(3)}\n        explain`, `options: ${options(3, 0)}\n        explain`)), ['content/market/wen.yaml', 'variants.alt.questions', 'q2']],
    ['a cook line with a {var} nothing fills in', (f) => (f['content/cooks/ann.yaml'] = cook().replace('story: ["s"]', 'story: ["Welcome, {name}."]')), ['content/cooks/ann.yaml', 'story[0]', '{name}']],
    ['a stall line using an undeclared variable', (f) => (f['content/market/wen.yaml'] = stall().replace('  greet:\n', '  greet:\n    ai: allowed\n    when: t\n    vars: {}\n    lines: ["Try {item}."]\n  other:\n')), ['content/market/wen.yaml', 'triggers.greet line 1 uses undeclared {item}']],
    ['a stall ai: never trigger declaring a variable no line uses', (f) => (f['content/market/wen.yaml'] = stall().replace('  greet:\n', '  greet:\n    ai: never\n    when: t\n    vars: { item: "x" }\n    lines: ["Hello."]\n  other:\n')), ['content/market/wen.yaml', 'triggers.greet', '{item}', 'no line uses']],
    ['a missing travel form', (f) => (f['content/bureau/forms.yaml'] = bureau({ noTravel: true })), ['content/bureau/forms.yaml', 'travel']],
    ['a form stamp that is not defined', (f) => (f['content/bureau/forms.yaml'] = bureau({ stamp: 'mystery' })), ['content/bureau/forms.yaml', 'mystery']],
    ['a missing card disclaimer', (f) => (f['content/bureau/forms.yaml'] = bureau({ noCrossContact: true })), ['content/bureau/forms.yaml', 'cross_contact']],
    ['an unknown footnote tag', (f) => (f['content/bureau/forms.yaml'] = bureau({ tag: 'attic' })), ['content/bureau/forms.yaml', 'attic']],
    ['an ingredient graph with a dangling edge', (f) => (f['data/ingredients.json'] = JSON.stringify({ ingredients: [{ id: 'onion', name: 'onion', isA: ['ghost'] }] })), ['data/ingredients.json', 'ghost']],
    ['a substitution naming an unknown ingredient', (f) => (f['data/substitutions.json'] = JSON.stringify([{ from: 'onion', to: 'unobtainium' }])), ['data/substitutions.json', 'unobtainium']],
    ['a freshness threshold out of order', (f) => (f['data/techniques.yaml'] = techniques(200, 120)), ['data/techniques.yaml', 'rustyAfterDays']],
    ['a duplicate technique id', (f) => (f['data/techniques.yaml'] = techniques() + '  - { id: knife, name: "Again" }\n'), ['data/techniques.yaml', 'knife']],
    ['a missing file', (f) => delete f['data/techniques.yaml'], ['data/techniques.yaml', 'missing']],
    ['a missing AI-characters disclaimer', (f) => (f['content/bureau/forms.yaml'] = bureau({ noAiCharacters: true })), ['content/bureau/forms.yaml', 'ai_characters']],
    ['a missing rule-terms file', (f) => delete f['data/rule-terms.json'], ['data/rule-terms.json', 'missing']],
    ['rule terms that do not parse', (f) => (f['data/rule-terms.json'] = '[{'), ['data/rule-terms.json', 'JSON']],
    ['a rule term naming an id missing from the graph', (f) => (f['data/rule-terms.json'] = ruleTerms([ruleTerm('no garlic', ['no garlic'], ['onion', 'garlic'])])), ['data/rule-terms.json', 'no garlic', 'id "garlic"']],
    ['a phrase used by two rule terms', (f) => (f['data/rule-terms.json'] = ruleTerms([ruleTerm('no onion', ['no onion'], ['onion']), ruleTerm('no alliums', ['no alliums', 'No Onion'], ['onion', 'shallot'])])), ['data/rule-terms.json', 'no alliums', 'no onion']],
    ['a rule term with an unknown form', (f) => (f['data/rule-terms.json'] = ruleTerms([{ ...ruleTerm('no onion', ['no onion'], ['onion']), form: 'rule_whim' }])), ['data/rule-terms.json', 'no onion', 'rule_whim']],
    ['a stall id that differs from its file name', (f) => (f['content/market/wen.yaml'] = stall().replace('id: wen', 'id: ben')), ['content/market/wen.yaml', 'ben']],
    ['no cooks', (f) => delete f['content/cooks/ann.yaml'], ['cooks', 'no cooks']],
    ['no stalls', (f) => { for (const p of Object.keys(f)) if (p.startsWith('content/market/')) delete f[p]; }, ['market', 'no stalls']],
    // ---- M5 Step 4 ----
    ['a frame slot naming an id missing from the graph', (f) => (f['content/frames/onion-fry.yaml'] = frame({ accepts: 'unobtainium' })), ['content/frames/onion-fry.yaml', 'unknown ingredient "unobtainium"']],
    ['a frame with an unknown technique', (f) => (f['content/frames/onion-fry.yaml'] = frame({ technique: 'alchemy' })), ['content/frames/onion-fry.yaml', 'alchemy']],
    ['a frame whose id differs from its file name', (f) => (f['content/frames/onion-fry.yaml'] = frame({ id: 'leek-fry' })), ['content/frames/onion-fry.yaml', 'leek-fry']],
    ['a frame that does not parse', (f) => (f['content/frames/onion-fry.yaml'] = 'id: [x'), ['content/frames/onion-fry.yaml', 'YAML']],
    ["a recognize step of the cook's own technique", (f) => (f['content/cooks/ann.yaml'] = cook({ steps: '    - { type: recognize, technique: knife, lines: [], otherwise: [] }\n    - { type: cook, recipe: x/y/z }' })), ['content/cooks/ann.yaml', 'recognize "knife"', 'learned elsewhere']],
    ['a recognize step of an unknown technique', (f) => (f['content/cooks/ann.yaml'] = cook({ steps: '    - { type: recognize, technique: telepathy, lines: [], otherwise: [] }' })), ['content/cooks/ann.yaml', 'telepathy']],
    ['a recognize step without its otherwise lines', (f) => (f['content/cooks/ann.yaml'] = cook({ steps: '    - { type: recognize, technique: stir-fry, lines: [] }' })), ['content/cooks/ann.yaml', 'otherwise']],
    ["a cook step whose technique isn't one of its recipe's skills", (f) => (f['content/cooks/ann.yaml'] = cook({ steps: '    - { type: cook, recipe: x/y/z, technique: stir-fry }' })), ['content/cooks/ann.yaml', 'cook technique "stir-fry"']],
    ['an errand whose adapted lines are not a list', (f) => (f['content/cooks/ann.yaml'] = cook({ steps: '    - { type: errand, stall: wen, item: onion, lines: ["go"], adapted: "no" }' })), ['content/cooks/ann.yaml', 'adapted']],
    ['a travel step to an unknown place', (f) => (f['content/cooks/ann.yaml'] = cook({ steps: '    - { type: travel, place: atlantis, lines: [] }' })), ['content/cooks/ann.yaml', 'atlantis']],
    ['keeps with an unknown id', (f) => (f['data/keeps.json'] = JSON.stringify({ onion: 30, kale: 4 })), ['data/keeps.json', '"kale" is not an ingredient id']],
    ['keeps with a bad day count', (f) => (f['data/keeps.json'] = JSON.stringify({ onion: 0 })), ['data/keeps.json', '"onion"', 'whole number of days']],
    ['a stalls.json value that is not a stall', (f) => (f['data/stalls.json'] = JSON.stringify({ onion: 'dairy' })), ['data/stalls.json', '"onion" names "dairy"']],
    ['a stalls.json key that is not in the graph', (f) => (f['data/stalls.json'] = JSON.stringify({ kale: 'wen' })), ['data/stalls.json', 'kale']],
    ['a food group that is not one', (f) => (f['data/food-groups.json'] = JSON.stringify({ onion: 'snacks' })), ['data/food-groups.json', 'snacks']],
    ['food groups that are not a mapping', (f) => (f['data/food-groups.json'] = '["onion"]'), ['data/food-groups.json']],
    ['a StampId with no stamp_names entry', (f) => (f['content/bureau/forms.yaml'] = bureau({ omitStampName: 'market_run' })), ['content/bureau/forms.yaml', 'stamp_names.market_run']],
    ['an unknown id in a technique\'s adjacent', (f) => (f['data/techniques.yaml'] = techniques(42, 120, 'juggling')), ['data/techniques.yaml', 'knife', 'unknown technique "juggling"']],
    ['rewards with non-increasing levels', (f) => (f['data/rewards.yaml'] = rewards('[100, 100]')), ['data/rewards.yaml', 'levels must be strictly increasing']],
    ['a missing rewards file', (f) => delete f['data/rewards.yaml'], ['data/rewards.yaml', 'missing']],
    ['a missing M5 form', (f) => (f['content/bureau/forms.yaml'] = bureau({ omitForm: 'margin_note' })), ['content/bureau/forms.yaml', 'forms.margin_note']],
    ['a market list form without the general stall name', (f) => (f['content/bureau/forms.yaml'] = bureau({ noGeneralStall: true })), ['content/bureau/forms.yaml', 'general_stall']],
    ['a missing market stall file', (f) => delete f['content/market/spice.yaml'], ['content/market/spice.yaml', 'missing']],
    ['a market stall the game does not know', (f) => (f['content/market/dairy.yaml'] = stall(options(3), 'dairy')), ['content/market/dairy.yaml', 'dairy']],
    ['no recipes', (f) => delete f['recipes/x/y/z.cook'], ['recipes', 'no recipes']],
    ['a .yml file in place of .yaml', (f) => (f['content/cooks/bob.yml'] = cook({ id: 'bob' })), ['content/cooks/bob.yml', 'not loaded']],
    ['a recipe with the wrong extension', (f) => (f['recipes/x/y/w.cooklang'] = recipe()), ['recipes/x/y/w.cooklang', 'not loaded']],
    ['an unexpected content subfolder', (f) => (f['content/extra/notes.yaml'] = 'a: 1'), ['content/extra/notes.yaml', 'not loaded']],
  ];
  it.each(cases)('%s', (_name, mutate, needles) => {
    const files = valid();
    mutate(files);
    expectProblem(files, ...needles);
  });
});

describe('compileContent: Pan variables', () => {
  it('lets an ai: allowed trigger declare a variable its lines skip', () => {
    const files = valid();
    files['content/dialogue/pan.yaml'] += `  extra.spare:\n    ai: allowed\n    when: test\n    vars:\n      dish: "a dish"\n    lines:\n      - "Hello."\n`;
    expect(() => compileContent(files)).not.toThrow();
  });
});

describe('compileContent: unclaimed-file allowlist', () => {
  it('accepts README.md and LICENSE', () => {
    const files = valid();
    files['content/README.md'] = '# hi';
    files['content/LICENSE'] = 'CC';
    files['recipes/README.md'] = '# hi';
    expect(() => compileContent(files)).not.toThrow();
  });
});

describe('compileContent: real repo fidelity', () => {
  const files = readContentFiles(repoRoot);
  const content = compileContent(files);
  const src = (path: string): unknown => parseYaml(files[path]);

  /** Every `ai` value in a tree, by path. */
  function aiValues(node: unknown, path: string, out: Map<string, unknown>): Map<string, unknown> {
    if (Array.isArray(node)) node.forEach((n, i) => aiValues(n, `${path}[${i}]`, out));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'ai') out.set(`${path}.ai`, v);
        else aiValues(v, `${path}.${k}`, out);
      }
    }
    return out;
  }
  const compiledTrees: [string, unknown][] = [
    ['content/dialogue/pan.yaml', content.pan],
    ...Object.keys(content.stalls).map((id): [string, unknown] => [`content/market/${id}.yaml`, content.stalls[id]]),
    ...Object.keys(content.cooks).map((id): [string, unknown] => [`content/cooks/${id}.yaml`, content.cooks[id]]),
  ];

  it.each(compiledTrees)('keeps every ai value from %s', (path, compiled) => {
    const before = aiValues(src(path), '', new Map());
    const after = aiValues(compiled, '', new Map());
    expect(after).toEqual(before);
  });

  it('has ai values to compare in the Pan and every stall', () => {
    expect(aiValues(content.pan, '', new Map()).size).toBeGreaterThan(50);
    for (const id of Object.keys(content.stalls)) expect(aiValues(content.stalls[id], '', new Map()).size).toBeGreaterThan(0);
  });

  it('pins safety triggers to ai: never', () => {
    const pinned = ['rule.readback', 'rule.readback.no_spelling', 'rule.void_confirm', 'rule.emergency', 'rule.medical_deflect', 'log.confirm_readback'];
    const ids = [...pinned, ...Object.keys(content.pan.triggers).filter((t) => t.startsWith('intake.allergies.'))];
    expect(ids.filter((t) => t.startsWith('intake.allergies.')).length).toBeGreaterThan(0);
    for (const id of ids) {
      if (id === 'rule.readback.no_spelling' && !content.pan.triggers[id]) continue;
      expect(content.pan.triggers[id], id).toBeDefined();
      expect(content.pan.triggers[id].ai, id).toBe('never');
    }
  });

  it('drops writer-only keys from the client bundle', () => {
    expect(Object.values(content.pan.triggers).some((t) => 'when' in t || 'notes' in t)).toBe(false);
    for (const stall of Object.values(content.stalls))
      expect(Object.values(stall.triggers).some((t) => 'when' in t || 'notes' in t)).toBe(false);
    expect(Object.values(content.bureau.forms).some((f) => 'purpose' in f)).toBe(false);
  });

  it('stays within the 400 KB bundle budget', () => {
    const bytes = Buffer.byteLength(`export default ${JSON.stringify(content)};`);
    console.info(`compiled content module: ${(bytes / 1024).toFixed(1)} KB`);
    expect(bytes).toBeLessThan(400 * 1024);
  });
});

describe('compileContent: reporting and versioning', () => {
  it('reports problems from several files in one ContentError', () => {
    const files = valid();
    files['content/dialogue/pan.yaml'] = pan(['cook.start']);
    files['recipes/x/y/z.cook'] = recipe({ cook: 'nobody' });
    files['data/techniques.yaml'] = techniques(200, 120);
    const problems = problemsOf(files);
    expect(problems.some((p) => p.includes('pan.yaml') && p.includes('cook.start'))).toBe(true);
    expect(problems.some((p) => p.includes('z.cook') && p.includes('nobody'))).toBe(true);
    expect(problems.some((p) => p.includes('techniques.yaml'))).toBe(true);
  });

  it('prefixes every problem with a file path', () => {
    const files = valid();
    files['content/cooks/ann.yaml'] = cook({ questCook: 'zed', requires: 'ghost' });
    for (const p of problemsOf(files)) expect(p).toMatch(/^[a-z]+\/[^:]+: /);
  });

  it('has a version that is stable for the same input and changes with any byte', () => {
    const a = compileContent(valid()).version;
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(compileContent(valid()).version).toBe(a);
    const files = valid();
    files['content/dialogue/pan.yaml'] += '\n# a comment\n';
    expect(compileContent(files).version).not.toBe(a);
  });
});
