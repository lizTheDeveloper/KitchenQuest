// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildMealCard, buildPantryCard, buildProfileCard, buildRuleCard, UNDO_WINDOW_MS, type ProposalCard, type TrailEntry } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { RULES_INVALID_MESSAGE } from '../recipes/rules';
import { createStore, type PlayerState } from '../state/store';
import type { MentorBackend } from './backend';
import { CLOSED_TEXT } from './cards-view';
import { createDialogue } from './dialogue';
import { DEVICE_ONLY_FOOTNOTE, MAX_BUBBLES, mountMentorPanel, NOT_SAVED_TEXT, REJECT_FAILED_TEXT, THINKING_TEXT, type MentorMode } from './panel';
import type { CardView, PanItem, PanReply, TurnContext } from './reply';
import { createScriptedEngine } from './scripted';
import type { CardWriter, UndoOutcome, WriteOutcome } from './writer';

const T0 = new Date('2026-11-10T12:00:00Z');
const reply = (texts: string[], extra: Partial<PanReply> = {}): PanReply => ({
  items: texts.map((t) => ({ kind: 'said', said: { trigger: 'x', text: t, ai: 'allowed' } })), cards: [], intents: [], actions: [], notice: null, ...extra,
});
const dialogue = createDialogue(content.pan);
const recipes = Object.entries(content.recipes).map(([slug, r]) => ({ slug, title: r.meta.title }));
const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes, now: () => T0 });
const say = (trigger: string, vars: Record<string, string> = {}): PanItem => ({ kind: 'said', said: dialogue.say(trigger, vars) });
const trailFor = (card: ProposalCard, id = 'w1', origin: TrailEntry['origin'] = 'local'): TrailEntry =>
  ({ id, origin, kind: card.kind, summary: card.kind === 'rule' ? card.display.ingredient : card.summary, undoUntil: new Date(T0.getTime() + UNDO_WINDOW_MS).toISOString() });
const local = (card: ProposalCard, localId = 'L1', issuedTurn = 1): CardView => ({ origin: 'local', localId, card, issuedTurn });
const rule = (term: string, severity: 'allergy' | 'intolerance' | null) => {
  const r = buildRuleCard({ term, severity }, graph, content.ruleTerms);
  if (!r.ok) throw new Error(term);
  return r.card;
};

function fakeWriter(over: Partial<CardWriter> = {}): CardWriter & { confirm: ReturnType<typeof vi.fn>; undo: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn> } {
  return {
    confirm: vi.fn((v: CardView): Promise<WriteOutcome> => Promise.resolve({ ok: true, trail: trailFor(v.card), items: [say('schedule.set', { summary: 's' })] })),
    reject: vi.fn((): Promise<PanItem[]> => Promise.resolve([say('card.rejected')])),
    undo: vi.fn((): Promise<UndoOutcome> => Promise.resolve({ status: 'undone', items: [say('undo')] })),
    ...over,
  } as never;
}
const client = {
  consents: vi.fn(() => Promise.resolve({ ok: true, status: 200, data: { consents: [], needsReconsent: [], notices: { ai_health: { version: 'v1', text: 'The AI notice text.' } } } })),
  grantConsent: vi.fn(() => Promise.resolve({ ok: true, status: 201, data: { consent: {} } })),
} as unknown as ApiClient;

function mount(opts: { mode?: MentorMode; backend?: MentorBackend; writer?: CardWriter; patch?: Partial<PlayerState>; now?: () => Date; disclosure?: string } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const store = createStore(null);
  store.update((s) => ({ ...s, ...opts.patch }));
  const writer = opts.writer ?? fakeWriter();
  const backend = opts.backend ?? { kind: 'scripted', reply: () => Promise.resolve(reply(['x'])) };
  const pan = mountMentorPanel(root, {
    mode: opts.mode ?? 'standard', backend, dialogue, writer, engine, client, forms: content.bureau.forms, store,
    reducedMotion: () => true, now: opts.now ?? (() => T0), ...(opts.disclosure === undefined ? {} : { disclosure: opts.disclosure }),
  });
  const send = async (text: string) => {
    root.querySelector<HTMLTextAreaElement>('#pan-text')!.value = text;
    root.querySelector('form')!.requestSubmit();
    await flush();
  };
  return { root, pan, store, writer, send };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const panTexts = (root: HTMLElement) => [...root.querySelectorAll('.bubble.pan')].map((b) => b.textContent);
const button = (el: Element, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name);
const lines = (id: string) => content.pan.triggers[id].lines;

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
beforeEach(() => { vi.clearAllMocks(); });

test('family table refuses a non-scripted backend before touching the DOM', () => {
  const root = new Proxy({}, { get() { throw new Error('touched'); } }) as unknown as HTMLElement;
  const backend: MentorBackend = { kind: 'ai', reply: () => Promise.resolve(reply(['x'])) };
  expect(() => mountMentorPanel(root, {
    mode: 'familyTable', backend, dialogue, writer: fakeWriter(), engine, client, forms: content.bureau.forms, store: createStore(null), reducedMotion: () => true, now: () => T0,
  })).toThrow('Family Table mode requires the scripted backend');
});

test('the panel keeps only the last 50 bubbles', () => {
  const { root, pan } = mount({ mode: 'familyTable' });
  expect(MAX_BUBBLES).toBe(50);
  for (let i = 0; i < 60; i++) pan.say('thanks');
  expect(root.querySelectorAll('.bubble').length).toBe(50);
});

test('a sent message gets the turn context; items render in order, then the cards', async () => {
  const seen: TurnContext[] = [];
  const card = local(buildProfileCard({ marketDays: [6] }));
  const backend: MentorBackend = { kind: 'scripted', reply: (_i, ctx) => { seen.push(ctx); return Promise.resolve(reply(['one', 'two'], { cards: seen.length === 1 ? [card] : [] })); } };
  const { root, pan, send, store } = mount({ backend });
  await send('hello');
  store.update((s) => ({ ...s, account: { email: 'a@b.c' } }));
  await send('again');
  expect(seen[0]).toEqual({ turn: 1, openCards: [], intakeStep: null, signedIn: false, trail: [] });
  expect(seen[1]).toEqual({ turn: 2, openCards: [card], intakeStep: null, signedIn: true, trail: [] });
  expect(pan.turn).toBe(2);
  const kinds = [...root.querySelectorAll('.bubbles > li')].map((li) => (li.classList.contains('bubble') ? li.textContent : 'card'));
  expect(kinds).toEqual(['hello', 'one', 'two', 'card', 'again', 'one', 'two']);
});

test('while a turn is pending: aria-busy, a polite "thinking" status, and Send disabled', async () => {
  let done!: (r: PanReply) => void;
  const backend: MentorBackend = { kind: 'scripted', reply: () => new Promise((r) => { done = r; }) };
  const { root, send } = mount({ backend });
  await send('hello');
  const bubbles = root.querySelector('.bubbles')!;
  expect(bubbles.getAttribute('aria-busy')).toBe('true');
  expect(root.querySelector('[role="status"].pan-status')!.textContent).toBe(THINKING_TEXT);
  expect(button(root, 'Send')!.disabled).toBe(true);
  done(reply(['hi']));
  await flush();
  expect(bubbles.hasAttribute('aria-busy')).toBe(false);
  expect(button(root, 'Send')!.disabled).toBe(false);
});

describe('cards', () => {
  test('a tap confirms; success replaces the card with its trail entry', async () => {
    const view = local(buildProfileCard({ marketDays: [6] }));
    const { root, pan, writer } = mount();
    pan.show(reply([], { cards: [view] }));
    button(root, 'Ink it ✔')!.click();
    button(root, 'Ink it ✔')?.click();
    await flush();
    expect(writer.confirm).toHaveBeenCalledTimes(1);
    expect(writer.confirm).toHaveBeenCalledWith(view, 'tap', undefined);
    expect(root.querySelector('.pan-card')).toBeNull();
    expect(root.querySelector('.trail-text')!.textContent).toBe('🗓 Inked: market day Saturday');
  });

  test('a severe read-back ending "Is that right?" is followed by rule.tap_needed', () => {
    const card = rule('sesame', 'allergy');
    const readback = dialogue.say('rule.readback', card.display);
    const asking = { ...readback, text: 'Reading it back: sesame. S-E-S-A-M-E. an allergy. Is that right?' };
    const { root, pan } = mount();
    pan.show({ items: [{ kind: 'said', said: asking }], cards: [local(card)], intents: [], actions: [], notice: null });
    const texts = panTexts(root);
    expect(texts).toHaveLength(2);
    expect(lines('rule.tap_needed').map((l) => l.replace('{ingredient}', 'sesame'))).toContain(texts[1]);
  });

  test('intake.allergies.followup only after a confirmed rule write', async () => {
    const view = local(rule('milk', 'intolerance'));
    let ok = false;
    const writer = fakeWriter({
      confirm: vi.fn((v: CardView) => Promise.resolve(ok
        ? { ok: true as const, trail: trailFor(v.card), items: [] }
        : { ok: false as const, reason: 'network' as const, items: [] })),
    });
    const { root, pan } = mount({ writer, patch: { intake: { step: 'allergies' } } });
    pan.show(reply([], { cards: [view] }));
    button(root, 'Stamp it ✔')!.click();
    await flush();
    const follow = lines('intake.allergies.followup');
    expect(panTexts(root).some((t) => follow.includes(t))).toBe(false);
    ok = true;
    button(root, 'Stamp it ✔')!.click();
    await flush();
    expect(follow).toContain(panTexts(root).at(-1));
  });

  test('a write that fails on the network says so, and the card stays open to try again', async () => {
    const writer = fakeWriter({ confirm: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'network' as const, items: [] })) });
    const { root, pan } = mount({ writer });
    pan.show(reply([], { cards: [local(buildProfileCard({ marketDays: [6] }))] }));
    button(root, 'Ink it ✔')!.click();
    await flush();
    expect(lines('write.not_done')).toContain(panTexts(root).at(-1));
    expect(root.querySelector('.pan-card-note')!.textContent).toBe(NOT_SAVED_TEXT);
    expect(button(root, 'Ink it ✔')!.disabled).toBe(false);
  });

  test('a closed card says so and is closed; rules_error shows the invalid-rules message and the #/rules link', async () => {
    let out: WriteOutcome = { ok: false, reason: 'closed', items: [] };
    const writer = fakeWriter({ confirm: vi.fn(() => Promise.resolve(out)) });
    const { root, pan } = mount({ writer });
    pan.show(reply([], { cards: [local(buildProfileCard({ marketDays: [6] }))] }));
    button(root, 'Ink it ✔')!.click();
    await flush();
    expect(lines('write.not_done')).toContain(panTexts(root).at(-1));
    expect(root.querySelector('.pan-card-note')!.textContent).toBe(CLOSED_TEXT);
    expect(button(root, 'Ink it ✔')!.disabled).toBe(true);
    out = { ok: false, reason: 'invalid', items: [{ kind: 'rules_error', message: RULES_INVALID_MESSAGE, href: '#/rules' }] };
    pan.show(reply([], { cards: [local(rule('milk', 'intolerance'), 'L2')] }));
    button(root, 'Stamp it ✔')!.click();
    await flush();
    const note = root.querySelector('.pan-rules-error')!;
    expect(note.textContent).toContain(RULES_INVALID_MESSAGE);
    expect(note.querySelector('a')!.getAttribute('href')).toBe('#/rules');
  });

  test('a typed yes intent confirms its local card through the writer as typed_yes', async () => {
    const view = local(buildProfileCard({ marketDays: [6] }));
    const { pan, writer } = mount();
    pan.show(reply([], { cards: [view] }));
    pan.show(reply([], { intents: [{ kind: 'confirm', localId: 'L1' }] }));
    await flush();
    expect(writer.confirm).toHaveBeenCalledWith(view, 'typed_yes', undefined);
  });

  test('choices render as buttons, and a tap builds the local rule card', () => {
    const { root, pan } = mount();
    pan.show({ items: [{ kind: 'choices', options: [{ id: 'sesame', name: 'sesame' }], severity: 'allergy' }], cards: [], intents: [], actions: [], notice: null });
    button(root, 'sesame')!.click();
    expect(root.querySelector('.pan-card')!.textContent).toContain('S-E-S-A-M-E');
  });

  test('a server confirmed action turns its card into the trail entry', async () => {
    const card = buildProfileCard({ marketDays: [6] });
    const { root, pan } = mount();
    pan.show(reply([], { cards: [{ origin: 'server', proposalId: 'P1', expiresAt: '2026-11-10T12:30:00Z', card, issuedTurn: 1 }] }));
    pan.show(reply([], { actions: [{ kind: 'confirmed', proposalId: 'P1', trail: trailFor(card, 'P1', 'server') }] }));
    await flush();
    expect(root.querySelector('.pan-card')).toBeNull();
    expect(root.querySelector('.trail-entry')).not.toBeNull();
  });
});

describe('trail', () => {
  async function stamped(writer: CardWriter, card: ProposalCard = buildMealCard({ eatenOn: '2026-11-10', slot: 'lunch', description: 'dal' })) {
    const m = mount({ writer, patch: { account: { email: 'a@b.c' } } });
    m.pan.show(reply([], { cards: [local(card)] }));
    button(m.root, content.bureau.forms[card.kind === 'meal' ? 'meal_log' : card.kind === 'pantry' ? 'pantry' : 'profile'].buttons.confirm)!.click();
    await flush();
    return m;
  }

  test('trail Edit on a meal undoes it and re-shows the card', async () => {
    const writer = fakeWriter();
    const { root } = await stamped(writer);
    button(root, 'Edit')!.click();
    await flush();
    expect(writer.undo).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.trail-entry')).toBeNull();
    const card = root.querySelector('.pan-card')!;
    expect(card.textContent).toContain('2-L');
    expect(card.textContent).toContain('dal, lunch');
  });

  test('Undo with undone:false keeps the entry for pantry.undo_full, drops it for undo.nothing', async () => {
    let out: UndoOutcome = { status: 'full', items: [say('pantry.undo_full')] };
    const writer = fakeWriter({ undo: vi.fn(() => Promise.resolve(out)) });
    const { root } = await stamped(writer, buildPantryCard({ add: ['rice'], remove: [] }, graph));
    button(root, 'Undo')!.click();
    await flush();
    expect(root.querySelector('.trail-entry')).not.toBeNull();
    expect(lines('pantry.undo_full')).toContain(panTexts(root).at(-1));
    out = { status: 'nothing', items: [say('undo.nothing')] };
    button(root, 'Undo')!.click();
    await flush();
    expect(root.querySelector('.trail-entry')).toBeNull();
  });

  test('a typed undo goes to the newest live entry; with none, undo.nothing', async () => {
    const writer = fakeWriter();
    const { root, pan } = await stamped(writer);
    pan.show(reply([], { intents: [{ kind: 'undo' }] }));
    await flush();
    expect(writer.undo).toHaveBeenCalledTimes(1);
    pan.show(reply([], { intents: [{ kind: 'undo' }] }));
    await flush();
    expect(lines('undo.nothing')).toContain(panTexts(root).at(-1));
  });
});

describe('items', () => {
  test('a consent item shows the notice from /me/consents; agree grants it under that version', async () => {
    const { root, pan } = mount({ patch: { account: { email: 'a@b.c' } } });
    pan.show({ items: [{ kind: 'consent', purpose: 'ai_health' }], cards: [], intents: [], actions: [], notice: null });
    await flush();
    expect(root.querySelector('.consent-notice')!.textContent).toBe('The AI notice text.');
    button(root, 'I agree')!.click();
    await flush();
    expect(client.grantConsent).toHaveBeenCalledWith('ai_health', 'v1');
    expect(root.querySelector('.consent-card')).toBeNull();
  });

  test('a retry item offers Try again, which sends the same text', async () => {
    const texts: string[] = [];
    const backend: MentorBackend = { kind: 'scripted', reply: (i) => { if (i.kind === 'text') texts.push(i.text); return Promise.resolve(reply(['ok'])); } };
    const { root, pan } = mount({ backend });
    pan.show({ items: [{ kind: 'retry', text: 'my market day is Saturday' }], cards: [], intents: [], actions: [], notice: null });
    button(root, 'Try again')!.click();
    await flush();
    expect(texts).toEqual(['my market day is Saturday']);
    expect(button(root, 'Try again')).toBeUndefined();
  });

  test('a late reply from the backend is shown', () => {
    let late!: (r: PanReply) => void;
    const backend: MentorBackend = { kind: 'scripted', reply: () => Promise.resolve(reply([])), onLate: (fn) => { late = fn; return () => {}; } };
    const { root } = mount({ backend });
    late(reply([], { cards: [local(buildProfileCard({ marketDays: [6] }))] }));
    expect(root.querySelector('.pan-card')).not.toBeNull();
  });
});

describe('family table', () => {
  const card = local(buildProfileCard({ marketDays: [6] }));
  test('family table: no text box; show() with a card throws in dev', () => {
    const { root, pan } = mount({ mode: 'familyTable' });
    expect(root.querySelector('textarea, form, #pan-talk')).toBeNull();
    expect(() => pan.show({ items: [], cards: [card], intents: [], actions: [], notice: null })).toThrow(/Family Table/);
  });

  test('family table: with the production flag, show() drops the cards and renders the lines', () => {
    vi.stubEnv('PROD', true);
    const { root, pan } = mount({ mode: 'familyTable' });
    pan.show(reply(['hello there'], { cards: [card], items: [...reply(['hello there']).items, { kind: 'consent', purpose: 'health_data' }, { kind: 'choices', options: [{ id: 'a', name: 'A' }], severity: null }] }));
    expect(panTexts(root)).toEqual(['hello there']);
    expect(root.querySelector('.pan-card, .pan-consent-item, .pan-choices')).toBeNull();
  });
});

describe('Step 11 hooks', () => {
  const C16 = content.bureau.disclaimers.ai_characters;

  test('the AI disclosure shows once, on the first open in standard mode, and Got it sets the flag', () => {
    const { root, pan, store } = mount({ disclosure: C16 });
    expect(root.querySelector('.pan-disclosure')).toBeNull();
    pan.open();
    const note = root.querySelector('.pan-disclosure')!;
    expect(note.querySelector('[data-content]')!.textContent).toBe(C16);
    pan.close();
    pan.open();
    expect(root.querySelectorAll('.pan-disclosure')).toHaveLength(1);
    button(note, 'Got it')!.click();
    expect(store.get().aiDisclosureSeen).toBe(true);
    expect(button(note, 'Got it')).toBeUndefined();
    // Not a Pan line: the bubble count is untouched.
    expect(panTexts(root)).toEqual([]);
    const seen = mount({ disclosure: C16, patch: { aiDisclosureSeen: true } });
    seen.pan.open();
    expect(seen.root.querySelector('.pan-disclosure')).toBeNull();
    const ft = mount({ disclosure: C16, mode: 'familyTable' });
    ft.pan.open();
    expect(ft.root.querySelector('.pan-disclosure')).toBeNull();
  });

  test('onOpen listeners run on each open; interceptText answers first and null falls through', async () => {
    const backend: MentorBackend = { kind: 'scripted', reply: vi.fn(() => Promise.resolve(reply(['from the backend']))) };
    const { root, pan, send } = mount({ backend });
    const opened = vi.fn();
    pan.onOpen(opened);
    pan.open();
    expect(opened).toHaveBeenCalledTimes(1);
    pan.interceptText((text) => (text === 'mine' ? Promise.resolve(reply(['from the intake'])) : null));
    await send('mine');
    await send('other');
    expect(panTexts(root)).toEqual(['from the intake', 'from the backend']);
    expect(backend.reply).toHaveBeenCalledTimes(1);
    expect(pan.turn).toBe(2);
  });

  test('onCardDone hears stamps and turn-downs; setAside shows and removes an element', async () => {
    const { root, pan } = mount();
    const done = vi.fn();
    pan.onCardDone(done);
    const a = local(buildProfileCard({ marketDays: [6] }), 'A');
    const b = local(buildProfileCard({ mealsPerWeek: 3 }), 'B');
    pan.show(reply([], { cards: [a, b] }));
    button(root.querySelectorAll('.pan-card')[0], 'Ink it ✔')!.click();
    await flush();
    button(root.querySelector('.pan-card')!, 'Leave in pencil')!.click();
    await flush();
    expect(done.mock.calls).toEqual([[a, 'confirmed'], [b, 'rejected']]);
    const aside = document.createElement('p');
    aside.textContent = 'checklist';
    pan.setAside(aside);
    expect(root.querySelector('.pan-aside')!.textContent).toBe('checklist');
    pan.setAside(null);
    expect(root.querySelector<HTMLElement>('.pan-aside')!.hidden).toBe(true);
  });

  test('a signed-out local rule card says it is kept on this device only; signed in it does not', () => {
    const card = local(rule('sesame', 'allergy'));
    const out = mount();
    out.pan.show(reply([], { cards: [card] }));
    expect(out.root.querySelector('.pan-card')!.textContent).toContain(DEVICE_ONLY_FOOTNOTE);
    const inn = mount({ patch: { account: { email: 'a@b.c' } } });
    inn.pan.show(reply([], { cards: [card] }));
    expect(inn.root.querySelector('.pan-card')!.textContent).not.toContain(DEVICE_ONLY_FOOTNOTE);
  });

  test('quick answers: a tap is a turn, shown as the player\'s words; consent onAnswer hears Not now', async () => {
    const { root, pan } = mount();
    const onPick = vi.fn(() => Promise.resolve(reply(['picked'])));
    pan.show({ items: [{ kind: 'quick', label: 'Quick answers', options: [{ label: 'Saturday', value: 'saturday' }, { label: 'Skip', value: 'skip' }], onPick }], cards: [], intents: [], actions: [], notice: null });
    button(root, 'Saturday')!.click();
    button(root, 'Skip')!.click();
    await flush();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('saturday', expect.objectContaining({ turn: 1 }));
    expect([...root.querySelectorAll('.bubble.you')].map((b) => b.textContent)).toEqual(['Saturday']);
    expect(panTexts(root)).toEqual(['picked']);
    const onAnswer = vi.fn();
    pan.show({ items: [{ kind: 'consent', purpose: 'ai_health', onAnswer }], cards: [], intents: [], actions: [], notice: null });
    await flush();
    button(root.querySelector('.consent-card')!, 'Not now')!.click();
    expect(onAnswer).toHaveBeenCalledWith(false);
  });
});

describe('fix round 1', () => {
  test('I1: a typed yes while the tap is in flight is ignored; the tap writes once and leaves its trail entry', async () => {
    let finish!: (o: WriteOutcome) => void;
    const view = local(buildProfileCard({ marketDays: [6] }));
    const writer = fakeWriter({ confirm: vi.fn(() => new Promise<WriteOutcome>((r) => { finish = r; })) });
    const { root, pan } = mount({ writer });
    pan.show(reply([], { cards: [view] }));
    button(root, 'Ink it ✔')!.click();
    pan.show(reply([], { intents: [{ kind: 'confirm', localId: 'L1' }] }));
    await flush();
    expect(writer.confirm).toHaveBeenCalledTimes(1);
    finish({ ok: true, trail: trailFor(view.card), items: [] });
    await flush();
    expect(root.querySelector('.pan-card-note')).toBeNull();
    expect(root.querySelector('.trail-entry')).not.toBeNull();
    expect(button(root, 'Undo')).toBeDefined();
  });

  test('I1: a busy outcome from the writer shows nothing', async () => {
    const writer = fakeWriter({ confirm: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'busy' as const, items: [] })) });
    const { root, pan } = mount({ writer });
    pan.show(reply([], { cards: [local(buildProfileCard({ marketDays: [6] }))] }));
    const before = panTexts(root).length;
    button(root, 'Ink it ✔')!.click();
    await flush();
    expect(panTexts(root)).toHaveLength(before);
    expect(root.querySelector('.pan-card.is-closed, .pan-card-note')).toBeNull();
  });

  test('M3: after a stamp, focus is on the trail entry text', async () => {
    const { root, pan } = mount();
    pan.show(reply([], { cards: [local(buildProfileCard({ marketDays: [6] }))] }));
    button(root, 'Ink it ✔')!.focus();
    button(root, 'Ink it ✔')!.click();
    await flush();
    expect(document.activeElement).toBe(root.querySelector('.trail-text'));
  });

  test('M7: a turn-down that fails says the card is still open, not "not saved"', async () => {
    const writer = fakeWriter({ reject: vi.fn(() => Promise.resolve([])) });
    const { root, pan } = mount({ writer });
    pan.show(reply([], { cards: [local(buildProfileCard({ marketDays: [6] }))] }));
    button(root, 'Leave in pencil')!.click();
    await flush();
    expect(root.querySelector('.pan-card-note')!.textContent).toBe(REJECT_FAILED_TEXT);
  });

  test('M5: aiHealthOffered is set when the ai_health card is on screen, not before', async () => {
    const { pan, store } = mount({ patch: { account: { email: 'a@b.c' } } });
    expect(store.get().aiHealthOffered).toBe(false);
    pan.show({ items: [{ kind: 'consent', purpose: 'ai_health' }], cards: [], intents: [], actions: [], notice: null });
    await flush();
    expect(store.get().aiHealthOffered).toBe(true);
  });

  test('M8: a card that cannot be drawn is dropped with didnt_understand, never a thrown render', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { root, pan } = mount();
    const bad = { ...rule('milk', 'intolerance'), form: 'rule_bogus' } as unknown as ProposalCard;
    expect(() => pan.show(reply([], { cards: [local(bad)] }))).not.toThrow();
    expect(root.querySelector('.pan-card')).toBeNull();
    expect(lines('didnt_understand')).toContain(panTexts(root).at(-1));
    err.mockRestore();
  });

  test('destroy takes the panel out and drops its listeners', () => {
    const { root, pan } = mount();
    pan.destroy();
    expect(root.querySelector('#pan-panel')).toBeNull();
  });
});
