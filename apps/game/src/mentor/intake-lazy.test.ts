// @vitest-environment happy-dom
// M6 Step 10 (coordinator ruling 1): Form 1-A's code is lazy. Nothing safety-related waits on it: an emergency line
// arrives at once while its import hangs; the import is never requested before the panel opens; a failed import says
// `intake.unavailable` (a written line), and the Pan still answers.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import { content } from '../content';
import { createStore, type PlayerState } from '../state/store';

const noClient = new Proxy({}, { get: () => () => Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } }) }) as ApiClient;
const READY: Partial<PlayerState> = { aiDisclosureSeen: true };

async function mount(importIntake: () => Promise<typeof import('./intake')>, seed: Partial<PlayerState> = READY) {
  vi.resetModules();
  document.body.replaceChildren();
  const { mountMentor } = await import('./index');
  const store = createStore(null);
  store.update((s) => ({ ...s, ...seed, settings: { ...s.settings, aiMentor: false, reducedMotion: 'on', ...seed.settings } }));
  const panel = mountMentor(document, store, content.pan, noClient, importIntake);
  const send = (text: string) => {
    const box = document.querySelector<HTMLTextAreaElement>('#pan-text')!;
    box.value = text;
    box.closest('form')!.requestSubmit();
  };
  const panText = () => [...document.querySelectorAll('.bubble.pan .bubble-text')].map((b) => b.textContent);
  return { panel, send, panText };
}

const emergencyLines = content.pan.triggers['rule.emergency'].lines;
const saidEmergency = (texts: string[]) => texts.some((t) => emergencyLines.includes(t));

afterEach(() => { vi.useRealTimers(); });

describe('the intake is lazy (Form 1-A)', () => {
  test('an emergency is answered within 50 ms while the intake import never resolves; before opening it is never requested', async () => {
    const importIntake = vi.fn(() => new Promise<typeof import('./intake')>(() => {}));
    const m = await mount(importIntake);
    m.send("I can't breathe, my throat is closing");
    const t0 = Date.now();
    await vi.waitFor(() => { expect(document.querySelectorAll('.bubble.pan').length).toBeGreaterThan(0); }, { timeout: 50, interval: 1 });
    expect(Date.now() - t0).toBeLessThanOrEqual(50);
    expect(importIntake).not.toHaveBeenCalled();
    // Opened: the import starts (and hangs); an emergency still answers at once.
    m.panel.open();
    expect(importIntake).toHaveBeenCalledTimes(1);
    const before = document.querySelectorAll('.bubble.pan').length;
    m.send('call an ambulance, anaphylaxis');
    const t1 = Date.now();
    await vi.waitFor(() => { expect(document.querySelectorAll('.bubble.pan').length).toBeGreaterThan(before); }, { timeout: 50, interval: 1 });
    expect(Date.now() - t1).toBeLessThanOrEqual(50);
    expect(saidEmergency(m.panText())).toBe(true);
  });

  test('a failed import says intake.unavailable (written), and the next open tries again', async () => {
    let calls = 0;
    const importIntake = vi.fn(() => { calls++; return Promise.reject(new Error('offline')); });
    const m = await mount(importIntake);
    m.panel.open();
    const lines = content.pan.triggers['intake.unavailable'].lines;
    await vi.waitFor(() => { expect(m.panText().some((t) => lines.includes(t))).toBe(true); });
    // The Pan still answers on the script.
    m.send('hello there');
    await vi.waitFor(() => { expect(m.panText().length).toBeGreaterThan(1); });
    m.panel.close();
    m.panel.open();
    await vi.waitFor(() => { expect(calls).toBe(2); });
  });

  test('Family Table never loads it', async () => {
    const importIntake = vi.fn(() => new Promise<typeof import('./intake')>(() => {}));
    const m = await mount(importIntake, { ...READY, settings: { ...createStore(null).get().settings, familyTable: true, reducedMotion: 'on' } });
    m.panel.open();
    expect(importIntake).not.toHaveBeenCalled();
  });
});
