import { describe, expect, it } from 'vitest';
import type { ProgressEvent, ProgressHistory } from '../progress/types';
import type { Rule } from '../rules/types';
import { advance, currentStep, ERRAND_ADAPTED_TRIGGER, errandAllowed, questStatus, recognizedFrom, type ErrandAdapted, type StepContext, type StepInput } from './engine';
import { catalogueOf, EMPTY_HISTORY, graph, newId, quests, record, subs, view } from './fixtures';
import type { Quest } from './types';

const DAY = '2026-11-10';
const leela = quests['leela-tempering'];
const marisol = quests['marisol-salt-question'];

/** Marisol's quest with a recognize step before its cook step, as Step 4 will ship it (C2: tempering). */
const withRecognize = (q: Quest, technique: string): Quest => {
  const cookAt = q.steps.findIndex((s) => s.type === 'cook');
  const steps = [...q.steps];
  steps.splice(cookAt, 0, { type: 'recognize', technique, lines: ['I know that hand.'], otherwise: ['Watch closely.'] });
  return { ...q, steps };
};
const marisolR = withRecognize(marisol, 'tempering');
const cat = catalogueOf([leela, marisolR, quests['haruka-gluey-rice']]);

const ALLIUM: Rule = { id: 'r-allium', target: { kind: 'category', ids: ['allium'] }, type: 'avoid', severity: 'allergy' };
const ctx = (rules: Rule[] = []): StepContext => ({ rules, graph, subs, today: DAY, cat });

/** The input that passes each step of a quest, the right riddle answer included. */
function rightInput(q: Quest, index: number, h: ProgressHistory): StepInput {
  const s = q.steps[index];
  switch (s.type) {
    case 'talk':
    case 'travel':
    case 'drill':
    case 'recognize':
      return { type: s.type };
    case 'riddle':
      return { type: 'riddle', option: s.options.findIndex((o) => o.correct) };
    case 'errand':
      return { type: 'errand', have: 'tapped' };
    case 'cook': {
      const cooked = h.events.find((e) => e.kind === 'cooked' && e.recipe === s.recipe);
      return { type: 'cook', cookedEventId: cooked?.id ?? '' };
    }
  }
}

/**
 * Play a quest from `h` to the end under `rules`; before the cook step, the player cooks the dish (under a rule that
 * blocks it, read as the cook's adapted version). Every event goes through grantsFor.
 */
function playQuest(q: Quest, h: ProgressHistory, at = DAY, rules: Rule[] = []): { h: ProgressHistory; emitted: ProgressEvent[]; adapted: ErrandAdapted[] } {
  let out = h;
  const emitted: ProgressEvent[] = [];
  const adapted: ErrandAdapted[] = [];
  for (let i = 0; i < q.steps.length; i++) {
    const s = q.steps[i];
    if (s.type === 'cook') out = record(out, [{ id: newId(), kind: 'cooked', at, recipe: s.recipe, planned: false }], cat);
    const r = advance(q, view(out, cat), rightInput(q, i, out), at, newId, ctx(rules));
    if (!r.ok) throw new Error(`step ${i + 1} refused: ${r.reason}`);
    emitted.push(...r.events);
    if (r.adapted) adapted.push(r.adapted);
    out = record(out, r.events, cat);
  }
  return { h: out, emitted, adapted };
}

/** Play the first `count` steps of a quest. */
function playSteps(q: Quest, h: ProgressHistory, count: number): ProgressHistory {
  let out = h;
  for (let i = 0; i < count; i++) {
    const r = advance(q, view(out, cat), rightInput(q, i, out), DAY, newId, ctx());
    if (!r.ok) throw new Error(`step ${i + 1} refused: ${r.reason}`);
    out = record(out, r.events, cat);
  }
  return out;
}

describe('quest engine', () => {
  it('leela-tempering runs talk → errand → drill → riddle → cook → done (the order in leela.yaml), emitting quest_step events in order', () => {
    expect(leela.steps.map((s) => s.type)).toEqual(['talk', 'errand', 'drill', 'riddle', 'cook']);
    const p0 = view(EMPTY_HISTORY, cat);
    expect(questStatus(leela, p0)).toBe('open');
    expect(currentStep(leela, p0)).toEqual({ index: 0, step: leela.steps[0] });

    const { h, emitted } = playQuest(leela, EMPTY_HISTORY);
    expect(emitted.map((e) => (e.kind === 'quest_step' ? `step${e.step}` : e.kind))).toEqual(['step1', 'step2', 'step3', 'drill', 'step4', 'step5', 'quest_done']);
    expect(emitted.find((e) => e.kind === 'drill')).toMatchObject({ quest: 'leela-tempering', step: 3, technique: 'knife' });
    const p = view(h, cat);
    expect(questStatus(leela, p)).toBe('done');
    expect(currentStep(leela, p)).toBeNull();
    expect(p.questsDone).toEqual(['leela-tempering']);
  });

  it('is in_progress after its first step, and says the errand return line and the riddle reaction + explanation', () => {
    const h1 = playSteps(leela, EMPTY_HISTORY, 1);
    expect(questStatus(leela, view(h1, cat))).toBe('in_progress');
    const errand = leela.steps[1];
    if (errand.type !== 'errand') throw new Error('fixture');
    const r = advance(leela, view(h1, cat), { type: 'errand', have: 'pantry' }, DAY, newId, ctx());
    expect(r).toMatchObject({ ok: true, say: [errand.lines[errand.lines.length - 1]] });
    const h3 = playSteps(leela, EMPTY_HISTORY, 3);
    const riddle = leela.steps[3];
    if (riddle.type !== 'riddle') throw new Error('fixture');
    const ok = advance(leela, view(h3, cat), { type: 'riddle', option: 0 }, DAY, newId, ctx());
    expect(ok).toMatchObject({ ok: true, say: [riddle.options[0].reaction, riddle.explain] });
  });

  it('a wrong riddle option keeps the step and returns its reaction; never a penalty event', () => {
    const h = playSteps(leela, EMPTY_HISTORY, 3);
    const p = view(h, cat);
    const riddle = leela.steps[3];
    if (riddle.type !== 'riddle') throw new Error('fixture');
    for (const option of [1, 2, 3]) {
      const r = advance(leela, p, { type: 'riddle', option }, DAY, newId, ctx());
      expect(r).toEqual({ ok: false, reason: 'wrong_answer', say: [riddle.options[option].reaction] });
    }
    for (const option of [-1, 4, 1.5, Number.NaN]) expect(advance(leela, p, { type: 'riddle', option }, DAY, newId, ctx())).toMatchObject({ ok: false, reason: 'wrong_answer' });
    expect(currentStep(leela, p)?.index).toBe(3);
    expect(view(h, cat).xp).toBe(p.xp);
  });

  it('advance on a step that is not current → not_current, no events', () => {
    const p = view(EMPTY_HISTORY, cat); // on the talk step
    for (const input of [{ type: 'drill' }, { type: 'riddle', option: 0 }, { type: 'errand', have: 'tapped' }, { type: 'recognize' }, { type: 'travel' }, { type: 'cook', cookedEventId: 'x' }] as StepInput[]) {
      expect(advance(leela, p, input, DAY, newId, ctx())).toEqual({ ok: false, reason: 'not_current', say: [] });
    }
  });

  it('errand satisfied by pantry, by a ticked list item, or by a tap; an item blocked by ctx.rules → adapted + adapted line', () => {
    const h = playSteps(leela, EMPTY_HISTORY, 1);
    const p = view(h, cat);
    for (const have of ['pantry', 'ticked', 'tapped'] as const) {
      const r = advance(leela, p, { type: 'errand', have }, DAY, newId, ctx());
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.events).toEqual([expect.objectContaining({ kind: 'quest_step', quest: 'leela-tempering', step: 2 })]);
        expect(r.adapted).toBeUndefined();
      }
    }
    // Shallots are alliums: an allium rule sends the errand down the adapted path, whatever the player has.
    const line = 'No shallots for you, then. We will make it sing another way.';
    const withLine: Quest = { ...leela, steps: leela.steps.map((s) => (s.type === 'errand' ? { ...s, adapted: [line] } : s)) };
    for (const have of ['pantry', 'ticked', 'tapped'] as const) {
      const r = advance(withLine, p, { type: 'errand', have }, DAY, newId, ctx([ALLIUM]));
      expect(r).toMatchObject({ ok: true, say: [line], adapted: { item: 'shallot', trigger: null, swap: null } });
      if (r.ok) expect(r.events).toEqual([expect.objectContaining({ kind: 'quest_step', quest: 'leela-tempering', step: 2 })]);
    }
    // No adapted lines in the file (as shipped): the Pan's scripted fallback trigger speaks instead.
    expect(advance(leela, p, { type: 'errand', have: 'tapped' }, DAY, newId, ctx([ALLIUM]))).toMatchObject({
      ok: true,
      say: [],
      adapted: { item: 'shallot', trigger: ERRAND_ADAPTED_TRIGGER, swap: null },
    });
    expect(ERRAND_ADAPTED_TRIGGER).toBe('quest.errand_adapted');
  });

  it("an errand item the rules engine can't verify goes the adapted way, never the normal one (spec §2.2)", () => {
    const h = playSteps(leela, EMPTY_HISTORY, 1);
    const p = view(h, cat);
    const item = (id: string): Quest => ({ ...leela, steps: leela.steps.map((s) => (s.type === 'errand' ? { ...s, item: id } : s)) });
    const COCONUT: Rule = { id: 'r-coconut', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'allergy' };
    expect(advance(item('not-an-ingredient'), p, { type: 'errand', have: 'tapped' }, DAY, newId, ctx())).toMatchObject({ ok: true, adapted: { swap: null } });
    // ❓ a label-dependent item under any rule.
    expect(graph.get('pappadam').labelDependent).toBe(true);
    expect(advance(item('pappadam'), p, { type: 'errand', have: 'tapped' }, DAY, newId, ctx([COCONUT]))).toMatchObject({ ok: true, adapted: { item: 'pappadam', swap: null } });
    expect(advance(item('pappadam'), p, { type: 'errand', have: 'tapped' }, DAY, newId, ctx())).not.toHaveProperty('adapted');
    // A rule that only starts after today does not adapt it.
    const later: Rule = { ...ALLIUM, phase: { start: '2027-01-01' } };
    expect(advance(leela, p, { type: 'errand', have: 'tapped' }, DAY, newId, ctx([later]))).not.toHaveProperty('adapted');
  });

  it("a swap is offered only when it passes the player's rules", () => {
    const h = playSteps(leela, EMPTY_HISTORY, 1);
    const p = view(h, cat);
    const item = (id: string): Quest => ({ ...leela, steps: leela.steps.map((s) => (s.type === 'errand' ? { ...s, item: id } : s)) });
    const avoid = (id: string): Rule => ({ id: `r-${id}`, target: { kind: 'ingredient', ids: [id] }, type: 'avoid', severity: 'preference' });
    // Ghee → neutral oil (data/substitutions.json), and neutral oil is ✅ for a ghee rule.
    const r = advance(item('ghee'), p, { type: 'errand', have: 'tapped' }, DAY, newId, ctx([avoid('ghee')]));
    expect(r).toMatchObject({ ok: true, adapted: { item: 'ghee', swap: { id: 'neutral_oil', name: graph.get('neutral_oil').name, note: 'Same amount of sunflower or canola oil.' } } });
    // A rule against the swap too: no swap, still adapted (never a lockout).
    expect(advance(item('ghee'), p, { type: 'errand', have: 'tapped' }, DAY, newId, ctx([avoid('ghee'), avoid('neutral_oil')]))).toMatchObject({ ok: true, adapted: { swap: null } });
    // Garlic → garlic-infused oil is unsafe for an allium rule, so it is never offered there.
    expect(advance(item('garlic'), p, { type: 'errand', have: 'tapped' }, DAY, newId, ctx([ALLIUM]))).toMatchObject({ ok: true, adapted: { item: 'garlic', swap: null } });
    // Every offered swap is itself ✅ for the rules, by the rules engine.
    if (r.ok && r.adapted?.swap) expect(errandAllowed(r.adapted.swap.id, ctx([avoid('ghee')]))).toBe(true);
  });

  it("an allium rule completes Leela's errand as adapted, Marisol's quest becomes available, and XP is identical to the normal path", () => {
    const normal = playQuest(leela, EMPTY_HISTORY, DAY, []);
    const allium = playQuest(leela, EMPTY_HISTORY, DAY, [ALLIUM]);
    expect(allium.adapted).toEqual([expect.objectContaining({ item: 'shallot', trigger: ERRAND_ADAPTED_TRIGGER })]);
    expect(normal.adapted).toEqual([]);
    const pN = view(normal.h, cat);
    const pA = view(allium.h, cat);
    expect(questStatus(leela, pA)).toBe('done');
    expect(questStatus(marisol, pA)).toBe('open');
    expect(advance(marisol, pA, { type: 'talk' }, DAY, newId, ctx([ALLIUM])).ok).toBe(true);
    // Same events by kind and step, and the same rewards.
    const shape = (es: ProgressEvent[]) => es.map((e) => [e.kind, 'step' in e ? e.step : null]);
    expect(shape(allium.emitted)).toEqual(shape(normal.emitted));
    expect(pA.xp).toBe(pN.xp);
    expect(pA.stamps).toBe(pN.stamps);
    expect(pA.trust).toEqual(pN.trust);
    expect(pA.level).toBe(pN.level);
  });

  it('cook step needs a cooked event for that recipe on/after the quest started', () => {
    const START = '2026-11-12';
    // Cooked parippu before the quest started: it does not count.
    let h = record(EMPTY_HISTORY, [{ id: newId(), kind: 'cooked', at: DAY, recipe: 'india/kerala/parippu', planned: false }], cat);
    for (let i = 0; i < 4; i++) {
      const r = advance(leela, view(h, cat), rightInput(leela, i, h), START, newId, ctx());
      if (!r.ok) throw new Error(r.reason);
      h = record(h, r.events, cat);
    }
    const early = h.events.find((e) => e.kind === 'cooked')!.id;
    expect(advance(leela, view(h, cat), { type: 'cook', cookedEventId: early }, START, newId, ctx())).toEqual({ ok: false, reason: 'not_current', say: [] });
    // Another recipe does not count either.
    h = record(h, [{ id: newId(), kind: 'cooked', at: START, recipe: 'japan/osaka/onigiri', planned: false }], cat);
    expect(advance(leela, view(h, cat), { type: 'cook', cookedEventId: 'x' }, START, newId, ctx()).ok).toBe(false);
    // Cooking parippu on/after the start does.
    const cooked: ProgressEvent = { id: newId(), kind: 'cooked', at: '2026-11-13', recipe: 'india/kerala/parippu', planned: false };
    h = record(h, [cooked], cat);
    const r = advance(leela, view(h, cat), { type: 'cook', cookedEventId: cooked.id }, '2026-11-13', newId, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.events.map((e) => e.kind)).toEqual(['quest_step', 'quest_done']);
  });

  it('recognize: Tried tempering from Leela, at Marisol → lines + recognized event; never met → otherwise lines, no event', () => {
    const afterLeela = playQuest(leela, EMPTY_HISTORY).h;
    expect(view(afterLeela, cat).toolkit.techniques.tempering.tier).toBe('tried');
    const recognizeAt = marisolR.steps.findIndex((s) => s.type === 'recognize');
    const h = playSteps(marisolR, afterLeela, recognizeAt);
    const p = view(h, cat);
    expect(recognizedFrom('tempering', marisolR, p, cat)).toBe('leela');
    const r = advance(marisolR, p, { type: 'recognize' }, DAY, newId, ctx());
    expect(r).toMatchObject({ ok: true, say: ['I know that hand.'] });
    if (!r.ok) return;
    expect(r.events.map((e) => e.kind)).toEqual(['quest_step', 'recognized']);
    expect(r.events[1]).toMatchObject({ quest: 'marisol-salt-question', technique: 'tempering' });
    const after = view(record(h, r.events, cat), cat);
    expect(after.toolkit.techniques.tempering.tier).toBe('yours'); // grantsFor accepted it: Tried → Yours

    // Never met: Haruka's grains at Marisol's.
    const grains = withRecognize(marisol, 'grains');
    const catG = catalogueOf([leela, grains]);
    const hG = playSteps(grains, afterLeela, recognizeAt);
    expect(recognizedFrom('grains', grains, view(hG, catG), catG)).toBeNull();
    const rG = advance(grains, view(hG, catG), { type: 'recognize' }, DAY, newId, { ...ctx(), cat: catG });
    expect(rG).toMatchObject({ ok: true, say: ['Watch closely.'] });
    if (rG.ok) expect(rG.events.map((e) => e.kind)).toEqual(['quest_step']);
  });

  it("recognize never credits the quest's own cook: tempering from Leela's own dish at Leela → otherwise", () => {
    const own = withRecognize(leela, 'tempering');
    const h = record(EMPTY_HISTORY, [{ id: newId(), kind: 'cooked', at: DAY, recipe: 'india/kerala/parippu', planned: false }], cat);
    expect(recognizedFrom('tempering', own, view(h, cat), cat)).toBeNull();
  });

  it('questStatus waiting while a quest in unlock.requires is not done: advance → waiting, no events (C4, Ruling 3)', () => {
    const p = view(EMPTY_HISTORY, cat);
    expect(marisol.unlock.requires).toEqual(['leela-tempering']);
    expect(questStatus(marisol, p)).toBe('waiting');
    expect(advance(marisol, p, { type: 'talk' }, DAY, newId, ctx())).toEqual({ ok: false, reason: 'waiting', say: [] });
    // Part-way through Leela's quest is still waiting.
    const part = view(playSteps(leela, EMPTY_HISTORY, 4), cat);
    expect(questStatus(marisol, part)).toBe('waiting');
    expect(advance(marisol, part, { type: 'talk' }, DAY, newId, ctx())).toMatchObject({ ok: false, reason: 'waiting' });
    const done = view(playQuest(leela, EMPTY_HISTORY).h, cat);
    expect(questStatus(marisol, done)).toBe('open');
    expect(advance(marisol, done, { type: 'talk' }, DAY, newId, ctx()).ok).toBe(true);
  });

  it("unlock.trust above the player's trust changes neither questStatus nor advance (advisory, Ruling 3)", () => {
    const p = view(EMPTY_HISTORY, cat);
    expect(p.trust).toEqual({});
    const demanding: Quest = { ...leela, unlock: { requires: [], trust: 5 } };
    expect(questStatus(demanding, p)).toBe(questStatus(leela, p));
    expect(advance(demanding, p, { type: 'talk' }, DAY, () => 'same', ctx())).toEqual(advance(leela, p, { type: 'talk' }, DAY, () => 'same', ctx()));
  });

  it('quest_done once: replaying the last step after done → already_done', () => {
    const { h } = playQuest(leela, EMPTY_HISTORY);
    const p = view(h, cat);
    const cooked = h.events.find((e) => e.kind === 'cooked')!.id;
    expect(advance(leela, p, { type: 'cook', cookedEventId: cooked }, DAY, newId, ctx())).toEqual({ ok: false, reason: 'already_done', say: [] });
    expect(advance(leela, p, { type: 'talk' }, DAY, newId, ctx())).toMatchObject({ ok: false, reason: 'already_done' });
    expect(h.events.filter((e) => e.kind === 'quest_done')).toHaveLength(1);
  });

  it('every step passed but quest_done lost → advance gives just quest_done', () => {
    let h = playSteps(leela, EMPTY_HISTORY, 4);
    h = record(h, [{ id: newId(), kind: 'cooked', at: DAY, recipe: 'india/kerala/parippu', planned: false }], cat);
    const r = advance(leela, view(h, cat), { type: 'cook', cookedEventId: 'c' }, DAY, newId, ctx());
    if (!r.ok) throw new Error(r.reason);
    h = record(h, r.events.filter((e) => e.kind === 'quest_step'), cat); // the quest_done write is lost
    const p = view(h, cat);
    expect(questStatus(leela, p)).toBe('in_progress');
    expect(currentStep(leela, p)).toBeNull();
    const again = advance(leela, p, { type: 'talk' }, DAY, newId, ctx());
    expect(again.ok && again.events.map((e) => e.kind)).toEqual(['quest_done']);
  });

  it('a travel step passes on arrival and says its lines', () => {
    const q: Quest = { ...leela, steps: [{ type: 'travel', place: 'leela', lines: ['You came.'] }, ...leela.steps] };
    const r = advance(q, view(EMPTY_HISTORY, cat), { type: 'travel' }, DAY, newId, ctx());
    expect(r).toMatchObject({ ok: true, say: ['You came.'] });
    expect(advance(q, view(EMPTY_HISTORY, cat), { type: 'talk' }, DAY, newId, ctx())).toMatchObject({ ok: false, reason: 'not_current' });
  });

  it('every quest in the shipped files plays to done through grantsFor', () => {
    let h = EMPTY_HISTORY;
    for (const id of ['leela-tempering', 'marisol-salt-question', 'haruka-gluey-rice']) {
      const q = id === 'marisol-salt-question' ? marisolR : quests[id];
      h = playQuest(q, h).h;
      expect(questStatus(q, view(h, cat))).toBe('done');
    }
  });
});
