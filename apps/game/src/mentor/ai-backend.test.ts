import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildProfileCard, buildRuleCard, type TrailEntry, type TurnRequest, type TurnResponse } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { ApiResult, Consents } from '../api/types';
import { content, graph } from '../content';
import { createStore, type PlayerState } from '../state/store';
import { createAiBackend, RETRY_AFTER_MS } from './ai-backend';
import { switchingBackend } from './index';
import { createScriptedBackend } from './backend';
import { createDialogue } from './dialogue';
import { newConversation, type ConversationRef } from './outage';
import type { CardView, PanItem, PanReply, TurnContext } from './reply';
import { createScriptedEngine } from './scripted';

const T0 = new Date('2026-11-10T12:00:00Z');
const ok = <T>(data: T, status = 200): ApiResult<T> => ({ ok: true, status, data });
const fail = (status: number, code = `http_${status}`): ApiResult<never> => ({ ok: false, status, error: { code, message: '' } });

type Handler = (...args: unknown[]) => Promise<ApiResult<unknown>> | ApiResult<unknown>;
function fakeClient(script: Partial<Record<keyof ApiClient, Handler>>) {
  const calls: { name: string; args: unknown[] }[] = [];
  const client = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => {
      calls.push({ name, args });
      const f = script[name as keyof ApiClient];
      return f ? Promise.resolve(f(...args)) : Promise.reject(new Error(`unexpected call: ${name}`));
    },
  }) as ApiClient;
  return { client, calls };
}

const consents = (purposes: ('health_data' | 'ai_health')[]): Consents => ({
  consents: purposes.map((purpose) => ({ purpose, noticeVersion: purpose === 'health_data' ? 'v3' : 'v1', noticeSha256: 'x', method: 'tap', grantedAt: T0.toISOString(), withdrawnAt: null, current: true })),
  needsReconsent: [], notices: {},
} as unknown as Consents);
const BOTH = () => ok(consents(['health_data', 'ai_health']));

const response = (patch: Partial<TurnResponse>): TurnResponse =>
  ({ conversationId: 'c1', route: 'deterministic', parts: [], cards: [], actions: [], notice: null, toolTurn: false, replyId: 'r1', ...patch });
const line = (trigger: string) => ({ kind: 'line' as const, line: { trigger, vars: {} } });
const said = (r: { items: PanItem[] }) => r.items.flatMap((i) => (i.kind === 'said' ? [i.said.trigger] : []));

function setup(script: Partial<Record<keyof ApiClient, Handler>>, patch: Partial<PlayerState> = {}, storage?: Storage, conversation?: ConversationRef) {
  const store = createStore(storage ?? null);
  store.update((s) => ({ ...s, account: { email: 'cook@example.com' }, accountRules: [], ...patch }));
  const dialogue = createDialogue(content.pan);
  const recipes = Object.entries(content.recipes).map(([slug, r]) => ({ slug, title: r.meta.title }));
  const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes, now: () => T0 });
  const { client, calls } = fakeClient(script);
  const events = new EventTarget();
  const backend = createAiBackend({
    client, engine, dialogue, store, graph, ruleTerms: content.ruleTerms, now: () => T0, events,
    screen: () => ({ route: 'kitchen' }), intakeStep: () => null, ...(conversation ? { conversation } : {}),
  });
  const late: PanReply[] = [];
  backend.onLate?.((r) => late.push(r));
  return { backend, calls, store, events, late };
}
const ctx = (patch: Partial<TurnContext> = {}): TurnContext => ({ turn: 1, openCards: [], intakeStep: null, signedIn: true, trail: [], ...patch });
const text = (t: string) => ({ kind: 'text' as const, text: t });
const turns = <T extends { name: string }>(calls: T[]) => calls.filter((c) => c.name === 'mentorTurn');

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('AI backend', () => {
  test('M7 Step 8: a server line or go part becomes an item whose said carries that part\'s index in res.parts; a scripted reply\'s carry none', async () => {
    const parts: TurnResponse['parts'] = [
      { kind: 'text', text: 'model words' },
      line('didnt_understand'),
      { kind: 'go', target: { to: 'plan' }, line: { trigger: 'nav.offer', vars: { place: 'the plan' } } },
    ];
    const { backend } = setup({ consents: BOTH, mentorTurn: () => ok(response({ parts })) });
    const r = await backend.reply(text('hello there'), ctx());
    const tagged = r.items.flatMap((i) => (i.kind === 'said' || i.kind === 'go' ? [[i.said.trigger, i.said.part]] : []));
    expect(tagged).toEqual([['didnt_understand', 1], ['nav.offer', 2]]);
    for (const i of r.items) if (i.kind === 'said' || i.kind === 'go') expect(Number.isInteger(i.said.index)).toBe(true);
    const scripted = setup({ consents: BOTH, mentorTurn: () => ok(response({ route: 'scripted', notice: 'ai_unavailable' })) });
    const s2 = await scripted.backend.reply(text('hello there'), ctx());
    for (const i of s2.items) if (i.kind === 'said' || i.kind === 'go') expect(i.said.part).toBeUndefined();
  });

  test('N2: an emergency text keeps the emergency line first when the server says the AI is unavailable, and when it is unreachable', async () => {
    const EMERGENCY = "my son's lips are swelling, he ate peanuts";
    const viaNotice = setup({ consents: BOTH, mentorTurn: () => ok(response({ route: 'scripted', notice: 'ai_unavailable' })) });
    expect(said(await viaNotice.backend.reply(text(EMERGENCY), ctx())).slice(0, 2)).toEqual(['rule.emergency', 'mentor.ai_unavailable']);
    const viaOutage = setup({ consents: BOTH, mentorTurn: () => fail(503) });
    expect(said(await viaOutage.backend.reply(text(EMERGENCY), ctx())).slice(0, 2)).toEqual(['rule.emergency', 'mentor.ai_unavailable']);
  });

  test('a scripted route runs the engine on the same text, after the notice line', async () => {
    const { backend } = setup({ consents: BOTH, mentorTurn: () => ok(response({ route: 'scripted', notice: 'ai_unavailable' })) });
    const r = await backend.reply(text("I'm allergic to sesame"), ctx());
    expect(said(r)[0]).toBe('mentor.ai_unavailable');
    expect(said(r)).toContain('rule.readback');
    expect(r.cards).toMatchObject([{ origin: 'local', card: { kind: 'rule', severe: true, display: { spelled: 'S-E-S-A-M-E' } } }]);
  });

  test('needs_ai_health: the engine answers with a local severe card, and the ai_health card is offered once', async () => {
    const { backend, store } = setup({ consents: BOTH, mentorTurn: () => ok(response({ route: 'scripted', notice: 'needs_ai_health' })) });
    const r = await backend.reply(text("I'm allergic to sesame"), ctx());
    expect(said(r)[0]).toBe('rule.readback');
    expect(r.cards).toMatchObject([{ origin: 'local', card: { kind: 'rule', severe: true } }]);
    expect(r.items.filter((i) => i.kind === 'consent')).toEqual([{ kind: 'consent', purpose: 'ai_health' }]);
    // The panel marks it offered when the card is on screen (fix round 1, M5); the backend never does.
    expect(store.get().aiHealthOffered).toBe(false);
    store.update((s) => ({ ...s, aiHealthOffered: true }));
    const again = await backend.reply(text("I'm allergic to sesame"), ctx({ turn: 2 }));
    expect(again.items.some((i) => i.kind === 'consent')).toBe(false);
  });

  test('rate_limited and ai_off: their notice line (or none), then the engine', async () => {
    let notice: TurnResponse['notice'] = 'rate_limited';
    const { backend } = setup({ consents: BOTH, mentorTurn: () => ok(response({ route: 'scripted', notice })) });
    expect(said(await backend.reply(text('My market day is Saturday.'), ctx()))).toEqual(['rate_limited', 'profile.readback']);
    notice = 'ai_off';
    expect(said(await backend.reply(text('My market day is Saturday.'), ctx({ turn: 2 })))).toEqual(['profile.readback']);
  });

  test('health text never reaches /mentor/turn without ai_health (the client mirrors the server gate)', async () => {
    const { backend, calls } = setup({ consents: () => ok(consents(['health_data'])) });
    const r = await backend.reply(text("I'm allergic to sesame"), ctx());
    expect(turns(calls)).toEqual([]);
    expect(r.cards).toMatchObject([{ origin: 'local', card: { kind: 'rule' } }]);
    expect(r.items).toContainEqual({ kind: 'consent', purpose: 'ai_health' });
    // A consents call that fails counts as no consent (fail closed).
    const down = setup({ consents: () => fail(0, 'network') });
    await down.backend.reply(text('I had dal for lunch'), ctx());
    expect(turns(down.calls)).toEqual([]);
    // An open rule card makes any turn a health turn.
    const open = buildRuleCard({ term: 'milk', severity: 'intolerance' }, graph, content.ruleTerms);
    if (!open.ok) throw new Error();
    const card: CardView = { origin: 'local', localId: 'L1', card: open.card, issuedTurn: 0 };
    await backend.reply(text('tell me a joke'), ctx({ turn: 2, openCards: [card] }));
    expect(turns(calls)).toEqual([]);
  });

  test('other text is sent with the turn request; a deterministic route maps lines and server cards', async () => {
    const card = buildProfileCard({ marketDays: [6] });
    const { backend, calls } = setup({
      consents: BOTH,
      mentorTurn: () => ok(response({ parts: [{ kind: 'line', line: card.readback[0] }], cards: [{ proposalId: 'P1', expiresAt: '2026-11-10T12:30:00Z', card }] })),
    });
    const r = await backend.reply(text('My market day is Saturday.'), ctx({ turn: 3 }));
    const req = turns(calls)[0].args[0] as TurnRequest;
    expect(req).toEqual({ conversationId: null, input: { kind: 'text', text: 'My market day is Saturday.' }, localDate: '2026-11-10', localTime: expect.stringMatching(/^\d\d:\d\d$/) as string, screen: { route: 'kitchen' }, intakeStep: null, turnKey: expect.stringMatching(/^[0-9a-f-]{36}$/) as string });
    expect(said(r)).toEqual(['profile.readback']);
    expect(r.cards).toEqual([{ origin: 'server', proposalId: 'P1', expiresAt: '2026-11-10T12:30:00Z', card, issuedTurn: 3, conversationId: 'c1' }]);
    expect(backend.conversationId).toBe('c1');
    await backend.reply(text('hello'), ctx({ turn: 4 }));
    expect((turns(calls)[1].args[0] as TurnRequest).conversationId).toBe('c1');
  });

  test('a failed fetch keeps the text in memory only, retries once after 5 s, then offers Try again', async () => {
    const writes: string[] = [];
    const storage = { getItem: () => null, setItem: (_k: string, v: string) => { writes.push(v); }, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as Storage;
    const { backend, calls, late } = setup({ consents: BOTH, mentorTurn: () => fail(503) }, {}, storage);
    const r = await backend.reply(text('My market day is Saturday.'), ctx());
    expect(said(r)).toEqual(['mentor.ai_unavailable', 'profile.readback']);
    expect(turns(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS - 1);
    expect(turns(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(turns(calls)).toHaveLength(2);
    expect(late).toHaveLength(1);
    expect(said(late[0])).toEqual(['ai.try_again']);
    expect(late[0].items).toContainEqual({ kind: 'retry', input: { kind: 'text', text: 'My market day is Saturday.' } });
    // Only once.
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS * 3);
    expect(turns(calls)).toHaveLength(2);
    expect(writes.some((w) => w.includes('Saturday'))).toBe(false);
  });

  test('M7 Step 6 fix round 1 (I2): a failed transcript turn offers Try again with the whole transcript input, never as text', async () => {
    const { backend, calls, late } = setup({ consents: BOTH, mentorTurn: () => fail(503) });
    const input = { kind: 'transcript' as const, text: "I'm allergic to sesame", heard: { words: ['sesame'] } };
    await backend.reply(input, ctx());
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    // The automatic retry resent the transcript unchanged.
    expect(turns(calls).map((c) => (c.args[0] as TurnRequest).input)).toEqual([input, input]);
    expect(late[0].items).toContainEqual({ kind: 'retry', input });
    // An unconfirmed transcript stays one too: its Try again goes back to the server's heard gate.
    const bare = setup({ consents: BOTH, mentorTurn: () => fail(503) });
    await bare.backend.reply({ kind: 'transcript', text: 'got the shallots' }, ctx());
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(bare.late[0].items).toContainEqual({ kind: 'retry', input: { kind: 'transcript', text: 'got the shallots' } });
  });

  test.each([[0, 'network'], [429, 'rate_limited'], [200, 'bad_response']])('status %i (%s) falls back to the script', async (status, code) => {
    const { backend } = setup({ consents: BOTH, mentorTurn: () => fail(status, code) });
    expect(said(await backend.reply(text('tell me a joke'), ctx()))).toEqual(['mentor.ai_unavailable', 'didnt_understand']);
  });

  test('the retry runs on the next online event if that comes first, and is shown only when it adds a server card', async () => {
    let n = 0;
    const card = buildProfileCard({ marketDays: [6] });
    const { backend, calls, late, events } = setup({
      consents: BOTH,
      mentorTurn: () => (++n === 1 ? fail(0, 'network') : ok(response({ parts: [{ kind: 'line', line: card.readback[0] }, { kind: 'text', text: 'model words' }], cards: [{ proposalId: 'P1', expiresAt: '2026-11-10T12:30:00Z', card }] }))),
    });
    await backend.reply(text('tell me about knives'), ctx({ turn: 2 }));
    events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(turns(calls)).toHaveLength(2);
    expect(late).toHaveLength(1);
    expect(late[0].cards).toMatchObject([{ origin: 'server', proposalId: 'P1' }]);
    expect(late[0].items.every((i) => i.kind !== 'said' || i.said.text !== 'model words')).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(turns(calls)).toHaveLength(2);

    // A retry that adds nothing the script didn't is not shown.
    n = 0;
    const quiet = setup({ consents: BOTH, mentorTurn: () => (++n === 1 ? fail(502) : ok(response({ parts: [line('didnt_understand')] }))) });
    await quiet.backend.reply(text('tell me a joke'), ctx());
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(quiet.late).toEqual([]);
  });

  test('401 refreshes the account, then the engine answers', async () => {
    const { backend, calls, store } = setup({ consents: BOTH, mentorTurn: () => fail(401, 'unauthorized'), me: () => fail(401, 'unauthorized') });
    expect(said(await backend.reply(text('My market day is Saturday.'), ctx()))).toEqual(['profile.readback']);
    expect(calls.map((c) => c.name)).toContain('me');
    expect(store.get().account).toBeNull();
  });

  test('undo goes by the newest live trail entry: local → writer, server → /mentor/turn', async () => {
    const { backend, calls } = setup({ consents: BOTH, mentorTurn: () => ok(response({ parts: [line('undo')], actions: [{ kind: 'undone', id: 'P1' }] })) });
    const entry = (id: string, origin: TrailEntry['origin']): TrailEntry => ({ id, origin, kind: 'profile', summary: 's', undoUntil: '2026-11-10T12:05:00Z' });
    const localUndo = await backend.reply(text('undo'), ctx({ trail: [entry('P1', 'server'), entry('L1', 'local')] }));
    expect(localUndo.intents).toEqual([{ kind: 'undo' }]);
    expect(turns(calls)).toEqual([]);
    const serverUndo = await backend.reply(text('undo'), ctx({ trail: [entry('L1', 'local'), entry('P1', 'server')] }));
    expect(turns(calls)).toHaveLength(1);
    expect(serverUndo.actions).toEqual([{ kind: 'undone', id: 'P1' }]);
    expect(said(serverUndo)).toEqual(['undo']);
  });

  test('a strict yes for a local card never reaches the server; with two cards of either origin it asks for a tap', async () => {
    const { backend, calls } = setup({ consents: BOTH, mentorTurn: () => ok(response({})) });
    const card = buildProfileCard({ marketDays: [6] });
    const localCard: CardView = { origin: 'local', localId: 'L1', card, issuedTurn: 1 };
    const serverCard: CardView = { origin: 'server', proposalId: 'P1', expiresAt: '2026-11-10T12:30:00Z', card, issuedTurn: 1 };
    expect((await backend.reply(text('yes'), ctx({ turn: 2, openCards: [localCard] }))).intents).toEqual([{ kind: 'confirm', localId: 'L1' }]);
    const two = await backend.reply(text('yes'), ctx({ turn: 2, openCards: [localCard, serverCard] }));
    expect(two.intents).toEqual([]);
    expect(said(two)).toEqual(['confirm.tap_card']);
    // An older open card counts too.
    const older: CardView = { ...localCard, localId: 'L0', issuedTurn: 0 };
    expect(said(await backend.reply(text('yes'), ctx({ turn: 2, openCards: [older, localCard] })))).toEqual(['confirm.tap_card']);
    expect(turns(calls)).toEqual([]);
    // One server card: the server's own typed-yes path, naming that card (I-1).
    await backend.reply(text('yes'), ctx({ turn: 2, openCards: [serverCard] }));
    expect(turns(calls)).toHaveLength(1);
    expect((turns(calls)[0].args[0] as TurnRequest).answering).toBe('P1');
  });

  test('I-1 scenario A: a yes after a turn the server never saw (a local card, stamped) stays on the device', async () => {
    const { backend, calls } = setup({ consents: () => ok(consents(['health_data'])), mentorTurn: () => ok(response({})) });
    // Turn 1: a server profile card. Turn 2: a health turn answered on the device (no ai_health), its card stamped.
    const serverCard: CardView = { origin: 'server', proposalId: 'P1', expiresAt: '2026-11-10T12:30:00Z', card: buildProfileCard({ marketDays: [6] }), issuedTurn: 1 };
    const r = await backend.reply(text('yes'), ctx({ turn: 3, openCards: [serverCard] }));
    expect(turns(calls)).toEqual([]);
    expect(r.intents).toEqual([]);
    expect(r.actions).toEqual([]);
    // And with no card at all.
    await backend.reply(text('no'), ctx({ turn: 4 }));
    expect(turns(calls)).toEqual([]);
  });

  test('J2: every turn has its own turnKey; the automatic retry sends the same one', async () => {
    let n = 0;
    const { backend, calls } = setup({ consents: BOTH, mentorTurn: () => (++n === 1 ? fail(0, 'network') : ok(response({}))) });
    await backend.reply(text('tell me about knives'), ctx());
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    await backend.reply(text('tell me about pans'), ctx({ turn: 2 }));
    const keys = turns(calls).map((c) => (c.args[0] as TurnRequest).turnKey);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  test('M-3: a scheduled retry of health text checks ai_health again; withdrawn meanwhile, nothing is sent', async () => {
    let both = true;
    const { backend, calls, late } = setup({ consents: () => ok(consents(both ? ['health_data', 'ai_health'] : ['health_data'])), mentorTurn: () => fail(503) });
    await backend.reply(text("I'm allergic to sesame"), ctx());
    expect(turns(calls)).toHaveLength(1);
    both = false;
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(turns(calls)).toHaveLength(1);
    expect(late).toEqual([]);
  });

  test('J1: disposed while the consents are read, a health turn is answered by the script with no ai_health offer', async () => {
    let answer!: (r: ApiResult<unknown>) => void;
    const { backend, calls } = setup({ consents: () => new Promise<ApiResult<unknown>>((r) => { answer = r; }), mentorTurn: () => ok(response({})) });
    const r = backend.reply(text("I'm allergic to sesame"), ctx());
    await vi.advanceTimersByTimeAsync(0);
    backend.dispose!();
    answer(BOTH());
    const out = await r;
    expect(out.items.some((i) => i.kind === 'consent')).toBe(false);
    expect(out.cards).toMatchObject([{ origin: 'local' }]);
    expect(turns(calls)).toHaveLength(0);
  });

  test('a text part from the server is never shown (Ruling R9: only scripted lines and cards)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { backend } = setup({ consents: BOTH, mentorTurn: () => ok(response({ route: 'ai', parts: [{ kind: 'text', text: 'The peanut rule is on file.' }, line('didnt_understand')] })) });
    const r = await backend.reply(text('tell me a joke'), ctx());
    expect(r.items).toHaveLength(1);
    expect(said(r)).toEqual(['didnt_understand']);
    expect(JSON.stringify(r)).not.toContain('peanut rule');
    warn.mockRestore();
  });

  test('M7 Step 6 (P9): a transcript is sent as input.kind transcript, with its heard words only when given; it takes the same health gate as text', async () => {
    const { backend, calls } = setup({ consents: BOTH, mentorTurn: () => ok(response({ parts: [line('didnt_understand')] })) });
    await backend.reply({ kind: 'transcript', text: 'tell me a joke' }, ctx());
    await backend.reply({ kind: 'transcript', text: "I'm allergic to sesame", heard: { words: ['sesame'] } }, ctx({ turn: 2 }));
    await backend.reply(text('hello'), ctx({ turn: 3 }));
    expect(turns(calls).map((c) => (c.args[0] as TurnRequest).input)).toEqual([
      { kind: 'transcript', text: 'tell me a joke' },
      { kind: 'transcript', text: "I'm allergic to sesame", heard: { words: ['sesame'] } },
      { kind: 'text', text: 'hello' },
    ]);
    // Without ai_health a health transcript stays on the device, exactly as typed health text does.
    const without = setup({ consents: () => ok(consents(['health_data'])) });
    const r = await without.backend.reply({ kind: 'transcript', text: "I'm allergic to sesame", heard: { words: ['sesame'] } }, ctx());
    expect(turns(without.calls)).toEqual([]);
    expect(r.items).toContainEqual({ kind: 'consent', purpose: 'ai_health' });
  });

  test('I2: dispose cancels the queued retry; nothing is sent or shown after it', async () => {
    const { backend, calls, late, events } = setup({ consents: BOTH, mentorTurn: () => fail(503) });
    await backend.reply(text('tell me a joke'), ctx());
    backend.dispose?.();
    events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS * 2);
    expect(turns(calls)).toHaveLength(1);
    expect(late).toEqual([]);
  });

  test('I2: switching the backend (AI off) within the retry window sends no second POST /mentor/turn', async () => {
    const store = createStore(null);
    store.update((s) => ({ ...s, account: { email: 'cook@example.com' }, accountRules: [] }));
    const dialogue = createDialogue(content.pan);
    const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes: [], now: () => T0 });
    const { client, calls } = fakeClient({ consents: BOTH, mentorTurn: () => fail(503) });
    const backend = switchingBackend(store, (kind) => (kind === 'ai'
      ? createAiBackend({ client, engine, dialogue, store, graph, ruleTerms: content.ruleTerms, now: () => T0, events: new EventTarget(), screen: () => null, intakeStep: () => null })
      : createScriptedBackend(engine)));
    expect(backend.kind).toBe('ai');
    await backend.reply(text('tell me a joke'), ctx());
    store.update((s) => ({ ...s, settings: { ...s.settings, aiMentor: false } }));
    expect(backend.kind).toBe('scripted');
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS * 2);
    expect(turns(calls)).toHaveLength(1);
  });

  test('M4: a reply of only model text gets didnt_understand, never an empty reply', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { backend } = setup({ consents: BOTH, mentorTurn: () => ok(response({ route: 'ai', parts: [{ kind: 'text', text: 'chat' }] })) });
    expect(said(await backend.reply(text('tell me a joke'), ctx()))).toEqual(['didnt_understand']);
    vi.restoreAllMocks();
  });

  test('M8: a malformed server card is dropped with didnt_understand; good cards and lines stay', async () => {
    const good = buildProfileCard({ marketDays: [6] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = setup({
      consents: BOTH,
      mentorTurn: () => ok(response({
        parts: [{ kind: 'line', line: good.readback[0] }, { kind: 'line', line: { trigger: 'no.such.line', vars: {} } }],
        cards: [
          { proposalId: 'P1', expiresAt: '2026-11-10T12:30:00Z', card: good },
          { proposalId: 'P2', expiresAt: '2026-11-10T12:30:00Z', card: { kind: 'rule', readback: [] } as never },
          { proposalId: 'P3', expiresAt: 'soon', card: good },
        ],
        actions: [{ kind: 'confirmed', proposalId: 'P9' } as never],
      })),
    });
    const r = await backend.reply(text('My market day is Saturday.'), ctx());
    expect(r.cards.map((c) => (c.origin === 'server' ? c.proposalId : ''))).toEqual(['P1']);
    expect(said(r)).toEqual(['profile.readback', 'didnt_understand']);
    expect(r.actions).toEqual([]);
    err.mockRestore();
  });
});

/** A mentorTurn answer the test releases by hand. */
function gate() {
  let open!: (r: ApiResult<unknown>) => void;
  const p = new Promise<ApiResult<unknown>>((r) => { open = r; });
  return { p, open };
}

describe('fix round 4: one queue for every turn', () => {
  const EMERGENCY = 'my throat is closing';

  test('deliver: health text without ai_health is not sent; with it, the turn is sent, its id kept and its reply never shown', async () => {
    const without = setup({ consents: () => ok(consents([])), mentorTurn: () => ok(response({ parts: [line('rule.emergency')] })) });
    without.backend.deliver!(text(EMERGENCY), ctx());
    await vi.advanceTimersByTimeAsync(0);
    expect(turns(without.calls)).toHaveLength(0);

    const withIt = setup({ consents: BOTH, mentorTurn: () => ok(response({ parts: [line('rule.emergency')] })) });
    withIt.backend.deliver!(text(EMERGENCY), ctx());
    await vi.advanceTimersByTimeAsync(0);
    expect(turns(withIt.calls)).toHaveLength(1);
    expect(withIt.backend.conversationId).toBe('c1');
    expect(withIt.late).toEqual([]);
  });

  test('G4: a reply still on its way when the conversation is cleared does not bring the old id back', async () => {
    const g = gate();
    const conversation: ConversationRef = { id: null };
    const { backend } = setup({ consents: BOTH, mentorTurn: () => g.p }, {}, undefined, conversation);
    const r = backend.reply(text('hello'), ctx());
    await vi.advanceTimersByTimeAsync(0);
    newConversation(conversation);
    g.open(ok(response({ conversationId: 'c1' })));
    await r;
    expect(conversation.id).toBeNull();
  });

  test('G5: a turn still waiting its place when the backend is disposed is answered by the script and never sent', async () => {
    const g = gate();
    const { backend, calls } = setup({ consents: BOTH, mentorTurn: () => g.p });
    const first = backend.reply(text('hello'), ctx());
    const second = backend.reply(text('My market day is Saturday.'), ctx());
    backend.deliver!(text(EMERGENCY), ctx());
    await vi.advanceTimersByTimeAsync(0);
    backend.dispose!();
    g.open(ok(response({})));
    await first;
    expect((await second).items.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(turns(calls)).toHaveLength(1);
  });

  test('G3: the one retry waits for a turn already on its way and goes in that turn\'s conversation', async () => {
    const g = gate();
    let n = 0;
    const { backend, calls } = setup({ consents: BOTH, mentorTurn: () => (++n === 1 ? fail(503) : n === 2 ? g.p : ok(response({}))) });
    await backend.reply(text('My market day is Saturday.'), ctx());
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS - 1);
    const next = backend.reply(text('hello'), ctx());
    await vi.advanceTimersByTimeAsync(1); // the retry is due now, but "hello" is still on its way
    expect(turns(calls)).toHaveLength(2);
    g.open(ok(response({ conversationId: 'c7' })));
    await next;
    await vi.advanceTimersByTimeAsync(0);
    const sent = turns(calls).map((c) => c.args[0] as TurnRequest);
    expect(sent.map((r) => r.input.text)).toEqual(['My market day is Saturday.', 'hello', 'My market day is Saturday.']);
    expect(sent[2].conversationId).toBe('c7');
  });
});

describe('fix round 5', () => {
  test('H1: dispose lets go of a hung turn; every turn behind it is answered by the script at once and nothing more is sent', async () => {
    const hung = new Promise<ApiResult<unknown>>(() => {});
    const { backend, calls } = setup({ consents: BOTH, mentorTurn: () => hung });
    const first = backend.reply(text('hello'), ctx());
    const second = backend.reply(text("I'm allergic to sesame"), ctx());
    backend.deliver!(text('my throat is closing'), ctx());
    await vi.advanceTimersByTimeAsync(0);
    backend.dispose!();
    const [a, b] = await Promise.all([first, second]);
    expect(a.items.length).toBeGreaterThan(0);
    expect(b.cards).toMatchObject([{ origin: 'local', card: { kind: 'rule' } }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(turns(calls)).toHaveLength(1);
  });

  test('H1: a consents read that hangs is let go by dispose too', async () => {
    const { backend, calls } = setup({ consents: () => new Promise<ApiResult<unknown>>(() => {}), mentorTurn: () => ok(response({})) });
    const r = backend.reply(text("I'm allergic to sesame"), ctx());
    await vi.advanceTimersByTimeAsync(0);
    backend.dispose!();
    expect((await r).cards).toMatchObject([{ origin: 'local' }]);
    expect(turns(calls)).toHaveLength(0);
  });

  test('H3: a retry scheduled before a clear is dropped: never sent, never shown', async () => {
    const conversation: ConversationRef = { id: null };
    let n = 0;
    const { backend, calls, events, late } = setup({ consents: BOTH, mentorTurn: () => (++n === 1 ? fail(0, 'network') : ok(response({ conversationId: 'c3' }))) }, {}, undefined, conversation);
    await backend.reply(text('My market day is Saturday.'), ctx());
    newConversation(conversation);
    events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS * 2);
    expect(turns(calls)).toHaveLength(1);
    expect(conversation.id).toBeNull();
    expect(late).toEqual([]);
  });

  test('H3: a retry already on its way when the conversation is cleared shows nothing when it lands', async () => {
    const conversation: ConversationRef = { id: null };
    const g = gate();
    let n = 0;
    const { backend, late } = setup({ consents: BOTH, mentorTurn: () => (++n === 1 ? fail(503) : g.p) }, {}, undefined, conversation);
    await backend.reply(text('My market day is Saturday.'), ctx());
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    newConversation(conversation);
    g.open(fail(503)); // would show "Try again" in the old conversation
    await vi.advanceTimersByTimeAsync(0);
    expect(late).toEqual([]);
  });
});

test('H1: a 401 whose account refresh hangs is let go by dispose; the script answers', async () => {
  const { backend } = setup({ consents: BOTH, mentorTurn: () => fail(401), me: () => new Promise<ApiResult<unknown>>(() => {}) });
  const r = backend.reply(text('hello'), ctx());
  await vi.advanceTimersByTimeAsync(0);
  backend.dispose!();
  expect((await r).items.length).toBeGreaterThan(0);
});
