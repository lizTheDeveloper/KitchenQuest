// @vitest-environment happy-dom
// M7 Step 9: Settings → Voice.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { ApiResult } from '../api/types';
import { createStore, type PlayerState } from '../state/store';
import { settingsCopy, voiceCredits } from './settings-copy';
import { voiceSection, voiceStateLine } from './voice-section';

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const ok = <T>(data: T, status = 200): Promise<ApiResult<T>> => Promise.resolve({ ok: true, status, data });
const notices = { voice: { version: 'v1', text: 'The voice notice.' }, health_data: { version: 'h1', text: 'The health notice.' } };
const grant = (purpose: string) => ({ purpose, withdrawnAt: null, current: true });

function setup(opts: { patch?: Partial<PlayerState>; granted?: string[]; status?: unknown; access?: (on: boolean) => Promise<ApiResult<null>> } = {}) {
  document.body.replaceChildren();
  const store = createStore(null);
  store.update((s) => ({ ...s, account: { email: 'cook@example.com' }, ...opts.patch }));
  let granted = [...(opts.granted ?? [])];
  const calls: string[] = [];
  const client = {
    consents: vi.fn(() => ok({ consents: granted.map(grant), needsReconsent: [], notices })),
    grantConsent: vi.fn((p: string) => { calls.push(`grant ${p}`); granted.push(p); return ok({ consent: {} }, 201); }),
    withdrawConsent: vi.fn((p: string) => { calls.push(`withdraw ${p}`); granted = granted.filter((g) => g !== p); return ok(null, 204); }),
    voiceStatus: vi.fn((d: string, t: string) => { calls.push(`status ${d} ${t}`); return ok(opts.status ?? { state: { kind: 'available' }, accessibility: false, enabled: true }); }),
    setAccessibility: vi.fn((on: boolean) => { calls.push(`access ${String(on)}`); return opts.access?.(on) ?? ok(null, 204); }),
  } as unknown as ApiClient;
  const s = voiceSection(store, client, { now: () => new Date(2026, 10, 13, 18, 5) });
  document.body.append(s.el);
  const box = (id: string) => s.el.querySelector<HTMLInputElement>(`#${id}`);
  const button = (name: string) => [...s.el.querySelectorAll('button')].find((b) => b.textContent === name);
  const tick = (id: string, on: boolean) => { const b = box(id)!; b.checked = on; b.dispatchEvent(new Event('change')); };
  return { store, client, s, calls, box, button, tick };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('Settings → Voice', () => {
  test('voice on shows the voice consent card; Not now leaves it off; granted turns it on', async () => {
    const t = setup();
    await flush();
    expect(t.box('set-voice-on')!.checked).toBe(false);
    t.tick('set-voice-on', true);
    await flush();
    const card = t.s.el.querySelector('.consent-card')!;
    expect(card.getAttribute('data-purpose')).toBe('voice');
    expect(card.textContent).toContain('The voice notice.');
    expect(t.box('set-voice-on')!.checked).toBe(false); // nothing is on until the tap
    t.button('Not now')!.click();
    expect(t.s.el.querySelector('.consent-card')).toBeNull();
    expect(t.store.get().settings.voice.on).toBe(false);
    expect(t.calls.filter((c) => c.startsWith('grant'))).toEqual([]);
    t.tick('set-voice-on', true);
    await flush();
    t.button('I agree')!.click();
    await flush();
    expect(t.calls).toContain('grant voice');
    expect(t.store.get().settings.voice.on).toBe(true);
    expect(t.box('set-voice-on')!.checked).toBe(true);
    // Off is one tap, and withdraws the consent too (P-4).
    t.tick('set-voice-on', false);
    await flush();
    expect(t.store.get().settings.voice.on).toBe(false);
    expect(t.calls).toContain('withdraw voice');
    // Already granted: on at once, no card.
    const g = setup({ granted: ['voice'] });
    g.tick('set-voice-on', true);
    await flush();
    expect(g.s.el.querySelector('.consent-card')).toBeNull();
    expect(g.store.get().settings.voice.on).toBe(true);
  });

  test('read-aloud is its own setting', async () => {
    const t = setup();
    await flush();
    expect(t.box('set-voice-read')!.checked).toBe(true);
    t.tick('set-voice-read', false);
    expect(t.store.get().settings.voice.readAloud).toBe(false);
  });

  test('accessibility without health_data shows Form 3-C; on → PUT /voice/accessibility; the copy names the fair-use ceiling', async () => {
    const t = setup();
    await flush();
    expect(t.s.el.textContent).toContain(settingsCopy('ui.settings.voice.accessibility_hint'));
    expect(settingsCopy('ui.settings.voice.accessibility_hint')).toMatch(/never limited by plan/);
    expect(settingsCopy('ui.settings.voice.accessibility_hint')).toMatch(/no proof/);
    expect(settingsCopy('ui.settings.voice.accessibility_hint')).toMatch(/daily fair-use ceiling applies to everyone/);
    expect(t.s.el.textContent).not.toMatch(/HIPAA|medical-grade/i);
    t.tick('set-voice-access', true);
    await flush();
    const card = t.s.el.querySelector('.consent-card')!;
    expect(card.getAttribute('data-purpose')).toBe('health_data');
    expect(card.textContent).toContain('3-C/HEALTH');
    expect(t.calls.filter((c) => c.startsWith('access'))).toEqual([]); // nothing sent before the tap
    t.button('I agree')!.click();
    await flush();
    expect(t.calls.slice(-2)).toEqual(['grant health_data', 'access true']);
    expect(t.box('set-voice-access')!.checked).toBe(true);
    // Off: one PUT.
    t.tick('set-voice-access', false);
    await flush();
    expect(t.calls.at(-1)).toBe('access false');
    expect(t.box('set-voice-access')!.checked).toBe(false);
    // With health_data already: straight to the PUT; a 403 consent_required (withdrawn meanwhile) shows Form 3-C.
    const h = setup({ granted: ['health_data'], access: () => Promise.resolve({ ok: false, status: 403, error: { code: 'consent_required', message: '' } }) });
    await flush();
    h.tick('set-voice-access', true);
    await flush();
    expect(h.calls).toContain('access true');
    expect(h.s.el.querySelector('.consent-card')?.getAttribute('data-purpose')).toBe('health_data');
    expect(h.box('set-voice-access')!.checked).toBe(false);
  });

  test('the state line has no digit followed by min/minutes/s/left/remaining, no <progress>, <meter> or role=timer, no "Guild", "upgrade" or "premium"; resting_today reads "for today"', async () => {
    const states = [{ kind: 'available' }, { kind: 'resting', until: '2026-11-19' }, { kind: 'resting_today' }] as const;
    for (const state of states) {
      const t = setup({ status: { state, accessibility: false, enabled: true } });
      await flush();
      const line = t.s.el.querySelector('#voice-state')!.textContent;
      expect(line).toBe(voiceStateLine(state));
      const all = t.s.el.textContent;
      expect(all).not.toMatch(/\d+\s*(min|minutes|s|left|remaining)\b/i);
      expect(t.s.el.querySelector('progress, meter, [role="timer"]')).toBeNull();
      expect(all).not.toMatch(/guild|upgrade|premium/i);
      // The player's clock goes with the status read (carry 3).
      expect(t.calls[0]).toBe('status 2026-11-13 18:05');
    }
    expect(voiceStateLine({ kind: 'available' })).toBe('Voice is ready.');
    expect(voiceStateLine({ kind: 'resting', until: '2026-11-19' })).toBe('Voice is resting until Thursday 19 November.');
    expect(voiceStateLine({ kind: 'resting_today' })).toMatch(/for today/);
    // A server with no voice says so, plainly.
    const off = setup({ status: { state: { kind: 'available' }, accessibility: false, enabled: false } });
    await flush();
    expect(off.s.el.querySelector('#voice-state')!.textContent).toBe(settingsCopy('ui.settings.voice.not_offered'));
  });

  test('the hands-free toggle is absent unless VITE_HANDS_FREE is on; voice credits list every allowed model\'s attribution', async () => {
    const t = setup();
    await flush();
    expect(t.box('set-voice-hands-free')).toBeNull();
    const items = [...t.s.el.querySelectorAll('.voice-credits li')].map((li) => li.textContent);
    expect(items).toHaveLength(voiceCredits.length);
    for (const m of voiceCredits) {
      const li = items.find((x) => x.startsWith(m.id))!;
      expect(li).toContain(m.licence);
      if (m.attribution !== null) expect(li).toContain(m.attribution);
    }
    vi.stubEnv('VITE_HANDS_FREE', 'on');
    const on = setup();
    await flush();
    expect(on.box('set-voice-hands-free')).not.toBeNull();
    on.tick('set-voice-hands-free', true);
    expect(on.store.get().settings.voice.handsFree).toBe(true);
  });

  test('signed out: voice needs an account; Family Table: the section is absent', async () => {
    const out = setup({ patch: { account: null } });
    await flush();
    expect(out.s.el.textContent).toContain(settingsCopy('ui.settings.voice.signed_out'));
    expect(out.box('set-voice-on')).toBeNull();
    expect(out.client.voiceStatus).not.toHaveBeenCalled();
    const ft = setup();
    await flush();
    ft.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    expect(ft.s.el.hidden).toBe(true);
    expect(ft.s.el.querySelector('input')).toBeNull();
  });
});
