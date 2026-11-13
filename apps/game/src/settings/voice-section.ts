// M7 Step 9: Settings → Voice. Lazy with the Settings screen (first paint carries none of it).
// - Signed out: voice needs an account (Ruling 8). Family Table: the section is absent (Ruling 9).
// - "Talk out loud" (`settings.voice.on`): turning it on shows the voice consent card (Form 3-C/VOICE, tap only);
//   "Not now" leaves it off. Turning it off withdraws that consent, one tap (P-4: as easy as granting), as its copy
//   says before the tap; done says so, and a failure ticks the box again and says the permission still stands (I-1).
// - "Read the Pan's replies aloud" (`readAloud`); "Hands-free in cook mode" only in a build with VITE_HANDS_FREE=on (C9).
// - "I need voice to use Kitchen Quest": the sealed accessibility need (Ruling 6), which needs health_data, so Form
//   3-C/HEALTH is shown inline first. The copy names the daily fair-use ceiling that applies to everyone (C4).
// - The state line: ready, resting until a weekday and date, or resting for today. Never a number (Ruling 5).
// - Voice credits: every allowed model, its licence and the attribution it asks for (data/voice-models.json).
import type { VoiceState } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { Consents, ConsentPurpose } from '../api/types';
import { content } from '../content';
import type { BureauForm } from '../content/types';
import { renderConsentCard } from '../mentor/consent-card';
import { takeFocus } from '../shell/focus-intent';
import { restingUntil } from '../mentor/resting';
import type { PlayerSettings, PlayerStore } from '../state/store';
import { h } from '../ui/dom';
import { settingsCopy, voiceCredits } from './settings-copy';

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (d: Date) => ({ date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` });

/** A current, unwithdrawn grant; a stale notice never counts. */
const granted = (c: Consents, purpose: ConsentPurpose): boolean =>
  !c.needsReconsent.includes(purpose) && c.consents.some((x) => x.purpose === purpose && x.withdrawnAt === null && x.current);

/** Ruling 5: the allowance as a state, in words: a day and a date at most, never a count, a countdown or a plan. */
export function voiceStateLine(state: VoiceState): string {
  switch (state.kind) {
    case 'available': return settingsCopy('ui.settings.voice.ready');
    case 'resting': return settingsCopy('ui.settings.voice.resting', { until: restingUntil(state.until) });
    case 'resting_today': return settingsCopy('ui.settings.voice.resting_today');
  }
}

export function voiceSection(store: PlayerStore, client: ApiClient, opts: { now?: () => Date; forms?: Record<string, BureauForm> } = {}): { el: HTMLElement; stop: () => void } {
  const now = opts.now ?? (() => new Date());
  const forms = opts.forms ?? content.bureau.forms;
  const body = h('div', { class: 'voice-settings' });
  const el = h('section', { class: 'panel', id: 'voice-settings', 'aria-labelledby': 'set-voice' }, h('h2', { id: 'set-voice' }, 'Voice'), body);
  const set = (patch: Partial<PlayerSettings['voice']>) => {
    store.update((s) => ({ ...s, settings: { ...s.settings, voice: { ...s.settings.voice, ...patch } } }));
  };

  let epoch = 0;
  const signedIn = (): HTMLElement[] => {
    const my = ++epoch;
    const live = () => my === epoch;
    const status = h('p', { class: 'field-hint', id: 'voice-settings-status', role: 'status' });
    const offline = () => { status.textContent = settingsCopy('ui.settings.offline'); };
    const v = store.get().settings.voice;

    // 1. Talk out loud, behind the voice consent (a tap on its card, never by speech).
    const on = h('input', { type: 'checkbox', id: 'set-voice-on', 'aria-describedby': 'set-voice-on-hint set-voice-off-hint' });
    on.checked = v.on;
    const onSlot = h('div', { class: 'voice-consent' });
    on.addEventListener('change', () => {
      status.textContent = '';
      if (!on.checked) {
        onSlot.replaceChildren();
        // P-4: withdrawing is one tap, as granting is, and the copy says so before the tap (fix round 1, I-1). Voice
        // stops on this device at once; if the withdrawal can't be filed, voice is put back on and the box says so.
        set({ on: false });
        on.disabled = true;
        void client.withdrawConsent('voice').then((r) => {
          if (!live()) return;
          on.disabled = false;
          if (r.ok || r.status === 404) { status.textContent = settingsCopy('ui.settings.voice.withdrawn'); return; }
          on.checked = true;
          set({ on: true });
          status.textContent = settingsCopy('ui.settings.voice.withdraw_failed');
        });
        return;
      }
      on.checked = false;
      on.disabled = true;
      void client.consents().then((r) => {
        if (!live()) return;
        on.disabled = false;
        if (!r.ok) { offline(); return; }
        if (granted(r.data, 'voice')) { on.checked = true; set({ on: true }); return; }
        const notice = r.data.notices.voice;
        const form = forms.consent_voice as BureauForm | undefined;
        if (notice === undefined || form === undefined) { offline(); return; }
        const card = renderConsentCard('voice', {
          form, notice,
          onAgree: async () => {
            const g = await client.grantConsent('voice', notice.version);
            if (!live()) return;
            if (!g.ok) { offline(); return; }
            onSlot.replaceChildren();
            on.checked = true;
            set({ on: true });
            status.textContent = settingsCopy('ui.settings.permission_done');
            on.focus();
          },
          onDecline: () => { onSlot.replaceChildren(); on.checked = false; on.focus(); },
        });
        onSlot.replaceChildren(card);
        card.querySelector<HTMLButtonElement>('.consent-agree')?.focus();
      });
    });

    // 2. Read-aloud; 3. hands-free (only in a build whose echo checklist passed, C9).
    const read = h('input', { type: 'checkbox', id: 'set-voice-read' });
    read.checked = v.readAloud;
    read.addEventListener('change', () => { set({ readAloud: read.checked }); });
    const handsFree = import.meta.env.VITE_HANDS_FREE === 'on' ? h('input', { type: 'checkbox', id: 'set-voice-hands-free' }) : null;
    if (handsFree) {
      handsFree.checked = v.handsFree;
      handsFree.addEventListener('change', () => { set({ handsFree: handsFree.checked }); });
    }

    // 4. The accessibility need: sealed health data (Ruling 6), so health_data first, inline (Form 3-C).
    const access = h('input', { type: 'checkbox', id: 'set-voice-access', 'aria-describedby': 'set-voice-access-hint' });
    access.disabled = true;
    const accessSlot = h('div', { class: 'voice-access-consent' });
    let accessOn = false;
    const putAccess = async (want: boolean): Promise<void> => {
      access.disabled = true;
      const r = await client.setAccessibility(want);
      if (!live()) return;
      access.disabled = false;
      if (r.ok) { accessOn = want; access.checked = want; return; }
      access.checked = accessOn;
      if (want && r.status === 403 && r.error.code === 'consent_required') { askHealth(); return; }
      offline();
    };
    const askHealth = () => {
      void client.consents().then((r) => {
        if (!live()) return;
        const notice = r.ok ? r.data.notices.health_data : undefined;
        const form = forms.consent_health as BureauForm | undefined;
        if (notice === undefined || form === undefined) { offline(); return; }
        const card = renderConsentCard('health_data', {
          form, notice,
          onAgree: async () => {
            const g = await client.grantConsent('health_data', notice.version);
            if (!live()) return;
            if (!g.ok) { offline(); return; }
            accessSlot.replaceChildren();
            await putAccess(true);
            access.focus();
          },
          onDecline: () => { accessSlot.replaceChildren(); access.checked = accessOn; access.focus(); },
        });
        accessSlot.replaceChildren(h('p', { class: 'field-hint' }, settingsCopy('ui.settings.voice.accessibility_consent')), card);
        card.querySelector<HTMLButtonElement>('.consent-agree')?.focus();
      });
    };
    access.addEventListener('change', () => {
      status.textContent = '';
      const want = access.checked;
      access.checked = accessOn;
      if (!want) { accessSlot.replaceChildren(); void putAccess(false); return; }
      void client.consents().then((r) => {
        if (!live()) return;
        if (!r.ok) { offline(); return; }
        if (granted(r.data, 'health_data')) void putAccess(true);
        else askHealth();
      });
    });

    // 5. The state line (Ruling 5), from GET /voice/status on the player's own clock (carry 3).
    const stateLine = h('p', { class: 'voice-state', id: 'voice-state' });
    const c = clock(now());
    void client.voiceStatus(c.date, c.time).then((r) => {
      if (!live()) return;
      access.disabled = !r.ok;
      if (!r.ok) { offline(); return; }
      accessOn = r.data.accessibility;
      access.checked = accessOn;
      stateLine.textContent = r.data.enabled ? voiceStateLine(r.data.state) : settingsCopy('ui.settings.voice.not_offered');
    });

    // 6. Voice credits.
    const credits = h('ul', { class: 'voice-credits' }, ...voiceCredits.map((m) => h('li', null,
      h('span', null, `${m.id} (${m.kind === 'stt' ? 'speech to text' : 'voice'}), ${m.licence}. `),
      m.attribution === null ? null : h('span', null, `${m.attribution} `),
      h('a', { href: m.source, rel: 'noopener noreferrer', target: '_blank' }, 'Source'))));

    return [
      h('div', { class: 'field' }, on, h('label', { for: 'set-voice-on' }, 'Talk out loud')),
      h('p', { class: 'field-hint', id: 'set-voice-on-hint' }, settingsCopy('ui.settings.voice.on_hint')),
      h('p', { class: 'field-hint', id: 'set-voice-off-hint' }, settingsCopy('ui.settings.voice.off_withdraws')),
      onSlot,
      h('div', { class: 'field' }, read, h('label', { for: 'set-voice-read' }, "Read the Pan's replies aloud")),
      ...(handsFree ? [h('div', { class: 'field' }, handsFree, h('label', { for: 'set-voice-hands-free' }, 'Hands-free in cook mode'))] : []),
      h('div', { class: 'field' }, access, h('label', { for: 'set-voice-access' }, 'I need voice to use Kitchen Quest')),
      h('p', { class: 'field-hint', id: 'set-voice-access-hint' }, settingsCopy('ui.settings.voice.accessibility_hint')),
      accessSlot,
      stateLine,
      h('h3', null, 'Voice credits'),
      h('p', null, settingsCopy('ui.settings.voice.credits')),
      credits,
      status,
    ];
  };

  let shown: string | undefined;
  const render = () => {
    const s = store.get();
    const key = s.settings.familyTable ? 'ft' : s.account === null ? 'out' : `in:${s.account.email}`;
    if (key === shown) return;
    shown = key;
    epoch++;
    // Family Table: absent (Ruling 9). Signed out: voice needs an account (Ruling 8).
    el.hidden = key === 'ft';
    body.replaceChildren(...(key === 'ft' ? [] : key === 'out' ? [h('p', null, settingsCopy('ui.settings.voice.signed_out'))] : signedIn()));
    // Fix round 1 (M-3): opened from the Pan's talk control: after the screen's own heading focus, this section's.
    if (key !== 'ft' && takeFocus('voice-settings')) {
      setTimeout(() => {
        const target = el.querySelector<HTMLElement>('#set-voice-on') ?? el.querySelector<HTMLElement>('h2');
        if (target === null || !target.isConnected) return;
        if (target.tagName === 'H2') target.tabIndex = -1;
        // happy-dom and older engines may lack it.
        (target as Partial<Pick<HTMLElement, 'scrollIntoView'>>).scrollIntoView?.({ block: 'center' });
        target.focus();
      }, 0);
    }
  };
  render();
  const stop = store.subscribe(render);
  return { el, stop: () => { stop(); epoch++; } };
}
