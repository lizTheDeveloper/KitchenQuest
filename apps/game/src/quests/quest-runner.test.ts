// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { deriveProgress, type Catalogue, type ProgressEvent, type Quest, type Rule } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import { catalogueOf, stepContextOf } from '../progress/catalogue';
import { cookStepEvents, runQuest, type QuestRunnerDeps } from './quest-runner';

const leela = content.cooks.leela.quest;
const marisol = content.cooks.marisol.quest;
const TODAY = '2026-11-09';
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A runner over an in-memory event list, folded by core with `cat`. `choose` picks a quest panel's button by its label. */
function harness(_q: Quest, opts: { rules?: Rule[] | null; cat?: Catalogue; events?: ProgressEvent[] } = {}) {
  const cat = opts.cat ?? catalogueOf();
  const events: ProgressEvent[] = [...(opts.events ?? [])];
  const slot = document.createElement('div');
  document.body.replaceChildren(slot);
  const controller = new AbortController();
  const panLines: string[] = [];
  const deps: QuestRunnerDeps = {
    progress: () => deriveProgress({ events, grants: [], base: null }, cat),
    record: (e) => { events.push(...e); return Promise.resolve([]); },
    pantry: () => [], rules: () => (opts.rules === undefined ? [] : opts.rules), graph, subs: [...content.substitutions],
    today: () => TODAY, signal: controller.signal,
    pan: { portrait: null, line: (trigger, vars) => { panLines.push(trigger); return `${trigger} ${JSON.stringify(vars)}`; } },
    reducedMotion: true,
  };
  return { slot, events, deps, controller, panLines };
}

/** Click through dialogue boxes; at each quest panel, `pick` names the button to press (by its text). */
async function drive(slot: HTMLElement, done: Promise<unknown>, pick: (panel: HTMLElement) => string, seen: string[] = []) {
  let finished = false;
  void done.then(() => { finished = true; });
  for (let i = 0; i < 400 && !finished; i++) {
    await tick();
    const next = slot.querySelector<HTMLButtonElement>('.dialogue .dialogue-next');
    if (next) { seen.push(slot.querySelector('.dialogue-text')?.textContent ?? ''); next.click(); continue; }
    const panel = slot.querySelector<HTMLElement>('.quest-panel');
    if (panel) {
      const want = pick(panel);
      seen.push(panel.textContent ?? '');
      const b = [...panel.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === want);
      if (!b) throw new Error(`no button "${want}" in: ${panel.textContent}`);
      b.click();
    }
  }
  return done;
}

describe('quest runner', () => {
  test('quest runner: Leela\'s quest talk → errand → drill → riddle → recognize → cook, events in order; wrong riddle → reaction, same step', async () => {
    const h = harness(leela);
    const riddle = leela.steps.find((s) => s.type === 'riddle')!;
    if (riddle.type !== 'riddle') throw new Error('riddle');
    const wrong = riddle.options.find((o) => !o.correct)!;
    const right = riddle.options.find((o) => o.correct)!;
    let wrongTried = false;
    const seen: string[] = [];
    const result = await drive(h.slot, runQuest(h.slot, leela, h.deps), (panel) => {
      const text = panel.textContent ?? '';
      if (text.includes(riddle.prompt)) {
        if (!wrongTried) { wrongTried = true; return wrong.text; }
        // The wrong option's reaction is shown, and the same riddle is asked again.
        expect(panel.querySelector('.quest-reaction')!.textContent).toBe(wrong.reaction);
        return right.text;
      }
      if (text.includes('Fetch')) return "I've got it";
      return "I've practised it";
    }, seen);
    // Paused at the cook step: parippu is cookable, so the visit shows the card.
    expect(result).toBe('paused');
    const steps = h.events.map((e) => (e.kind === 'quest_step' ? `step${e.step}` : e.kind));
    expect(steps).toEqual(['step1', 'step2', 'step3', 'drill', 'step4', 'step5']);
    expect(h.events.every((e) => e.at === TODAY)).toBe(true);
    // A wrong answer recorded nothing: no penalty, just the reaction.
    expect(h.events.filter((e) => e.kind === 'quest_step' && e.step === 4)).toHaveLength(1);
    expect(seen.join(' ')).toContain(right.reaction);

    // Cook mode finishes: the cooked event, then the cook step and the quest's end.
    h.events.push({ id: 'c1', kind: 'cooked', at: TODAY, recipe: leela.steps[5].type === 'cook' ? leela.steps[5].recipe : '', planned: false });
    const ctx = stepContextOf([], [], TODAY);
    const tail = cookStepEvents([leela, marisol], h.deps.progress(), TODAY, ctx);
    expect(tail.map((e) => (e.kind === 'quest_step' ? `step${e.step}` : e.kind))).toEqual(['step6', 'quest_done']);
  });

  test('quest runner: an errand item blocked by the player\'s rules → adapted, with the cook\'s lines or the Pan fallback, plus a swap card (C5); a waiting quest is not started (C4)', async () => {
    // Leela's shallot errand under an allium rule: no adapted lines in her file → the Pan's quest.errand_adapted.
    const allium: Rule = { id: 'r1', target: { kind: 'ingredient', ids: ['shallot'] }, type: 'avoid', severity: 'anaphylactic' };
    const h = harness(leela, { rules: [allium], events: [{ id: 's1', kind: 'quest_step', at: TODAY, quest: leela.id, step: 1 }] });
    const run = runQuest(h.slot, leela, h.deps);
    const seen: string[] = [];
    await drive(h.slot, run, (panel) => (panel.textContent?.includes('Fetch') ? 'FAIL: asked to fetch a blocked item' : 'Not yet'), seen);
    expect(h.panLines[0]).toBe('quest.errand_adapted');
    expect(h.events.map((e) => (e.kind === 'quest_step' ? e.step : e.kind))).toEqual([1, 2]); // passed, same events
    expect(seen.join(' ')).not.toContain('Fetch');

    // A fixture errand whose cook has adapted lines, for an item with a rules-safe swap (coconut oil → neutral oil).
    const fixture: Quest = {
      ...leela, id: 'fixture-errand',
      steps: [{ type: 'errand', stall: 'wen', item: 'coconut_oil', lines: ['Fetch the oil.', 'Thank you.'], adapted: ['We use another oil for you.'] }, { type: 'talk', lines: ['Done.'] }],
    };
    const base = catalogueOf();
    const cat: Catalogue = { ...base, quests: new Map([...base.quests, ['fixture-errand', { cook: 'leela', steps: 2, xp: 0, trust: 0, skills: [], requires: [] }]]) };
    const coconut: Rule = { id: 'r2', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };
    const f = harness(fixture, { rules: [coconut], cat });
    const fseen: string[] = [];
    const fr = await drive(f.slot, runQuest(f.slot, fixture, f.deps), (panel) => {
      if (panel.querySelector('.quest-swap')) {
        expect(panel.querySelector('.swap-label')!.textContent).toMatch(/Swap/);
        expect(panel.querySelector('.swap-name')!.textContent).toBe(graph.get('neutral_oil').name);
        return 'Continue';
      }
      return 'Not yet';
    }, fseen);
    expect(fr).toBe('done');
    expect(fseen.some((t) => t.includes('Swap, checked against your rules'))).toBe(true);
    expect(fseen).toContain('We use another oil for you.');
    expect(fseen.join(' ')).not.toContain('Fetch the oil.');
    expect(f.panLines).not.toContain('quest.errand_adapted');

    // Marisol's quest waits on Leela's (unlock.requires, C4): the runner records nothing and shows nothing.
    const w = harness(marisol);
    expect(await runQuest(w.slot, marisol, w.deps)).toBe('paused');
    expect(w.events).toEqual([]);
    expect(w.slot.childElementCount).toBe(0);
  });

  test('quest runner: unreadable rules hold an errand (never "safe" by default)', async () => {
    const h = harness(leela, { rules: null, events: [{ id: 's1', kind: 'quest_step', at: TODAY, quest: leela.id, step: 1 }] });
    const r = await drive(h.slot, runQuest(h.slot, leela, h.deps), () => 'Later');
    expect(r).toBe('paused');
    expect(h.events).toHaveLength(1);
  });

  test('quest runner: a rule-blocked quest dish with no stand-in is taught as the adapted lesson (quest.cook_adapted)', async () => {
    const coconut: Rule = { id: 'r2', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };
    const done: ProgressEvent[] = [1, 2, 3, 4, 5].map((step) => ({ id: `s${step}`, kind: 'quest_step', at: TODAY, quest: leela.id, step }));
    const h = harness(leela, { rules: [coconut], events: done });
    const r = await drive(h.slot, runQuest(h.slot, leela, h.deps), () => 'Learn it as a lesson');
    expect(r).toBe('done');
    expect(h.panLines).toContain('quest.cook_adapted');
    expect(h.events.slice(5).map((e) => e.kind)).toEqual(['quest_step', 'lesson', 'quest_done']);
  });

  test('riddle answers are buttons, reachable by keyboard', async () => {
    const done: ProgressEvent[] = [1, 2, 3].map((step) => ({ id: `s${step}`, kind: 'quest_step', at: TODAY, quest: leela.id, step }));
    const h = harness(leela, { events: done });
    void runQuest(h.slot, leela, h.deps);
    for (let i = 0; i < 20 && !h.slot.querySelector('.quest-panel'); i++) await tick();
    const buttons = [...h.slot.querySelectorAll<HTMLButtonElement>('.quest-panel button')];
    expect(buttons.length).toBe(4);
    for (const b of buttons) { expect(b.type).toBe('button'); expect(b.tabIndex).not.toBe(-1); }
    expect(document.activeElement).toBe(buttons[0]);
    h.controller.abort();
  });
});
