// @vitest-environment happy-dom
// M7 Step 10 fix round 1 (I5): hands-free cook mode with the REAL panel (cook-screen.test.ts fakes it). A spoken
// question never opens the panel or moves focus; a heard card opens it without focus; the arrow keys keep moving steps.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { content, graph } from '../content';
import type { ApiClient } from '../api/client';
import type { MentorBackend, MentorInput } from '../mentor/backend';
import { createChildFlag } from '../mentor/child-flag';
import { createDialogue } from '../mentor/dialogue';
import { mountMentorPanel, type MentorPanel } from '../mentor/panel';
import type { PanReply } from '../mentor/reply';
import { createScriptedEngine } from '../mentor/scripted';
import { createLocalSafety } from '../mentor/outage';
import type { CardWriter } from '../mentor/writer';
import { createStore } from '../state/store';
import { cookScreen } from './cook-screen';
import { buildProfileCard } from '@kitchenquest/core/engine';
import type { CardView } from '../mentor/reply';
import { HEARD_YES } from '../mentor/heard-card';

const holder = vi.hoisted(() => ({ panel: null as MentorPanel | null }));
vi.mock('../mentor', () => ({
  getMentor: () => holder.panel,
  getMentorServices: () => ({ client: { currentRun: () => Promise.resolve({ ok: true, status: 200, data: { run: null } }) } }),
}));
vi.mock('../progress', () => ({ progressService: () => Promise.reject(new Error('not in this test')) }));

interface Ctl { hear(text: string, tooLong?: boolean, emergency?: boolean): void; said: unknown[]; closedReason: string | null }
const made = vi.hoisted(() => ({ controllers: [] as Ctl[] }));
vi.mock('../voice', () => ({
  providerKind: () => 'service',
  serviceProvider: () => ({ close: () => undefined }),
  devBrowserProvider: () => { throw new Error('not in tests'); },
  createVoiceController: () => {
    const transcripts = new Set<(t: string, tooLong: boolean, id: number, emergency: boolean) => void>();
    let id = 0;
    const c = {
      handsFree: false, phase: 'idle', state: null, closedReason: null as string | null,
      said: [] as unknown[],
      startHandsFree() { c.handsFree = true; }, stopHandsFree() { c.handsFree = false; }, timerSounding() {}, say(plan: unknown) { c.said.push(plan); },
      onTranscript(fn: (t: string, tooLong: boolean, id: number, emergency: boolean) => void) { transcripts.add(fn); return () => { transcripts.delete(fn); }; },
      onHandsFreeOff() { return () => undefined; }, onMic() { return () => undefined; }, onProblem() { return () => undefined; }, onPhase() { return () => undefined; },
      close(reason = 'off') { c.closedReason = reason; c.handsFree = false; },
      hear(text: string, tooLong = false, emergency = false) { for (const fn of [...transcripts]) fn(text, tooLong, ++id, emergency); },
    };
    made.controllers.push(c);
    return c;
  },
}));

const T0 = new Date('2026-11-10T18:00:00');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => { vi.stubEnv('VITE_HANDS_FREE', 'on'); made.controllers.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); holder.panel?.destroy(); holder.panel = null; document.body.replaceChildren(); delete document.documentElement.dataset.handsFree; });

describe('hands-free cook mode with the real panel (fix round 1, I5)', () => {
  test('a spoken question: the panel stays shut, focus stays, the cook view says the Pan answered, and ArrowRight still moves the step; a heard card opens the panel without focus, and the arrows still work', async () => {
    const store = createStore(null);
    store.update((s) => ({ ...s, account: { email: 'cook@example.test' }, aiDisclosureSeen: true, settings: { ...s.settings, voice: { ...s.settings.voice, on: true, handsFree: true } } }));
    const dialogue = createDialogue(content.pan);
    const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes: [], now: () => T0 });
    const inputs: MentorInput[] = [];
    const backend: MentorBackend = { kind: 'scripted', reply: (i) => { inputs.push(i); return Promise.resolve<PanReply>({ items: [{ kind: 'said', said: dialogue.say('thanks') }], cards: [], intents: [], actions: [], notice: null }); } };
    const root = document.createElement('div');
    document.body.append(root);
    holder.panel = mountMentorPanel(root, {
      mode: 'standard', backend, dialogue, writer: {} as CardWriter, engine, client: {} as ApiClient, forms: content.bureau.forms, store,
      child: createChildFlag(), reducedMotion: () => true, now: () => T0, conversationId: () => null,
    });
    const el = document.createElement('div');
    document.body.append(el);
    const screen = cookScreen();
    await screen.mount(el, { name: 'cook', slug: 'india/kerala/parippu' }, { store, now: () => T0, navigate: () => undefined });
    el.querySelector<HTMLButtonElement>('.hands-free-toggle')!.click();
    await vi.waitFor(() => { expect(made.controllers).toHaveLength(1); });
    const c = made.controllers[0];
    const progress = () => el.querySelector('.cook-progress')!.textContent;
    const panelShown = () => !document.getElementById('pan-panel')!.hidden;
    const nextBtn = el.querySelector<HTMLButtonElement>('.cook-controls .btn-primary')!;
    nextBtn.focus();

    c.hear('how long do I keep stirring');
    await flush();
    expect(inputs).toEqual([{ kind: 'transcript', text: 'how long do I keep stirring', utteranceId: 1 }]);
    expect(panelShown()).toBe(false);
    expect(document.activeElement).toBe(nextBtn);
    expect(el.querySelector('.pan-answered')!.textContent).toContain('The Pan answered.');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(progress()).toBe('Step 2 of 7');

    // A food word: the heard card needs a tap, so the panel opens, docked, without taking focus.
    c.hear("I can't eat sesame");
    await flush();
    expect(panelShown()).toBe(true);
    expect(document.querySelector('#pan-panel .heard-card')).not.toBeNull();
    expect(document.activeElement).toBe(nextBtn);
    expect(document.documentElement.dataset.handsFree).toBe('on');
    expect(inputs).toHaveLength(1); // nothing sent before the tap (Ruling 4)
    nextBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(progress()).toBe('Step 3 of 7');
    // Escape closes it, and focus stays in cook mode (it never went into the panel).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panelShown()).toBe(false);
    expect(document.activeElement).toBe(nextBtn);
    screen.unmount?.();
  });
});

describe('fix round 2 (controller ruling): in hands-free a spoken yes never confirms a card; a heard-card tap\'s reply is spoken by cook mode', () => {
  test('a non-severe card open, "yes please" spoken hands-free: nothing is sent, the card stays open, "Tap the card to say yes." once; the heard card\'s tap reply goes to cook mode\'s controller', async () => {
    const store = createStore(null);
    store.update((s) => ({ ...s, account: { email: 'cook@example.test' }, aiDisclosureSeen: true, settings: { ...s.settings, voice: { ...s.settings.voice, on: true, handsFree: true } } }));
    const dialogue = createDialogue(content.pan);
    const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes: [], now: () => T0 });
    const inputs: MentorInput[] = [];
    const view: CardView = { origin: 'server', proposalId: 'p-1', expiresAt: new Date(T0.getTime() + 3_600_000).toISOString(), card: buildProfileCard({ mealsPerWeek: 4 }), issuedTurn: 1 };
    const backend: MentorBackend = {
      kind: 'scripted',
      reply: (i) => { inputs.push(i); return Promise.resolve<PanReply>({ items: [{ kind: 'said', said: { ...dialogue.say('thanks'), part: 0 } }], cards: inputs.length === 1 ? [view] : [], intents: [], actions: [], notice: null, replyId: `r-${inputs.length}` }); },
    };
    const writer = { confirm: vi.fn(), reject: vi.fn() } as unknown as CardWriter;
    const root = document.createElement('div');
    document.body.append(root);
    holder.panel = mountMentorPanel(root, {
      mode: 'standard', backend, dialogue, writer, engine, client: {} as ApiClient, forms: content.bureau.forms, store,
      child: createChildFlag(), reducedMotion: () => true, now: () => T0, conversationId: () => null,
    });
    const el = document.createElement('div');
    document.body.append(el);
    const screen = cookScreen();
    await screen.mount(el, { name: 'cook', slug: 'india/kerala/parippu' }, { store, now: () => T0, navigate: () => undefined });
    el.querySelector<HTMLButtonElement>('.hands-free-toggle')!.click();
    await vi.waitFor(() => { expect(made.controllers).toHaveLength(1); });
    const c = made.controllers[0] as Ctl & { said: unknown[] };
    c.hear('how many meals do I cook in a week');
    await flush();
    expect(document.querySelector('#pan-panel .pan-card')).not.toBeNull(); // the card, waiting for a tap
    const tapLines = () => [...document.querySelectorAll('#pan-panel .bubble.pan .bubble-text')].filter((b) => b.textContent === 'Tap the card to answer.').length;
    c.hear('yes please');
    c.hear('yes');
    await flush();
    expect(inputs).toHaveLength(1); // never sent: no spoken_yes can reach the server's card
    expect(writer.confirm).not.toHaveBeenCalled();
    expect([...document.querySelectorAll<HTMLButtonElement>('#pan-panel .pan-card button')].some((b) => !b.disabled)).toBe(true);
    expect(tapLines()).toBe(1);
    // Fix round 3 (N2): a spoken "no" never turns it down either; the card already heard its cue.
    c.hear('no');
    c.hear('nope');
    await flush();
    expect(inputs).toHaveLength(1);
    expect(writer.reject).not.toHaveBeenCalled();
    expect([...document.querySelectorAll<HTMLButtonElement>('#pan-panel .pan-card button')].some((b) => !b.disabled)).toBe(true);
    expect(tapLines()).toBe(1);
    // Concern 5: a heard card's tap reply is spoken through cook mode's controller.
    c.hear("I can't eat sesame");
    await flush();
    const before = c.said.length;
    [...document.querySelectorAll<HTMLButtonElement>('#pan-panel .heard-card button')].find((b) => b.textContent === HEARD_YES)!.click();
    await flush();
    expect(inputs.at(-1)).toMatchObject({ kind: 'transcript', heard: { words: ['sesame'] } });
    expect(c.said.length).toBeGreaterThan(before);
    expect(JSON.stringify(c.said.at(-1))).toContain('"kind":"reply"');
    screen.unmount?.();
  });
});

/** About 30 s of a radio's talk, inside the protocol's MAX_TEXT, then the words that matter. */
const RADIO = Array.from({ length: 6 }, () => 'and now the travel news on the ring road where traffic is slow').join(' ');

describe('fix round 4 (controller ruling): an over-long hands-free transcript is scanned for an emergency or a child first', () => {
  async function mount() {
    const store = createStore(null);
    store.update((s) => ({ ...s, account: { email: 'cook@example.test' }, aiDisclosureSeen: true, settings: { ...s.settings, voice: { ...s.settings.voice, on: true, handsFree: true } } }));
    const dialogue = createDialogue(content.pan);
    const child = createChildFlag();
    const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes: [], now: () => T0, child });
    const inputs: MentorInput[] = [];
    const backend: MentorBackend = { kind: 'ai', reply: (i) => { inputs.push(i); return Promise.resolve<PanReply>({ items: [], cards: [], intents: [], actions: [], notice: null }); } };
    const root = document.createElement('div');
    document.body.append(root);
    holder.panel = mountMentorPanel(root, {
      mode: 'standard', backend, dialogue, writer: {} as CardWriter, engine, client: {} as ApiClient, forms: content.bureau.forms, store,
      child, reducedMotion: () => true, now: () => T0, conversationId: () => null,
    });
    const el = document.createElement('div');
    document.body.append(el);
    const screen = cookScreen();
    await screen.mount(el, { name: 'cook', slug: 'india/kerala/parippu' }, { store, now: () => T0, navigate: () => undefined });
    el.querySelector<HTMLButtonElement>('.hands-free-toggle')!.click();
    await vi.waitFor(() => { expect(made.controllers).toHaveLength(1); });
    const panTexts = () => [...document.querySelectorAll('#pan-panel .bubble.pan .bubble-text')].map((b) => b.textContent ?? '');
    return { c: made.controllers[0], inputs, child, screen, panTexts, lines: (t: string) => content.pan.triggers[t].lines };
  }

  test('an emergency phrase at the end of a 30 s over-long transcript: the emergency line, drawn and spoken; nothing sent', async () => {
    const t = await mount();
    t.c.hear(`${RADIO} I ate peanuts and my throat is closing, I can't breathe`, true);
    await flush();
    expect(t.inputs).toEqual([]);
    expect(t.panTexts().some((x) => t.lines('rule.emergency').includes(x))).toBe(true);
    expect(JSON.stringify(t.c.said.at(-1))).toContain('rule.emergency');
    t.screen.unmount?.();
  });

  test('a child phrase: the child flag (voice closes) and child.grownup; plain chatter: voice.too_long only, nothing else drawn and nothing sent', async () => {
    const t = await mount();
    t.c.hear(`${RADIO} hello I'm 9 years old and I want to cook`, true);
    await flush();
    expect(t.child.on).toBe(true);
    expect(t.c.closedReason).toBe('child');
    expect(t.panTexts().some((x) => t.lines('child.grownup').includes(x))).toBe(true);
    expect(t.inputs).toEqual([]);
    t.screen.unmount?.();
    holder.panel?.destroy();
    made.controllers.length = 0;
    const u = await mount();
    const before = u.panTexts().length;
    u.c.hear(RADIO, true);
    await flush();
    expect(u.inputs).toEqual([]);
    expect(JSON.stringify(u.c.said.at(-1))).toContain('voice.too_long');
    expect(u.panTexts()).toHaveLength(before + 1); // only the cue itself
    expect(u.lines('voice.too_long')).toContain(u.panTexts().at(-1));
    u.screen.unmount?.();
  });
});

describe('fix round 5 (F4-2): read-aloud off, an emergency or child reply in hands-free still opens the docked panel without focus, and an emergency is spoken', () => {
  async function mountQuiet() {
    const store = createStore(null);
    store.update((s) => ({ ...s, account: { email: 'cook@example.test' }, aiDisclosureSeen: true, settings: { ...s.settings, voice: { ...s.settings.voice, on: true, handsFree: true, readAloud: false } } }));
    const dialogue = createDialogue(content.pan);
    const child = createChildFlag();
    const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes: [], now: () => T0, child });
    const local = createLocalSafety({ dialogue, graph, child });
    const inputs: MentorInput[] = [];
    // The device's own safety answers come first, as the AI backend's local safety gives them.
    const backend: MentorBackend = { kind: 'ai', reply: (i, ctx) => { inputs.push(i); return Promise.resolve(local.reply(i, ctx)?.reply ?? { items: [], cards: [], intents: [], actions: [], notice: null }); } };
    const root = document.createElement('div');
    document.body.append(root);
    holder.panel = mountMentorPanel(root, {
      mode: 'standard', backend, dialogue, writer: {} as CardWriter, engine, client: {} as ApiClient, forms: content.bureau.forms, store,
      child, reducedMotion: () => true, now: () => T0, conversationId: () => null,
    });
    const el = document.createElement('div');
    document.body.append(el);
    const screen = cookScreen();
    await screen.mount(el, { name: 'cook', slug: 'india/kerala/parippu' }, { store, now: () => T0, navigate: () => undefined });
    el.querySelector<HTMLButtonElement>('.hands-free-toggle')!.click();
    await vi.waitFor(() => { expect(made.controllers).toHaveLength(1); });
    const focused = el.querySelector<HTMLButtonElement>('.cook-controls .btn-primary')!;
    focused.focus();
    return { c: made.controllers[0], child, screen, focused, shown: () => !document.getElementById('pan-panel')!.hidden };
  }

  test('an emergency (normal length, and at the end of an over-long transcript): the panel opens docked, focus stays, and rule.emergency is spoken', async () => {
    for (const tooLong of [false, true]) {
      const t = await mountQuiet();
      t.c.hear(`${tooLong ? `${RADIO} ` : ''}I ate peanuts and my throat is closing, I can't breathe`, tooLong);
      await flush();
      expect(t.shown()).toBe(true);
      expect(document.activeElement).toBe(t.focused);
      expect(document.documentElement.dataset.handsFree).toBe('on');
      expect(JSON.stringify(t.c.said.at(-1))).toContain('rule.emergency');
      t.screen.unmount?.();
      holder.panel?.destroy();
      made.controllers.length = 0;
      document.body.replaceChildren();
    }
  });

  test('Step 11 (F4-1): an over-cap transcript the API marked as an emergency (no text reaches the device): the panel opens docked, focus stays, rule.emergency drawn and spoken', async () => {
    const t = await mountQuiet();
    t.c.hear('', true, true);
    await flush();
    expect(t.shown()).toBe(true);
    expect(document.activeElement).toBe(t.focused);
    expect([...document.querySelectorAll('#pan-panel .bubble.pan .bubble-text')].some((b) => content.pan.triggers['rule.emergency'].lines.includes(b.textContent ?? ''))).toBe(true);
    expect(JSON.stringify(t.c.said.at(-1))).toContain('rule.emergency');
    t.screen.unmount?.();
  });

  test('a child (over-long): the child flag closes voice, and the panel opens without focus to show child.grownup', async () => {
    const t = await mountQuiet();
    t.c.hear(`${RADIO} hello I'm 9 years old and I want to cook`, true);
    await flush();
    expect(t.child.on).toBe(true);
    expect(t.c.closedReason).toBe('child');
    expect(t.shown()).toBe(true);
    expect(document.activeElement).toBe(t.focused);
    expect([...document.querySelectorAll('#pan-panel .bubble.pan .bubble-text')].some((b) => content.pan.triggers['child.grownup'].lines.includes(b.textContent ?? ''))).toBe(true);
    t.screen.unmount?.();
  });
});
