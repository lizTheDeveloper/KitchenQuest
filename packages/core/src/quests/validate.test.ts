import { describe, expect, it } from 'vitest';
import { catalogueOf, COOKS, graph, quests, STALLS } from './fixtures';
import type { Quest, QuestStep } from './types';
import { validateQuests } from './validate';

const all = Object.values(quests);
const cat = catalogueOf(all);
const run = (qs: Quest[]) => validateQuests(qs, cat, COOKS, STALLS, graph);
const leela = quests['leela-tempering'];
const marisol = quests['marisol-salt-question'];
const haruka = quests['haruka-gluey-rice'];
const withStep = (q: Quest, step: QuestStep): Quest => ({ ...q, steps: [...q.steps.slice(0, -1), step, q.steps[q.steps.length - 1]] });

describe('validateQuests', () => {
  it('the shipped quests are valid', () => {
    expect(run(all)).toEqual([]);
  });

  it('Step 4\'s planned recognize steps pass (C2: Leela patience, Marisol tempering, Haruka patience)', () => {
    const rec = (technique: string): QuestStep => ({ type: 'recognize', technique, lines: [], otherwise: [] });
    expect(run([withStep(leela, rec('patience')), withStep(marisol, rec('tempering')), withStep(haruka, rec('patience'))])).toEqual([]);
  });

  it("validateQuests: two correct options, unknown recipe, requires cycle, recognize of own cook's technique → problems", () => {
    const twoCorrect: Quest = {
      ...leela,
      steps: leela.steps.map((s) => (s.type === 'riddle' ? { ...s, options: s.options.map((o, i) => ({ ...o, correct: i < 2 })) } : s)),
    };
    expect(run([twoCorrect, marisol, haruka])).toEqual(['quest "leela-tempering" step 4: a riddle needs exactly one correct option (has 2)']);
    const noCorrect: Quest = { ...leela, steps: leela.steps.map((s) => (s.type === 'riddle' ? { ...s, options: s.options.map((o) => ({ ...o, correct: false })) } : s)) };
    expect(run([noCorrect, marisol, haruka])).toEqual(['quest "leela-tempering" step 4: a riddle needs exactly one correct option (has 0)']);

    const unknownRecipe: Quest = { ...leela, steps: leela.steps.map((s) => (s.type === 'cook' ? { type: 'cook', recipe: 'india/kerala/sambar' } : s)) };
    expect(run([unknownRecipe, marisol, haruka])).toEqual(['quest "leela-tempering" step 5: cook names unknown recipe "india/kerala/sambar"']);

    const cycle: Quest = { ...leela, unlock: { requires: ['haruka-gluey-rice'], trust: 0 } };
    expect(run([cycle, marisol, haruka])).toEqual(['unlock.requires cycle: leela-tempering → haruka-gluey-rice → marisol-salt-question → leela-tempering']);

    // heat-control is a skill of Leela's own parippu (C2), so it isn't recognition of something learned elsewhere.
    const own = withStep(leela, { type: 'recognize', technique: 'heat-control', lines: [], otherwise: [] });
    expect(run([own, marisol, haruka])).toEqual([
      "quest \"leela-tempering\" step 5: recognize \"heat-control\" is taught by leela's own recipe; recognition must be of something learned elsewhere",
    ]);
  });

  it('unknown technique, stall, ingredient, cook, travel place, quest and step type → problems', () => {
    const bad: Quest = {
      ...leela,
      cook: 'nobody',
      steps: [
        { type: 'drill', skill: 'juggling', prompt: '', lines: [] },
        { type: 'errand', stall: 'moon', item: 'unobtainium', lines: [] },
        { type: 'travel', place: 'atlantis', lines: [] },
        { type: 'recognize', technique: 'telepathy', lines: [], otherwise: [] },
        { type: 'dance' } as unknown as QuestStep,
      ],
      unlock: { requires: ['leela-tempering', 'ghost-quest'], trust: 0 },
      rewards: { ...leela.rewards, skills: { origami: 1 } },
    };
    expect(run([bad])).toEqual([
      'quest "leela-tempering": unknown cook "nobody"',
      'quest "leela-tempering": unlock.requires names itself',
      'quest "leela-tempering": unlock.requires names unknown quest "ghost-quest"',
      'quest "leela-tempering": rewards.skills names unknown technique "origami"',
      'quest "leela-tempering" step 1: drill names unknown technique "juggling"',
      'quest "leela-tempering" step 2: errand to unknown stall "moon"',
      'quest "leela-tempering" step 2: errand item "unobtainium" is not in the ingredient graph',
      'quest "leela-tempering" step 3: travel to unknown place "atlantis"',
      'quest "leela-tempering" step 4: recognize names unknown technique "telepathy"',
      'quest "leela-tempering" step 5: unknown step type "dance"',
    ]);
  });

  it('M2: riddle options need string text and reaction and a boolean correct; prompt and explain are strings; lines are string lists', () => {
    const riddle = (over: Record<string, unknown>): Quest => ({
      ...leela,
      steps: leela.steps.map((s) => (s.type === 'riddle' ? ({ ...s, ...over } as unknown as QuestStep) : s)),
    });
    const r = leela.steps[3];
    if (r.type !== 'riddle') throw new Error('fixture');
    expect(run([riddle({ options: [{ ...r.options[0], reaction: undefined }, ...r.options.slice(1)] }), marisol, haruka])).toEqual([
      'quest "leela-tempering" step 4: riddle option 1 needs text, reaction and correct',
    ]);
    expect(run([riddle({ options: [r.options[0], { text: 3, correct: false, reaction: 'x' }] }), marisol, haruka])).toEqual([
      'quest "leela-tempering" step 4: riddle option 2 needs text, reaction and correct',
    ]);
    expect(run([riddle({ explain: undefined }), marisol, haruka])).toEqual(['quest "leela-tempering" step 4: a riddle needs a prompt and an explain']);
    expect(run([riddle({ options: 'nope' }), marisol, haruka])).toContain('quest "leela-tempering" step 4: a riddle needs exactly one correct option (has 0)');
    const talk: Quest = { ...leela, steps: leela.steps.map((s) => (s.type === 'talk' ? ({ type: 'talk', lines: 'hi' } as unknown as QuestStep) : s)) };
    expect(run([talk, marisol, haruka])).toEqual(['quest "leela-tempering" step 1: lines must be a list of lines']);
  });

  it('unlock.trust must be a whole number in 0–5', () => {
    for (const trust of [-1, 6, 1.5, Number.NaN]) {
      expect(run([{ ...leela, unlock: { requires: [], trust } }, marisol, haruka])).toEqual([
        'quest "leela-tempering": unlock.trust must be a whole number from 0 to 5',
      ]);
    }
    for (const trust of [0, 5]) expect(run([{ ...leela, unlock: { requires: [], trust } }, marisol, haruka])).toEqual([]);
  });

  it('duplicate ids, no steps, and junk input are problems, never a throw', () => {
    expect(run([leela, leela, marisol, haruka])).toContain('quest "leela-tempering": duplicate id');
    expect(run([{ ...leela, steps: [] }, marisol, haruka])).toEqual(['quest "leela-tempering": needs at least one step']);
    expect(() => run([null, 3, {}, { id: 'x', steps: [null] }] as unknown as Quest[])).not.toThrow();
    expect(run([null] as unknown as Quest[])).toEqual(['quest 0: needs an id']);
  });
});
