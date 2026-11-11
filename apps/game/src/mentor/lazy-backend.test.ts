// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { content, graph } from '../content';
import { createScriptedBackend, type MentorBackend } from './backend';
import { createDialogue } from './dialogue';
import { lazyBackend } from './lazy-backend';
import { localSafetyReply, scriptedWhenUnavailable, withNotice } from './outage';
import type { PanItem, PanReply, TurnContext } from './reply';
import { createScriptedEngine } from './scripted';

const dialogue = createDialogue(content.pan);
const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes: [], now: () => new Date('2026-11-10T12:00:00Z') });
const ctx: TurnContext = { turn: 1, openCards: [], intakeStep: null, signedIn: true, trail: [] };
// The shipped pieces, not copies.
const fallback = scriptedWhenUnavailable(engine, dialogue);
const local = localSafetyReply(engine);
const reply = (t: string): PanReply => ({ items: [{ kind: 'said', said: { trigger: t, text: t, ai: 'allowed' } }], cards: [], intents: [], actions: [], notice: null });
const triggers = (r: PanReply) => r.items.flatMap((i) => (i.kind === 'said' ? [i.said.trigger] : []));
const EMERGENCY = "my son's lips are swelling, he ate peanuts";
const hello = { kind: 'text' as const, text: 'hello' };
const emergency = { kind: 'text' as const, text: EMERGENCY };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('scriptedWhenUnavailable (the shipped fallback)', () => {
  test('answers from the script: the engine reply is kept, never dropped (C1)', async () => {
    const r = await fallback({ kind: 'text', text: "I'm allergic to sesame" }, ctx);
    expect(triggers(r)[0]).toBe('mentor.ai_unavailable');
    expect(triggers(r)).toContain('rule.readback');
    expect(r.cards.length).toBeGreaterThan(0);
  });

  test('N2: an emergency text gets the emergency line first, then the notice', async () => {
    const t = triggers(await fallback(emergency, ctx));
    expect(t[0]).toBe('rule.emergency');
    expect(t[1]).toBe('mentor.ai_unavailable');
  });

  test('voice gets the script alone', async () => {
    expect(triggers(await fallback({ kind: 'voice' }, ctx))).toEqual(['voice.not_yet']);
  });
});

describe('withNotice', () => {
  const notice: PanItem = { kind: 'said', said: { trigger: 'n', text: 'n', ai: 'never' } };
  test('goes first, except after an emergency, medical or child line', () => {
    expect(triggers(withNotice(notice, reply('x')))).toEqual(['n', 'x']);
    for (const lead of ['rule.emergency', 'rule.medical_deflect', 'child.grownup']) {
      expect(triggers(withNotice(notice, reply(lead)))).toEqual([lead, 'n']);
    }
  });
});

describe('lazyBackend', () => {
  test('a failed load answers from the script', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = lazyBackend('ai', { fallback }, () => Promise.reject(new Error('chunk gone')));
    const t = triggers(await b.reply(hello, ctx));
    expect(t[0]).toBe('mentor.ai_unavailable');
  });

  test('N2/N3: emergency, medical and child text is answered from the script without loading the code at all', async () => {
    const load = vi.fn(() => new Promise<MentorBackend>(() => {}));
    const b = lazyBackend('ai', { fallback, local }, load);
    expect(triggers(await b.reply(emergency, ctx))[0]).toBe('rule.emergency');
    expect(triggers(await b.reply({ kind: 'text', text: 'should I take antibiotics for my rash' }, ctx)).length).toBeGreaterThan(0);
    expect(load).not.toHaveBeenCalled();
  });

  test('N3: a load that never settles stops waiting after the timeout and the script answers; the next turn waits on the same load', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let done!: (b: MentorBackend) => void;
    const load = vi.fn(() => new Promise<MentorBackend>((r) => { done = r; }));
    const b = lazyBackend('ai', { fallback, timeoutMs: 8000 }, load);
    const first = b.reply(hello, ctx);
    await vi.advanceTimersByTimeAsync(8000);
    expect(triggers(await first)[0]).toBe('mentor.ai_unavailable');
    done({ kind: 'ai', reply: () => Promise.resolve(reply('ai')) });
    expect(triggers(await b.reply(hello, ctx))).toEqual(['ai']);
    expect(load).toHaveBeenCalledOnce();
  });

  test('the load is tried again on the next turn after a failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    const real: MentorBackend = { kind: 'ai', reply: () => Promise.resolve(reply('ai')) };
    const b = lazyBackend('ai', { fallback }, () => (++n === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(real)));
    await b.reply(hello, ctx);
    expect(triggers(await b.reply(hello, ctx))).toEqual(['ai']);
    expect(n).toBe(2);
  });

  test('late replies and dispose reach the real backend', async () => {
    let late!: (r: PanReply) => void;
    const dispose = vi.fn();
    const real: MentorBackend = { kind: 'ai', reply: () => Promise.resolve(reply('a')), onLate: (fn) => { late = fn; return () => {}; }, dispose };
    const b = lazyBackend('ai', { fallback }, () => Promise.resolve(real));
    const got: PanReply[] = [];
    b.onLate!((r) => got.push(r));
    await b.reply(hello, ctx);
    late(reply('l'));
    expect(got).toHaveLength(1);
    b.dispose!();
    expect(dispose).toHaveBeenCalled();
  });
});

test('createScriptedBackend is still the voice answer', async () => {
  expect(triggers(await createScriptedBackend(engine, dialogue).reply({ kind: 'voice' }, ctx))).toEqual(['voice.not_yet']);
});
