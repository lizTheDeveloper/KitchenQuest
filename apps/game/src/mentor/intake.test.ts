// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { ApiResult, Consents, TurnResponse } from '../api/types';
import { content, graph } from '../content';
import { createStore, type PlayerState } from '../state/store';
import { createAiBackend } from './ai-backend';
import { createScriptedBackend, type MentorBackend } from './backend';
import { createDialogue } from './dialogue';
import { createIntake, INTAKE_ORDER, parseIntakeAnswer } from './intake';
import { mountMentorPanel } from './panel';
import { createScriptedEngine } from './scripted';
import { createCardWriter } from './writer';

const T0 = new Date('2026-11-10T12:00:00Z');
const deps = { graph, ruleTerms: content.ruleTerms };
const lines = (id: string) => content.pan.triggers[id].lines;
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('parseIntakeAnswer (AI off)', () => {
  test.each([
    ['market_day', 'Saturdays usually', { kind: 'card', card: { kind: 'profile', patch: { marketDays: [6] } } }],
    ['meals_per_week', 'maybe four', { kind: 'card', card: { patch: { mealsPerWeek: 4 } } }],
    ['region', 'Pacific Northwest, USA', { kind: 'card', card: { patch: { region: 'Pacific Northwest', country: 'USA' } } }],
    ['region', 'Portugal', { kind: 'card', card: { patch: { region: null, country: 'Portugal' } } }],
    ['allergies', 'none', { kind: 'none' }],
    ['allergies', 'severe peanut allergy', { kind: 'card', card: { kind: 'rule', severe: true } }],
    ['allergies', 'peanuts', { kind: 'card', card: { kind: 'rule', rule: { target: { ids: ['peanut'] } } } }],
    ['pantry', 'rice, beans and eggs', { kind: 'card', card: { kind: 'pantry' } }],
    ['market_day', 'whenever the fridge echoes', { kind: 'unparsed' }],
    ['region', 'skip', { kind: 'skip' }],
    ['allergies', 'not now', { kind: 'skip' }],
    ['meals_per_week', 'pass', { kind: 'skip' }],
  ] as const)('%s: %s', (step, text, want) => {
    expect(parseIntakeAnswer(step, text, deps)).toMatchObject(want);
  });

  test('"that\'s all" after a stamped rule is done; a skip word inside a real answer is not a skip', () => {
    expect(parseIntakeAnswer('allergies', "that's all", { ...deps, rulesStamped: true })).toEqual({ kind: 'done' });
    expect(parseIntakeAnswer('allergies', "I can't eat peanuts, pass the salt", deps).kind).not.toBe('skip');
    expect(parseIntakeAnswer('market_day', 'Saturday, later in the day', deps)).toMatchObject({ kind: 'card', card: { patch: { marketDays: [6] } } });
  });

  test.each([
    ['peanuts and shellfish', ['peanut', 'shellfish']],
    ['peanut, sesame, milk', ['peanut', 'sesame', 'milk']],
    ['tree nuts and sesame', ['tree_nut', 'sesame']],
    ['just peanuts', ['peanut']],
    ['only shellfish', ['shellfish']],
    ['none except peanuts', ['peanut']],
    ['nope, just peanuts', ['peanut']],
    ['milk or eggs', ['milk', 'egg']],
  ])('a bare list keeps every term, each a severe card that needs a tap (fix round 1, C2): %s', (text, ids) => {
    const r = parseIntakeAnswer('allergies', text, deps);
    const results = r.kind === 'rules' ? r.results : r.kind === 'card' ? [{ ok: true as const, card: r.card }] : [];
    expect(results.map((x) => x.ok && x.card.kind === 'rule' && x.card.rule.target.ids[0])).toEqual(ids);
    for (const x of results) expect(x.ok && x.card.kind === 'rule' && x.card.severe && x.card.rule.severity).toBe('anaphylactic');
  });

  test.each([
    ['vegan and peanuts', ['vegan', 'peanut']],
    ['peanuts and vegan', ['vegan', 'peanut']],
    ['vegetarian, sesame', ['vegetarian', 'sesame']],
    ['gluten free and peanuts', ['coeliac', 'peanut']],
    ['milk intolerance and peanuts', ['milk', 'peanut']],
    ["i'm lactose intolerant and peanuts", ['milk', 'peanut']],
    ['peanuts; sesame', ['peanut', 'sesame']],
    ['peanuts/sesame', ['peanut', 'sesame']],
    ['shellfish (prawns mainly)', ['shellfish']],
    ['peanuts but not tree nuts', ['peanut']],
  ])('every named allergen gets a card (fix round 2): %s', (text, names) => {
    const r = parseIntakeAnswer('allergies', text, deps);
    const results = r.kind === 'rules' ? r.results : r.kind === 'card' ? [{ ok: true as const, card: r.card }] : [];
    expect(results.map((x) => x.ok && x.card.kind === 'rule' && x.card.display.ingredient)).toEqual(names);
    // A leftover name states no severity: its card asks, defaults to Severe allergy and needs a tap.
    for (const x of results.slice(1)) expect(x.ok && x.card.kind === 'rule' && x.card.severe).toBe(true);
  });

  test('"peanuts but not tree nuts": tree nuts are never a card, and the Pan says the allowance is not filed', () => {
    const r = parseIntakeAnswer('allergies', 'peanuts but not tree nuts', deps);
    expect(r).toMatchObject({ kind: 'rules', notes: [{ trigger: 'rule.exclusion_not_kept', vars: { term: 'tree nut' } }] });
  });

  test('an unknown part of a bare list gets its own line; the rest still get cards', () => {
    const r = parseIntakeAnswer('allergies', 'peanuts and kiwi', deps);
    expect(r).toMatchObject({ kind: 'rules', results: [{ ok: true }, { ok: false, reason: 'unknown_term', line: { vars: { term: 'kiwi' } } }] });
  });

  test('a plain yes or thanks at allergies names nothing (fix round 1, M7)', () => {
    expect(parseIntakeAnswer('allergies', 'yes', deps)).toEqual({ kind: 'unparsed' });
    expect(parseIntakeAnswer('allergies', 'thanks', deps)).toEqual({ kind: 'unparsed' });
  });

  test('a health statement is never a region or a pantry item', () => {
    expect(parseIntakeAnswer('region', "I'm allergic to peanuts", deps)).toEqual({ kind: 'unparsed' });
    expect(parseIntakeAnswer('pantry', "I'm allergic to peanuts", deps)).toEqual({ kind: 'unparsed' });
  });

  test('allergies keep every named term, and a severe term that is dropped gets the ask (Carry from Step 1)', () => {
    const two = parseIntakeAnswer('allergies', "I'm allergic to peanuts and sesame", deps);
    expect(two.kind).toBe('rules');
    if (two.kind !== 'rules') return;
    expect(two.results.map((r) => r.ok && r.card.display.ingredient)).toEqual(['peanut', 'sesame']);
    // The dropped severe term now gets its own card (fix round 2), never only an ask.
    const dropped = parseIntakeAnswer('allergies', "i'm vegetarian, peanuts nearly killed me", deps);
    expect(dropped.kind).toBe('rules');
    if (dropped.kind === 'rules') expect(dropped.results.map((r) => r.ok && r.card.display.ingredient)).toEqual(['vegetarian', 'peanut']);
    expect(parseIntakeAnswer('allergies', 'kiwi', deps)).toMatchObject({ kind: 'reply', reply: { ok: false, reason: 'unknown_term' } });
  });
});

const ok = <T>(data: T, status = 200): ApiResult<T> => ({ ok: true, status, data });
const NOTICES: Consents['notices'] = { health_data: { version: 'v2', text: 'The health notice.' }, ai_health: { version: 'v1', text: 'The AI notice.' } };

function setup(opts: { patch?: Partial<PlayerState>; consents?: Consents; ai?: (client: ApiClient, store: ReturnType<typeof createStore>) => MentorBackend; mentorTurn?: ApiClient['mentorTurn'] } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const store = createStore(null);
  store.update((s) => ({ ...s, aiDisclosureSeen: true, ...opts.patch }));
  const client = {
    consents: vi.fn(() => Promise.resolve(ok(opts.consents ?? { consents: [], needsReconsent: [], notices: NOTICES }))),
    grantConsent: vi.fn(() => Promise.resolve(ok({ consent: {} }, 201))),
    mentorTurn: vi.fn(opts.mentorTurn ?? (() => Promise.resolve({ ok: false, status: 503, error: { code: 'unavailable', message: '' } }))),
    getProfile: vi.fn(() => Promise.resolve(ok({ marketDays: [], mealsPerWeek: null, country: null, region: null, mealWindows: [] }))),
    putProfile: vi.fn((p: object) => Promise.resolve(ok(p))),
    me: vi.fn(() => Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } })),
  } as unknown as ApiClient;
  const dialogue = createDialogue(content.pan);
  const recipes = Object.entries(content.recipes).map(([slug, r]) => ({ slug, title: r.meta.title }));
  const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes, now: () => T0 });
  const writer = createCardWriter({ client, store, dialogue, graph, ruleTerms: content.ruleTerms, now: () => T0 });
  const backend = opts.ai ? opts.ai(client, store) : createScriptedBackend(engine, dialogue);
  const panel = mountMentorPanel(root, {
    mode: 'standard', backend, dialogue, writer, engine, client, forms: content.bureau.forms, store, reducedMotion: () => true, now: () => T0,
  });
  const intake = createIntake({
    panel, engine, ai: backend, store, client, dialogue, signedIn: () => store.get().account !== null,
    graph, ruleTerms: content.ruleTerms, form: content.bureau.forms.intake,
  });
  const send = async (text: string) => {
    root.querySelector<HTMLTextAreaElement>('#pan-text')!.value = text;
    root.querySelector('form')!.requestSubmit();
    await flush();
  };
  const tap = async (name: string) => {
    const b = [...root.querySelectorAll('button')].filter((x) => x.textContent === name && !x.disabled).at(-1);
    if (!b) throw new Error(`no button ${name}`);
    b.click();
    await flush();
  };
  const panTexts = () => [...root.querySelectorAll('.bubble.pan')].map((b) => b.textContent ?? '');
  const lastPan = () => panTexts().at(-1);
  return { root, store, client, panel, intake, send, tap, panTexts, lastPan, backend };
}

afterEach(() => { vi.useRealTimers(); });

describe('createIntake', () => {
  test('INTAKE_ORDER is the Form 1-A order', () => {
    expect(INTAKE_ORDER).toEqual(['market_day', 'meals_per_week', 'region', 'allergies', 'pantry']);
  });

  test('signed out, AI off: the whole interview by typing, every stamp ticks the checklist', async () => {
    const m = setup();
    m.panel.open();
    m.intake.start();
    await flush();
    const texts = m.panTexts();
    expect(lines('intake.open')).toContain(texts[0]);
    expect(lines('intake.market_day.ask')).toContain(texts[1]);
    expect(m.intake.step).toBe('market_day');
    expect(m.root.querySelector('.intake-checklist')!.textContent).toContain('1-A');

    await m.send('Saturdays usually');
    await m.tap('Ink it ✔');
    expect(m.panTexts().some((t) => lines('intake.market_day.followup').map((l) => l.replace('{day}', 'Saturday')).includes(t))).toBe(true);
    expect(lines('intake.meals_per_week.ask')).toContain(m.lastPan());
    await m.send('maybe four');
    await m.tap('Ink it ✔');
    await m.send('Pacific Northwest, USA');
    await m.tap('Ink it ✔');
    expect(m.intake.step).toBe('allergies');
    expect(lines('intake.allergies.ask')).toContain(m.lastPan());
    await m.send('peanuts');
    const card = m.root.querySelector('.pan-card')!;
    expect(card.textContent).toContain('*Kept on this device only.');
    await m.tap('Stamp it ✔');
    expect(lines('intake.allergies.followup')).toContain(m.lastPan());
    expect(m.intake.expecting).toBe('more_rules');
    await m.send("that's all");
    expect(lines('intake.pantry.ask')).toContain(m.lastPan());
    await m.send('rice, beans and eggs');
    await m.tap(content.bureau.forms.pantry.buttons.confirm);
    expect(lines('intake.complete')).toContain(m.lastPan());
    expect(m.intake.step).toBe('done');
    const s = m.store.get();
    expect(s.localProfile).toMatchObject({ marketDays: [6], mealsPerWeek: 4, region: 'Pacific Northwest', country: 'USA' });
    expect(s.localRules.map((r) => r.target.ids)).toEqual([['peanut']]);
    expect(s.localPantry.map((p) => p.name)).toEqual(['rice', 'beans', 'eggs']);
    expect([...m.root.querySelectorAll('.intake-field.is-stamped')]).toHaveLength(5);
    // No intake.notifications in M4 (reminders are M9).
    expect(m.panTexts().some((t) => lines('intake.notifications').includes(t))).toBe(false);
  });

  test('signed in without health_data: the consent card comes before intake.allergies.ask; declining skips to pantry', async () => {
    const m = setup({ patch: { account: { email: 'a@b.c' }, accountRules: [], intake: { step: 'allergies' } } });
    m.panel.open();
    m.intake.start();
    await flush();
    expect(m.intake.expecting).toBe('consent');
    const consent = m.root.querySelector('.consent-card')!;
    expect(consent.textContent).toContain('The health notice.');
    expect(m.panTexts().some((t) => lines('intake.allergies.ask').includes(t))).toBe(false);
    // A typed yes never grants consent: only the tap does.
    await m.send('yes');
    expect(m.client.grantConsent).not.toHaveBeenCalled();
    await m.tap('Not now');
    expect(m.client.grantConsent).not.toHaveBeenCalled();
    expect(m.intake.step).toBe('pantry');
    expect(lines('intake.pantry.ask')).toContain(m.lastPan());
    expect(m.panTexts().some((t) => lines('intake.skip').includes(t))).toBe(true);
  });

  test('signed in: a Pan line leads into the consent card; "yes" at allergies with no card gets the plain ask', async () => {
    const m = setup({ patch: { account: { email: 'a@b.c' }, accountRules: [], intake: { step: 'allergies' } }, consents: { consents: [], needsReconsent: [], notices: NOTICES } });
    m.panel.open();
    m.intake.start();
    await flush();
    expect(lines('intake.allergies.consent')).toContain(m.lastPan());
    await m.tap('I agree');
    await m.send('yes');
    expect(lines('rule.ask_keep_off')).toContain(m.lastPan());
    expect(m.root.querySelector('.pan-card')).toBeNull();
    expect(m.intake.step).toBe('allergies');
  });

  test('signed in: a consent notice that cannot load keeps the step open, with Try again (fix round 1, I1)', async () => {
    const m = setup({ patch: { account: { email: 'a@b.c' }, accountRules: [], intake: { step: 'allergies' } } });
    let fail = 2; // the intake's check, then the panel's notice fetch
    const real = m.client.consents;
    m.client.consents = vi.fn(() => (fail-- > 0 && fail === 0 ? Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } }) : real())) as never;
    m.panel.open();
    m.intake.start();
    await flush();
    expect(m.intake.step).toBe('allergies');
    expect(m.intake.expecting).toBe('consent');
    await m.tap('Try again');
    expect(m.root.querySelector('.consent-card')).not.toBeNull();
    await m.tap('I agree');
    expect(lines('intake.allergies.ask')).toContain(m.lastPan());
  });

  test('signed in: agreeing files the grant by tap, then asks about allergies; a stale notice asks again', async () => {
    const stale: Consents = {
      consents: [{ purpose: 'health_data', noticeVersion: 'v1', noticeSha256: 'x', method: 'tap', grantedAt: '2026-01-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: false }],
      needsReconsent: ['health_data'], notices: NOTICES,
    };
    const m = setup({ patch: { account: { email: 'a@b.c' }, accountRules: [], intake: { step: 'allergies' } }, consents: stale });
    m.panel.open();
    m.intake.start();
    await flush();
    await m.tap('I agree');
    expect(m.client.grantConsent).toHaveBeenCalledWith('health_data', 'v2');
    expect(lines('intake.allergies.ask')).toContain(m.lastPan());
    expect(m.intake.expecting).toBe('answer');
  });

  test('a step left on an earlier visit resumes there, with no second intake.open', async () => {
    const m = setup({ patch: { intake: { step: 'region' } } });
    m.panel.open();
    m.intake.start();
    await flush();
    expect(m.panTexts()).toHaveLength(1);
    expect(lines('intake.region.ask')).toContain(m.lastPan());
    expect([...m.root.querySelectorAll('.intake-tick')].map((t) => t.textContent)).toEqual(['Answered earlier', 'Answered earlier', 'Not yet', 'Not yet', 'Not yet']);
  });

  test('intake completes with every step skipped', async () => {
    const m = setup();
    m.panel.open();
    m.intake.start();
    await flush();
    for (let i = 0; i < 5; i++) await m.send('skip');
    expect(m.intake.step).toBe('done');
    expect(lines('intake.complete')).toContain(m.lastPan());
    expect(m.store.get().intake.step).toBe('done');
    expect([...m.root.querySelectorAll('.intake-tick')].map((t) => t.textContent)).toEqual(Array(5).fill('Skipped'));
    // Once done, typed text goes to the backend again.
    await m.send('thank you');
    expect(lines('thanks')).toContain(m.lastPan());
  });

  test('an unparsed answer without AI asks again with weekday chips; a chip answers', async () => {
    const m = setup();
    m.panel.open();
    m.intake.start();
    await flush();
    await m.send('whenever the fridge echoes');
    expect(lines('didnt_understand')).toContain(m.lastPan());
    await m.tap('Saturday');
    expect(m.root.querySelector('.pan-card')!.textContent).toContain('Saturday');
  });

  test('an unparsed answer goes to the AI with intakeStep when available', async () => {
    const bodies: unknown[] = [];
    const m = setup({
      patch: { account: { email: 'a@b.c' }, accountRules: [] },
      mentorTurn: (req) => {
        bodies.push(req);
        const res: TurnResponse = { conversationId: 'c1', route: 'ai', notice: null, toolTurn: true, actions: [], parts: [], cards: [] };
        return Promise.resolve(ok(res));
      },
      ai: (client, store) => {
        const dialogue = createDialogue(content.pan);
        const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes: [], now: () => T0 });
        return createAiBackend({ client, engine, dialogue, store, graph, ruleTerms: content.ruleTerms, now: () => T0, events: new EventTarget(), screen: () => null, intakeStep: () => { const s = store.get().intake.step; return s === 'done' ? null : s; } });
      },
    });
    m.panel.open();
    m.intake.start();
    await flush();
    await m.send('whenever the fridge echoes');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ input: { kind: 'text', text: 'whenever the fridge echoes' }, intakeStep: 'market_day' });
    // A parsed answer never goes to the AI.
    await m.send('Saturday');
    expect(bodies).toHaveLength(1);
  });

  test('the AI fails mid-intake (503, then rate_limited): the Pan re-asks with chips and the interview still completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    const m = setup({
      patch: { account: { email: 'a@b.c' }, accountRules: [] },
      consents: { consents: [], needsReconsent: [], notices: NOTICES },
      mentorTurn: () => {
        n++;
        if (n === 1) return Promise.resolve({ ok: false, status: 503, error: { code: 'unavailable', message: '' } });
        const res: TurnResponse = { conversationId: 'c1', route: 'scripted', notice: 'rate_limited', toolTurn: false, actions: [], parts: [], cards: [] };
        return Promise.resolve(ok(res));
      },
      ai: (client, store) => {
        const dialogue = createDialogue(content.pan);
        const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes: [], now: () => T0 });
        return createAiBackend({ client, engine, dialogue, store, graph, ruleTerms: content.ruleTerms, now: () => T0, events: new EventTarget(), screen: () => null, intakeStep: () => { const s = store.get().intake.step; return s === 'done' ? null : s; } });
      },
    });
    m.panel.open();
    m.intake.start();
    await flush();
    await m.send('whenever the fridge echoes');
    let texts = m.panTexts();
    expect(lines('mentor.ai_unavailable')).toContain(texts.at(-2));
    expect(lines('didnt_understand')).toContain(texts.at(-1));
    await m.tap('Saturday');
    await m.tap('Ink it ✔');
    await m.send('a fair few');
    texts = m.panTexts();
    expect(lines('rate_limited')).toContain(texts.at(-2));
    await m.tap('3');
    await m.tap('Ink it ✔');
    expect(m.intake.step).toBe('region');
    await m.send('skip');
    // Signed in without health_data: the consent card; Not now.
    await m.tap('Not now');
    await m.send('skip');
    expect(m.intake.step).toBe('done');
    // Never told to pay.
    expect(m.root.textContent).not.toMatch(/upgrade|subscri|premium|guild/i);
  });

  test('Family Table never starts the intake', async () => {
    const m = setup({ patch: { settings: { showCalories: false, reducedMotion: 'system', familyTable: true, iosNoteDismissed: false, aiMentor: true } } });
    m.intake.start();
    await flush();
    expect(m.intake.step).toBeNull();
    expect(m.root.querySelector('.intake-checklist')).toBeNull();
  });

  test('an emergency mid-intake gets the emergency line, not a parse', async () => {
    const m = setup();
    m.panel.open();
    m.intake.start();
    await flush();
    await m.send("I can't breathe");
    expect(lines('rule.emergency')).toContain(m.panTexts().find((t) => lines('rule.emergency').includes(t)));
    expect(m.intake.step).toBe('market_day');
  });
});

