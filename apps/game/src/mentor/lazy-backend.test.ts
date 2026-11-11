// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { content, graph } from '../content';
import type { MentorBackend } from './backend';
import { createScriptedBackend } from './backend';
import { createDialogue } from './dialogue';
import { lazyBackend } from './lazy-backend';
import type { PanReply, TurnContext } from './reply';
import { createScriptedEngine } from './scripted';

const dialogue = createDialogue(content.pan);
const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes: [], now: () => new Date('2026-11-10T12:00:00Z') });
const ctx: TurnContext = { turn: 1, openCards: [], intakeStep: null, signedIn: true, trail: [] };
const scripted = createScriptedBackend(engine, dialogue);
const fallback = async (input: Parameters<MentorBackend['reply']>[0], c: TurnContext) => {
  const r = await scripted.reply(input, c);
  return { ...r, items: [{ kind: 'said' as const, said: dialogue.say('mentor.ai_unavailable') }, ...r.items] };
};
const reply = (t: string): PanReply => ({ items: [{ kind: 'said', said: { trigger: 'x', text: t, ai: 'allowed' } }], cards: [], intents: [], actions: [], notice: null });
const texts = (r: PanReply) => r.items.flatMap((i) => (i.kind === 'said' ? [i.said.trigger] : []));

describe('lazyBackend', () => {
  test('a failed load answers from the script, emergency text included, never with nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = lazyBackend('ai', fallback, () => Promise.reject(new Error('chunk gone')));
    const r = await b.reply({ kind: 'text', text: "my son's lips are swelling, he ate peanuts" }, ctx);
    expect(texts(r)[0]).toBe('mentor.ai_unavailable');
    expect(texts(r)).toContain('rule.emergency');
  });

  test('the load is tried again on the next turn and the real backend then answers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    const real: MentorBackend = { kind: 'ai', reply: () => Promise.resolve(reply('ai')) };
    const b = lazyBackend('ai', fallback, () => (++n === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(real)));
    await b.reply({ kind: 'text', text: 'hello' }, ctx);
    expect(texts(await b.reply({ kind: 'text', text: 'hello' }, ctx))).toEqual(['x']);
    expect(n).toBe(2);
  });

  test('late replies and dispose reach the real backend', async () => {
    let late!: (r: PanReply) => void;
    const dispose = vi.fn();
    const real: MentorBackend = { kind: 'ai', reply: () => Promise.resolve(reply('a')), onLate: (fn) => { late = fn; return () => {}; }, dispose };
    const b = lazyBackend('ai', fallback, () => Promise.resolve(real));
    const got: PanReply[] = [];
    b.onLate!((r) => got.push(r));
    await b.reply({ kind: 'text', text: 'hi' }, ctx);
    late(reply('l'));
    expect(got).toHaveLength(1);
    b.dispose!();
    expect(dispose).toHaveBeenCalled();
  });
});
