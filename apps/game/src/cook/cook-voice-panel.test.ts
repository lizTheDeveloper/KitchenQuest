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
import type { CardWriter } from '../mentor/writer';
import { createStore } from '../state/store';
import { cookScreen } from './cook-screen';

const holder = vi.hoisted(() => ({ panel: null as MentorPanel | null }));
vi.mock('../mentor', () => ({
  getMentor: () => holder.panel,
  getMentorServices: () => ({ client: { currentRun: () => Promise.resolve({ ok: true, status: 200, data: { run: null } }) } }),
}));
vi.mock('../progress', () => ({ progressService: () => Promise.reject(new Error('not in this test')) }));

interface Ctl { hear(text: string): void }
const made = vi.hoisted(() => ({ controllers: [] as Ctl[] }));
vi.mock('../voice', () => ({
  providerKind: () => 'service',
  serviceProvider: () => ({ close: () => undefined }),
  devBrowserProvider: () => { throw new Error('not in tests'); },
  createVoiceController: () => {
    const transcripts = new Set<(t: string, tooLong: boolean, id: number) => void>();
    let id = 0;
    const c = {
      handsFree: false, phase: 'idle', state: null, closedReason: null as string | null,
      startHandsFree() { c.handsFree = true; }, stopHandsFree() { c.handsFree = false; }, timerSounding() {}, say() {},
      onTranscript(fn: (t: string, tooLong: boolean, id: number) => void) { transcripts.add(fn); return () => { transcripts.delete(fn); }; },
      onHandsFreeOff() { return () => undefined; }, onMic() { return () => undefined; }, onProblem() { return () => undefined; }, onPhase() { return () => undefined; },
      close(reason = 'off') { c.closedReason = reason; c.handsFree = false; },
      hear(text: string) { for (const fn of [...transcripts]) fn(text, false, ++id); },
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
