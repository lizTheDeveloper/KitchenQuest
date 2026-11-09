import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

const stall = (questionOptions = options(3)) => `
id: wen
name: "Wen"
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

const bureau = (over: { stamp?: string; noTravel?: boolean; tag?: string } = {}) => {
  const form = (stamp: string) =>
    `    number: "1"\n    title: "T"\n    fields: []\n    buttons: { confirm: "ok" }\n    stamp: ${stamp}\n`;
  return `forms:
${over.noTravel ? '' : `  travel:\n${form(over.stamp ?? 'approved')}`}  certificate:\n${form('approved')}stamps:
  approved: "APPROVED"
stamp_names:
  travel: "Travel"
footnotes:
  - { tag: ${over.tag ?? 'any'}, text: "*x" }
disclaimers:
  allergy: "plain"
`;
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

const techniques = (warm = 42, rusty = 120) =>
  `freshness: { warm_after_days: ${warm}, rusty_after_days: ${rusty} }\ntechniques:\n  - { id: knife, name: "Knife" }\n`;

function valid(): Record<string, string> {
  return {
    'content/dialogue/pan.yaml': pan(),
    'content/cooks/ann.yaml': cook(),
    'content/market/wen.yaml': stall(),
    'content/bureau/forms.yaml': bureau(),
    'recipes/x/y/z.cook': recipe(),
    'data/ingredients.json': JSON.stringify({ ingredients: [{ id: 'onion', name: 'onion' }, { id: 'shallot', name: 'shallot' }] }),
    'data/substitutions.json': JSON.stringify([{ from: 'onion', to: 'shallot' }]),
    'data/techniques.yaml': techniques(),
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
});

describe('compileContent: a minimal valid set', () => {
  it('compiles', () => {
    expect(compileContent(valid()).recipes['x/y/z'].steps.length).toBe(1);
  });
});

describe('compileContent: each check fails with the path and the offending value', () => {
  const cases: [string, (f: Record<string, string>) => void, string[]][] = [
    ['unparseable YAML', (f) => (f['content/dialogue/pan.yaml'] = 'triggers: [unclosed'), ['content/dialogue/pan.yaml', 'YAML']],
    ['a schema miss', (f) => (f['content/cooks/ann.yaml'] = cook().replace('dish: "Dish"\n', '')), ['content/cooks/ann.yaml', 'dish']],
    ['a bad trigger id', (f) => (f['content/dialogue/pan.yaml'] += `  Bad-Id:\n${trigger()}`), ['pan.yaml', 'Bad-Id']],
    ['a bad ai value', (f) => (f['content/dialogue/pan.yaml'] = pan().replace('ai: never', 'ai: sometimes')), ['pan.yaml', 'ai']],
    ['an empty lines list', (f) => (f['content/dialogue/pan.yaml'] = pan().replace('      - "a line"\n', '    lines: []\n').replace('    lines:\n    lines: []', '    lines: []')), ['pan.yaml', 'lines']],
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
    ['a missing travel form', (f) => (f['content/bureau/forms.yaml'] = bureau({ noTravel: true })), ['content/bureau/forms.yaml', 'travel']],
    ['a form stamp that is not defined', (f) => (f['content/bureau/forms.yaml'] = bureau({ stamp: 'mystery' })), ['content/bureau/forms.yaml', 'mystery']],
    ['an unknown footnote tag', (f) => (f['content/bureau/forms.yaml'] = bureau({ tag: 'attic' })), ['content/bureau/forms.yaml', 'attic']],
    ['an ingredient graph with a dangling edge', (f) => (f['data/ingredients.json'] = JSON.stringify({ ingredients: [{ id: 'onion', name: 'onion', isA: ['ghost'] }] })), ['data/ingredients.json', 'ghost']],
    ['a substitution naming an unknown ingredient', (f) => (f['data/substitutions.json'] = JSON.stringify([{ from: 'onion', to: 'unobtainium' }])), ['data/substitutions.json', 'unobtainium']],
    ['a freshness threshold out of order', (f) => (f['data/techniques.yaml'] = techniques(200, 120)), ['data/techniques.yaml', 'rustyAfterDays']],
    ['a duplicate technique id', (f) => (f['data/techniques.yaml'] = techniques() + '  - { id: knife, name: "Again" }\n'), ['data/techniques.yaml', 'knife']],
    ['a missing file', (f) => delete f['data/techniques.yaml'], ['data/techniques.yaml', 'missing']],
  ];
  it.each(cases)('%s', (_name, mutate, needles) => {
    const files = valid();
    mutate(files);
    expectProblem(files, ...needles);
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
