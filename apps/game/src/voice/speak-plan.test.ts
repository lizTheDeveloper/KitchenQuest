import { buildProfileCard, MAX_SPEAK_ITEMS, parseClientMsg } from '@kitchenquest/core/engine';
import { describe, expect, test } from 'vitest';
import { content } from '../content';
import { createDialogue, type Said } from '../mentor/dialogue';
import type { CardView, PanItem } from '../mentor/reply';
import { CHECK_SCREEN, speakPlan } from './speak-plan';

const bank = content.pan.triggers;
const ids = Object.keys(bank).filter((t) => t.includes('.'));
const VAR_FREE = ids.find((t) => bank[t].lines.length > 1 && bank[t].lines.every((l) => !l.includes('{')))!;
const WITH_VARS = ids.find((t) => bank[t].lines.every((l) => l.includes('{')) && Object.keys(bank[t].vars ?? {}).length > 0)!;
const dialogue = createDialogue(content.pan, { random: () => 0.99 });
const said = (s: Said): PanItem => ({ kind: 'said', said: s });
const checkScreenText = bank['voice.check_screen'].lines[0];
const card = buildProfileCard({ mealsPerWeek: 4 });

/** Every key of every item, deeply: the plan never carries text or variables (Ruling 15). */
const keysOf = (x: unknown): string[] => (typeof x !== 'object' || x === null ? [] : Object.entries(x).flatMap(([k, v]) => [k, ...keysOf(v)]));

describe('speakPlan (Ruling 15)', () => {
  test('server parts → reply items with the replyId; server cards → card items; a device line with vars → voice.check_screen; no item has a text or vars key', () => {
    expect(VAR_FREE).toBeTruthy();
    expect(WITH_VARS).toBeTruthy();
    const serverLine = { ...dialogue.say(VAR_FREE), part: 2 };
    const deviceLine = dialogue.say(VAR_FREE);
    const varLine = dialogue.say(WITH_VARS, Object.fromEntries(Object.keys(bank[WITH_VARS].vars ?? {}).map((k) => [k, 'Sam'])));
    const go: PanItem = { kind: 'go', target: { to: 'plan' }, said: { ...dialogue.say('nav.offer', { place: 'the plan' }), part: 3 } };
    const items: PanItem[] = [
      said(serverLine),
      said(deviceLine),
      said(varLine),
      go,
      { kind: 'choices', options: [{ id: 'peanut', name: 'Peanut' }], severity: null },
      { kind: 'quick', label: 'Pick a day', options: [{ label: 'Monday', value: '1' }], onPick: () => Promise.reject(new Error('never')) },
      { kind: 'retry', input: { kind: 'text', text: 'secret words' } },
    ];
    const cards: CardView[] = [
      { origin: 'server', proposalId: 'p-1', expiresAt: '2026-11-13T19:00:00Z', card, issuedTurn: 1 },
      { origin: 'local', localId: 'l-1', card, issuedTurn: 1 },
    ];
    const plan = speakPlan(items, cards, { replyId: 'r-9' });
    expect(plan.items).toEqual([
      { kind: 'reply', replyId: 'r-9', part: 2 },
      { kind: 'line', trigger: deviceLine.trigger, index: deviceLine.index },
      CHECK_SCREEN,
      { kind: 'reply', replyId: 'r-9', part: 3 },
      { kind: 'card', proposalId: 'p-1' },
      CHECK_SCREEN,
    ]);
    expect(CHECK_SCREEN).toEqual({ kind: 'line', trigger: 'voice.check_screen', index: 0 });
    // What the browser stand-in would say: the screen's own lines; never a choice, quick or retry label.
    expect(plan.said).toEqual([serverLine.text, deviceLine.text, varLine.text, go.kind === 'go' ? go.said.text : '', checkScreenText, checkScreenText]);
    expect(plan.said.join(' ')).not.toMatch(/Peanut|Monday|secret words/);
    for (const k of plan.items.flatMap(keysOf)) expect(['kind', 'replyId', 'part', 'trigger', 'index', 'proposalId']).toContain(k);
    expect(plan.items.flatMap(keysOf)).not.toContain('text');
    expect(plan.items.flatMap(keysOf)).not.toContain('vars');
    // The API accepts it as it is.
    expect(parseClientMsg({ t: 'speak', id: 1, items: plan.items })).not.toBeNull();
  });

  test('without a replyId every line is a device line; a trigger the protocol cannot name is voice.check_screen; repeats collapse; at most MAX_SPEAK_ITEMS', () => {
    const s = { ...dialogue.say(VAR_FREE), part: 0 };
    expect(speakPlan([said(s)], [], { replyId: null }).items).toEqual([{ kind: 'line', trigger: s.trigger, index: s.index }]);
    const bare = dialogue.say('didnt_understand');
    expect(bare.trigger).not.toContain('.');
    expect(speakPlan([said(bare)], [], { replyId: null }).items).toEqual([CHECK_SCREEN]);
    // A local card and a var line in a row: one "it's on the screen".
    const local: CardView = { origin: 'local', localId: 'l', card, issuedTurn: 1 };
    const varLine = dialogue.say(WITH_VARS, Object.fromEntries(Object.keys(bank[WITH_VARS].vars ?? {}).map((k) => [k, 'x'])));
    expect(speakPlan([said(varLine)], [local, local], { replyId: null }).items).toEqual([CHECK_SCREEN]);
    // Too many: the first ones, then voice.check_screen for the rest; never silently dropped.
    const many = Array.from({ length: MAX_SPEAK_ITEMS + 3 }, (_, i) => said({ ...dialogue.say(VAR_FREE), part: i }));
    const plan = speakPlan(many, [], { replyId: 'r' });
    expect(plan.items).toHaveLength(MAX_SPEAK_ITEMS);
    expect(plan.items.at(-1)).toEqual(CHECK_SCREEN);
    expect(parseClientMsg({ t: 'speak', id: 1, items: plan.items })).not.toBeNull();
    expect(speakPlan([], [], { replyId: 'r' })).toEqual({ items: [], said: [] });
  });
});
