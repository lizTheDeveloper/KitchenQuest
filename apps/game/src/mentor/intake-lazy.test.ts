// @vitest-environment happy-dom
// M6 Step 10 (coordinator ruling 1): Form 1-A's code is lazy. Nothing safety-related waits on it: an emergency line
// arrives at once while its import hangs; the import is never requested before the panel opens; a failed import says
// `intake.unavailable` (a written line), and the Pan still answers.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import { content } from '../content';
import { createStore, type PlayerState } from '../state/store';
import type { IntakeModule } from './index';

const noClient = new Proxy({}, { get: () => () => Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } }) }) as ApiClient;
const READY: Partial<PlayerState> = { aiDisclosureSeen: true };

async function mount(importIntake: () => Promise<IntakeModule>, seed: Partial<PlayerState> = READY) {
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
    const importIntake = vi.fn(() => new Promise<IntakeModule>(() => {}));
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

  test('a player who speaks while it loads is never interrupted: it starts on the next open instead', async () => {
    let resolve!: (m: IntakeModule) => void;
    const real = await import('./intake');
    const importIntake = vi.fn(() => new Promise<IntakeModule>((r) => { resolve = r; }));
    const m = await mount(importIntake, { aiDisclosureSeen: true });
    m.panel.open();
    m.send('hello');
    await vi.waitFor(() => { expect(m.panText().length).toBeGreaterThan(0); });
    resolve(real);
    await new Promise((r) => setTimeout(r, 20));
    const opening = content.pan.triggers['intake.open'].lines;
    expect(m.panText().some((t) => opening.includes(t))).toBe(false);
    m.panel.close();
    m.panel.open();
    await vi.waitFor(() => { expect(m.panText().some((t) => opening.includes(t))).toBe(true); });
  });

  // Fix round 1, I1: a conversation a child has spoken in gets no interview and no failure line, only child.grownup.
  test('I1 scenario A: a child speaks while it loads; on a later open Form 1-A still never starts', async () => {
    let resolve!: (m: IntakeModule) => void;
    const real = await import('./intake');
    const m = await mount(() => new Promise<IntakeModule>((r) => { resolve = r; }), { aiDisclosureSeen: true });
    m.panel.open();
    m.send("I'm 9 years old");
    const grownup = content.pan.triggers['child.grownup'].lines;
    await vi.waitFor(() => { expect(m.panText().some((t) => grownup.includes(t))).toBe(true); });
    resolve(real);
    await new Promise((r) => setTimeout(r, 20));
    m.panel.close();
    m.panel.open();
    await new Promise((r) => setTimeout(r, 50));
    const opening = [...content.pan.triggers['intake.open'].lines, ...content.pan.triggers['intake.market_day.ask'].lines];
    expect(m.panText().some((t) => opening.includes(t))).toBe(false);
    expect(document.querySelector('.intake-checklist')).toBeNull();
    expect(m.panText().every((t) => grownup.includes(t))).toBe(true);
  });

  test('I1 scenario B: a child speaks, then the load fails: no intake.unavailable line, only child.grownup', async () => {
    let reject!: (e: Error) => void;
    const m = await mount(() => new Promise<IntakeModule>((_r, j) => { reject = j; }), { aiDisclosureSeen: true });
    m.panel.open();
    m.send("I'm 9 years old");
    const grownup = content.pan.triggers['child.grownup'].lines;
    await vi.waitFor(() => { expect(m.panText().some((t) => grownup.includes(t))).toBe(true); });
    reject(new Error('offline'));
    await new Promise((r) => setTimeout(r, 30));
    const unavailable = content.pan.triggers['intake.unavailable'].lines;
    expect(m.panText().some((t) => unavailable.includes(t))).toBe(false);
    m.panel.close();
    m.panel.open();
    await new Promise((r) => setTimeout(r, 30));
    expect(m.panText().some((t) => unavailable.includes(t))).toBe(false);
  });

  // m6: the other safety lines mid-load and on a failed load answer at once too.
  test.each([
    ['a medical question', 'what dose of antihistamine should I take', 'rule.medical_deflect'],
    ['a child', "I'm 9 years old", 'child.grownup'],
  ])('m6: %s mid-load (import hung) and after a failed load is answered within 50 ms', async (_name, text, trigger) => {
    const lines = content.pan.triggers[trigger].lines;
    for (const importIntake of [() => new Promise<IntakeModule>(() => {}), () => Promise.reject(new Error('offline'))]) {
      const m = await mount(importIntake, { aiDisclosureSeen: true });
      m.panel.open();
      await new Promise((r) => setTimeout(r, 10));
      const before = m.panText().length;
      m.send(text);
      const t0 = Date.now();
      await vi.waitFor(() => { expect(m.panText().length).toBeGreaterThan(before); }, { timeout: 50, interval: 1 });
      expect(Date.now() - t0).toBeLessThanOrEqual(50);
      expect(m.panText().slice(before).some((t) => lines.includes(t))).toBe(true);
    }
  });

  test('Family Table never loads it', async () => {
    const importIntake = vi.fn(() => new Promise<IntakeModule>(() => {}));
    const m = await mount(importIntake, { ...READY, settings: { ...createStore(null).get().settings, familyTable: true, reducedMotion: 'on' } });
    m.panel.open();
    expect(importIntake).not.toHaveBeenCalled();
  });
});
