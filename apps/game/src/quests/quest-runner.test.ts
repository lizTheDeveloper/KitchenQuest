// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { deriveProgress, frameOptions, type Catalogue, type ProgressEvent, type Quest, type Rule } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import { createStore } from '../state/store';
import { catalogueOf, stepContextOf } from '../progress/catalogue';
import { cookStepEvents, runQuest, type QuestRunnerDeps } from './quest-runner';
import { standInFixture } from '../progress/stand-in.fixture';

const leela = content.cooks.leela.quest;
const marisol = content.cooks.marisol.quest;
const TODAY = '2026-11-09';
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A runner over an in-memory event list, folded by core with `cat`. `choose` picks a quest panel's button by its label. */
function harness(_q: Quest, opts: { rules?: Rule[] | null; cat?: Catalogue; events?: ProgressEvent[]; keep?: boolean } = {}) {
  const cat = opts.cat ?? catalogueOf();
  const events: ProgressEvent[] = [...(opts.events ?? [])];
  const slot = document.createElement('div');
  document.body.replaceChildren(slot);
  const controller = new AbortController();
  const panLines: string[] = [];
  let calls = 0;
  const deps: QuestRunnerDeps = {
    progress: () => deriveProgress({ events, grants: [], base: null }, cat),
    // `keep: false` is a record that never lands (offline and refused on the device, or the daily cap).
    record: (e) => { calls += 1; if (opts.keep !== false) events.push(...e); return Promise.resolve([]); },
    pantry: () => [], rules: () => (opts.rules === undefined ? [] : opts.rules), graph, subs: [...content.substitutions],
    today: () => TODAY, signal: controller.signal,
    pan: { portrait: null, line: (trigger, vars) => { panLines.push(trigger); return `${trigger} ${JSON.stringify(vars)}`; } },
    reducedMotion: true,
  };
  return { slot, events, deps, controller, panLines, calls: () => calls };
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
    // At the cook step: parippu is cookable, so the runner hands over to the card ('cook').
    expect(result).toBe('cook');
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

  test('quest runner: unreadable rules hold an errand (never "safe" by default), with a link to Your rules', async () => {
    const h = harness(leela, { rules: null, events: [{ id: 's1', kind: 'quest_step', at: TODAY, quest: leela.id, step: 1 }] });
    let href: string | null = null;
    const r = await drive(h.slot, runQuest(h.slot, leela, h.deps), (panel) => { href = panel.querySelector('a.quest-rules-link')?.getAttribute('href') ?? null; return 'Later'; });
    expect(r).toBe('paused');
    expect(href).toBe('#/rules');
    expect(h.events).toHaveLength(1);
  });

  test('I1: a record that never lands stops the step with the written line and a bounded retry; never a loop', async () => {
    // The reviewer's repro: at a cook step whose dish was already cooked, a record that keeps nothing.
    const done: ProgressEvent[] = [1, 2, 3, 4, 5].map((step) => ({ id: `s${step}`, kind: 'quest_step', at: TODAY, quest: leela.id, step }));
    const cooked: ProgressEvent = { id: 'c1', kind: 'cooked', at: TODAY, recipe: 'india/kerala/parippu', planned: false };
    const h = harness(leela, { events: [...done, cooked], keep: false });
    const seen: string[] = [];
    const r = await drive(h.slot, runQuest(h.slot, leela, h.deps), (panel) => (panel.textContent?.includes('Try again') ? 'Try again' : 'Later'), seen);
    expect(r).toBe('paused');
    expect(h.calls()).toBeLessThanOrEqual(3);
    expect(h.panLines.filter((t) => t === 'quest.not_saved').length).toBeGreaterThan(0);

    // A talk step whose record never lands says its lines once, then stops: no auto-replay.
    const t = harness(leela, { keep: false });
    const said: string[] = [];
    const tr = await drive(t.slot, runQuest(t.slot, leela, t.deps), () => 'Later', said);
    expect(tr).toBe('paused');
    expect(t.calls()).toBe(1);
    const first = leela.steps[0].type === 'talk' ? leela.steps[0].lines[0] : '';
    expect(said.filter((x) => x === first)).toHaveLength(1);
  });

  test('I2: a ❓ quest dish offers the adapted lesson (no stand-in passes) as well as "Cook it anyway"', async () => {
    // Any rule leaves parippu ❓ (label-dependent ingredients); a peanut rule doesn't block it.
    const peanut: Rule = { id: 'r3', target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' };
    const done: ProgressEvent[] = [1, 2, 3, 4, 5].map((step) => ({ id: `s${step}`, kind: 'quest_step', at: TODAY, quest: leela.id, step }));
    let buttons: string[] = [];
    const a = harness(leela, { rules: [peanut], events: done });
    const ar = await drive(a.slot, runQuest(a.slot, leela, a.deps), (panel) => {
      buttons = [...panel.querySelectorAll('button')].map((b) => b.textContent ?? '');
      return 'Cook it anyway';
    });
    expect(buttons).toEqual(['Learn it as a lesson', 'Cook it anyway', 'Not yet']);
    expect(ar).toBe('cook');
    expect(a.events).toHaveLength(5);
    const b = harness(leela, { rules: [peanut], events: done });
    expect(await drive(b.slot, runQuest(b.slot, leela, b.deps), () => 'Learn it as a lesson')).toBe('done');
    expect(b.events.slice(5).map((e) => e.kind)).toEqual(['quest_step', 'lesson', 'quest_done']);
    expect(b.panLines).not.toContain('quest.cook_adapted'); // that line says the dish isn't for them: only for ⛔
    // A real cook of the ❓ dish still completes the step (Task 2 I2).
    const c = harness(leela, { rules: [peanut], events: [...done, { id: 'c1', kind: 'cooked', at: TODAY, recipe: 'india/kerala/parippu', planned: false }] });
    expect(await drive(c.slot, runQuest(c.slot, leela, c.deps), () => 'Later')).toBe('done');
  });

  test('quest runner: a rule-blocked quest dish with no stand-in is taught as the adapted lesson (quest.cook_adapted)', async () => {
    const coconut: Rule = { id: 'r2', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };
    const done: ProgressEvent[] = [1, 2, 3, 4, 5].map((step) => ({ id: `s${step}`, kind: 'quest_step', at: TODAY, quest: leela.id, step }));
    const h = harness(leela, { rules: [coconut], events: done });
    let buttons: string[] = [];
    const r = await drive(h.slot, runQuest(h.slot, leela, h.deps), (panel) => {
      buttons = [...panel.querySelectorAll('button')].map((b) => b.textContent ?? '');
      return 'Learn it as a lesson';
    });
    expect(buttons).toEqual(['Learn it as a lesson', 'Not yet']); // ⛔: never "Cook it anyway"
    expect(r).toBe('done');
    expect(h.panLines).toContain('quest.cook_adapted');
    expect(h.events.slice(5).map((e) => e.kind)).toEqual(['quest_step', 'lesson', 'quest_done']);
  });

  test('N3: a ❓ quest dish with a stand-in lists it and still offers "Cook it anyway" (no lesson while a stand-in exists)', async () => {
    const fx = standInFixture();
    const dal = fx.ctx.recipes.get(fx.standIn)!;
    const withDal = { ...content, recipes: { ...content.recipes, [fx.standIn]: dal } };
    const peanut: Rule = { id: 'r3', target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' };
    const done: ProgressEvent[] = [1, 2, 3, 4, 5].map((step) => ({ id: `s${step}`, kind: 'quest_step', at: TODAY, quest: leela.id, step }));
    const h = harness(leela, { rules: [peanut], events: done });
    let buttons: string[] = [];
    let links: string[] = [];
    const r = await drive(h.slot, runQuest(h.slot, leela, { ...h.deps, content: withDal }), (panel) => {
      buttons = [...panel.querySelectorAll('button')].map((b) => b.textContent ?? '');
      links = [...panel.querySelectorAll('.quest-alternatives a')].map((a) => a.getAttribute('href') ?? '');
      return 'Cook it anyway';
    });
    expect(links).toEqual([`#/recipe/${fx.standIn}`]);
    expect(buttons).toEqual(['Cook it anyway', 'Not yet']);
    expect(r).toBe('cook');
  });

  test('Step 10 carry: a Pantry Frame that passes is offered as a stand-in, linked to frame cook mode', async () => {
    const coconut: Rule = { id: 'r2', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };
    // A frame that practises legumes (one of parippu's techniques) and fills, ✅, from this pantry.
    const frame = { ...content.frames[0], technique: 'legumes' };
    const pantry = [{ name: 'cooked rice', ingredientId: 'cooked_rice' }, { name: 'sunflower oil', ingredientId: 'neutral_oil' }];
    const withFrame = { ...content, frames: [frame] };
    const passes = frameOptions([frame], pantry, { rules: [coconut], graph, subs: [...content.substitutions], today: TODAY, keeps: content.keeps })[0].status;
    expect(['ok', 'swap']).toContain(passes); // the frame would stand in, if frames were offered
    const done: ProgressEvent[] = [1, 2, 3, 4, 5].map((step) => ({ id: `s${step}`, kind: 'quest_step', at: TODAY, quest: leela.id, step }));
    const h = harness(leela, { rules: [coconut], events: done });
    let text = '';
    let href: string | null = null;
    const r = await drive(h.slot, runQuest(h.slot, leela, { ...h.deps, content: withFrame, pantry: () => pantry }), (panel) => {
      text = panel.textContent ?? '';
      href = panel.querySelector('.quest-alternatives a')?.getAttribute('href') ?? null;
      return 'Not yet';
    });
    expect(r).toBe('paused');
    expect(text).toContain(frame.title);
    expect(href).toBe(`#/frame/${frame.id}`);
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

// M6 Step 10: an errand's stall question. It plays before the step goes on as in M5, and the step passes whatever is
// answered: a right and a wrong answer complete it with identical events and grants.
describe('errand stall question (M6 Step 10)', () => {
  const ctxOf = (rules: Rule[] = []) => ({ rules, graph, subs: [...content.substitutions], date: TODAY, country: null });
  const errandOf = (item: string, stall: string): Quest => ({
    ...leela, id: 'fixture-errand-q',
    steps: [{ type: 'errand', stall, item, lines: ['Go and fetch it.', 'Thank you.'] }, { type: 'talk', lines: ['Done.'] }],
  });
  const catFor = (): Catalogue => {
    const base = catalogueOf();
    return { ...base, quests: new Map([...base.quests, ['fixture-errand-q', { cook: 'leela', steps: 2, xp: 0, trust: 0, skills: [], requires: [] }]]) };
  };

  test('Marisol\'s black_bean errand matches an Okafor-Sato bean question; Leela\'s shallot errand matches none', async () => {
    const { loadMarket } = await import('../market/content');
    const { errandQuestionFor } = await import('./errand-question');
    const m = await loadMarket();
    const marisolErrand = marisol.steps.find((s) => s.type === 'errand');
    const leelaErrand = leela.steps.find((s) => s.type === 'errand');
    if (marisolErrand?.type !== 'errand' || leelaErrand?.type !== 'errand') throw new Error('errands');
    expect([marisolErrand.item, marisolErrand.stall]).toEqual(['black_bean', 'okafor-sato']);
    const q = errandQuestionFor('black_bean', m.stalls['okafor-sato'], ctxOf(), null, 11, m.seasonality, new Map(), graph);
    expect(q).not.toBeNull();
    expect(q!.contains).toContain('bean');
    expect([leelaErrand.item, leelaErrand.stall]).toEqual(['shallot', 'wen']);
    expect(errandQuestionFor('shallot', m.stalls.wen, ctxOf(), null, 11, m.seasonality, new Map(), graph)).toBeNull();
    // Under a soy-and-beans-free rule set nothing about beans may be asked (stallBank keeps only ✅ questions).
    const noBean: Rule = { id: 'r-b', target: { kind: 'ingredient', ids: ['bean'] }, type: 'avoid', severity: 'allergy' };
    expect(errandQuestionFor('black_bean', m.stalls['okafor-sato'], ctxOf([noBean]), null, 11, m.seasonality, new Map(), graph)).toBeNull();
  });

  test('errand: right and wrong answers both complete the step with identical grants; no passing question → no question shown', async () => {
    const { loadMarket } = await import('../market/content');
    const { errandQuestionFor } = await import('./errand-question');
    const m = await loadMarket();
    const question = errandQuestionFor('black_bean', m.stalls['okafor-sato'], ctxOf(), null, 11, m.seasonality, new Map(), graph)!;
    const q = errandOf('black_bean', 'okafor-sato');
    const play = async (pickRight: boolean | null) => {
      const h = harness(q, { cat: catFor() });
      const recorded: { q: string; pick: number }[][] = [];
      h.deps.errandQuestion = () => Promise.resolve(pickRight === null ? null : {
        question, keeper: 'Okafor-Sato',
        round: { gameName: () => null, keeperLine: () => null, panLine: () => null, itemArt: () => null, itemName: () => null, priceFootnote: '*Example prices.' },
        record: (a) => { recorded.push(a); },
      });
      const seen: string[] = [];
      const result = await drive(h.slot, runQuest(h.slot, q, h.deps), (panel) => {
        const options = [...panel.querySelectorAll<HTMLButtonElement>('.stall-option')];
        if (options.length > 0 && !options[0].classList.contains('is-answered')) {
          const want = options.find((b) => (question.options[Number(b.dataset.pick)].correct === true) === pickRight)!;
          return want.textContent ?? '';
        }
        if (panel.querySelector('.stall-next')) return 'Finish the round';
        return "I've got it";
      }, seen);
      const shown = seen.some((t) => t.includes(question.prompt));
      return { result, recorded, shown, events: h.events.map(({ id: _id, ...e }) => e), view: h.deps.progress() };
    };
    const right = await play(true);
    const wrong = await play(false);
    const none = await play(null);
    for (const r of [right, wrong, none]) expect(r.result).toBe('done');
    expect(right.shown && wrong.shown).toBe(true);
    expect(none.shown).toBe(false);
    expect(right.events).toEqual(wrong.events);
    expect(right.events).toEqual(none.events);
    expect({ xp: right.view.xp, steps: right.view.questSteps, done: right.view.questsDone }).toEqual({ xp: wrong.view.xp, steps: wrong.view.questSteps, done: wrong.view.questsDone });
    // One answer each, kept as a one-answer stall_round by `record`; nothing when no question played.
    expect(right.recorded).toHaveLength(1);
    expect(right.recorded[0]).toHaveLength(1);
    expect(wrong.recorded).toHaveLength(1);
    expect(none.recorded).toEqual([]);
  });
});

// Fix round 1 (I2): a stalled market chunk or profile read never holds an errand: no question, the M5 step at once.
describe('errand stall question: a hung lookup (I2)', () => {
  const step = { stall: 'okafor-sato', item: 'black_bean' };
  const deps = (over: { load?: () => Promise<never>; getProfile?: () => Promise<never>; signedIn?: boolean }) => {
    const store = createStore(null);
    if (over.signedIn) store.update((s) => ({ ...s, account: { email: 'e@x.test' }, accountRules: [] }));
    return {
      store,
      client: { getProfile: over.getProfile ?? (() => Promise.resolve({ ok: true, status: 200, data: { marketDays: [], mealsPerWeek: null, country: null, region: null, mealWindows: [] } })) } as never,
      service: { record: () => Promise.resolve([]), view: () => deriveProgress({ events: [], grants: [], base: null }, catalogueOf()) },
      today: () => TODAY,
    };
  };
  const hung = () => new Promise<never>(() => {});

  test('the market chunk hung, or the profile read hung → null by the 3 s limit', async () => {
    const { errandQuestions } = await import('./errand-question');
    const { LOOKUP_TIMEOUT_MS } = await import('../shell/within');
    vi.useFakeTimers();
    try {
      const a = errandQuestions({ ...deps({}), load: hung })(step);
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
      expect(await a).toBeNull();
      const { loadMarket } = await import('../market/content');
      await loadMarket(); // the real chunk, so only the profile hangs below
      const b = errandQuestions({ ...deps({ signedIn: true, getProfile: hung }) })(step);
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS + 10);
      expect(await b).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  test('M8 (final): one deadline for both: a market chunk that takes 2.9 s, then a hung profile read → null by 3 s in all', async () => {
    const { errandQuestions } = await import('./errand-question');
    const { LOOKUP_TIMEOUT_MS } = await import('../shell/within');
    const { loadMarket } = await import('../market/content');
    const m = await loadMarket();
    vi.useFakeTimers();
    try {
      const slow = () => new Promise<typeof m>((r) => { setTimeout(() => { r(m); }, LOOKUP_TIMEOUT_MS - 100); });
      let done = false;
      const a = errandQuestions({ ...deps({ signedIn: true, getProfile: hung }), load: slow })(step).then((v) => { done = true; return v; });
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS + 10);
      expect(done).toBe(true);
      expect(await a).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  test('final I2: a question built in Family Table keeps nothing, even when Family Table is switched off before the answer', async () => {
    const { errandQuestions } = await import('./errand-question');
    const d = deps({});
    d.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    const sent: unknown[] = [];
    const asked = await errandQuestions({ ...d, service: { ...d.service, record: (e) => { sent.push(e); return Promise.resolve([]); } } })(step);
    expect(asked).not.toBeNull();
    d.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: false } })); // another tab, say
    asked!.record([{ q: asked!.question.id, pick: 0 }]);
    expect(sent).toEqual([]);
    // Built with Family Table off, the same answer is kept.
    const plain = deps({});
    const kept: unknown[] = [];
    const b = await errandQuestions({ ...plain, service: { ...plain.service, record: (e) => { kept.push(e); return Promise.resolve([]); } } })(step);
    b!.record([{ q: b!.question.id, pick: 0 }]);
    expect(kept).toHaveLength(1);
  });

  test('the runner goes on to the M5 errand step (pantry or tap) when the lookup gives up', async () => {
    const { errandQuestions } = await import('./errand-question');
    const q: Quest = {
      ...leela, id: 'fixture-errand-q',
      steps: [{ type: 'errand', stall: 'okafor-sato', item: 'black_bean', lines: ['Go and fetch it.', 'Thank you.'] }, { type: 'talk', lines: ['Done.'] }],
    };
    const base = catalogueOf();
    const cat: Catalogue = { ...base, quests: new Map([...base.quests, ['fixture-errand-q', { cook: 'leela', steps: 2, xp: 0, trust: 0, skills: [], requires: [] }]]) };
    const h = harness(q, { cat });
    h.deps.errandQuestion = errandQuestions({ ...deps({}), load: hung, timeoutMs: 30 });
    const seen: string[] = [];
    const result = await drive(h.slot, runQuest(h.slot, q, h.deps), (panel) => (panel.textContent?.includes('Fetch') ? "I've got it" : 'Not yet'), seen);
    expect(result).toBe('done');
    expect(seen.some((t) => t.includes('Fetch'))).toBe(true);
    expect(h.slot.querySelector('.quest-errand-question')).toBeNull();
  });
});
