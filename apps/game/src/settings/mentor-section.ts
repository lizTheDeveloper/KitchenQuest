import type { ApiClient } from '../api/client';
import type { Consents } from '../api/types';
import { content } from '../content';
import type { BureauForm } from '../content/types';
import { createDialogue } from '../mentor/dialogue';
import { renderConsentCard } from '../mentor/consent-card';
import type { PlayerStore } from '../state/store';
import { contentText, h } from '../ui/dom';
import { openModal } from '../ui/modal';

const OFFLINE = "Couldn't reach the Bureau. Nothing has changed. Try again in a moment.";
const AI_HEALTH_LABEL = 'Let the AI see my allergies, rules and meals';
const AI_HEALTH_ON = "The AI can see your allergies, rules and meals. Untick the box to stop it; that takes effect at once.";
const AI_HEALTH_OFF = "The AI doesn't see your allergies, rules or meals. Rule help and meal logging still work without it.";
const AI_HEALTH_STALE = 'The notice for this permission has changed, so it no longer counts. Tick the box to read the new one.';

/** A current, unwithdrawn ai_health grant (a stale notice never counts). */
function aiHealthGranted(c: Consents): 'granted' | 'stale' | 'missing' {
  const active = c.consents.filter((x) => x.purpose === 'ai_health' && x.withdrawnAt === null);
  if (c.needsReconsent.includes('ai_health') || active.some((x) => !x.current)) return 'stale';
  return active.length > 0 ? 'granted' : 'missing';
}

/**
 * Settings → The Pan (M4 Step 11). The C-16 disclosure, always. "Talk to the Pan's AI" (`settings.aiMentor`).
 * Signed in: the `ai_health` permission, granted only by tapping "I agree" on its own notice and withdrawn with
 * one tap (P-4: as easy as granting), and "Forget my conversations with the Pan" behind a confirm.
 */
export function mentorSection(store: PlayerStore, client: ApiClient, forms: Record<string, BureauForm>): { el: HTMLElement; stop: () => void } {
  const dialogue = createDialogue(content.pan);
  const status = h('p', { id: 'pan-settings-status', role: 'status' });

  const aiMentor = h('input', { type: 'checkbox', id: 'set-ai-mentor' });
  aiMentor.checked = store.get().settings.aiMentor;
  aiMentor.addEventListener('change', () => {
    store.update((s) => ({ ...s, settings: { ...s.settings, aiMentor: aiMentor.checked } }));
  });

  const accountBox = h('div', { id: 'pan-settings-account' });
  const el = h('section', { class: 'panel', 'aria-labelledby': 'set-pan' },
    h('h2', { id: 'set-pan' }, 'The Pan'),
    contentText('p', content.bureau.disclaimers.ai_characters, { class: 'pan-disclosure-text' }),
    h('div', { class: 'field' }, aiMentor, h('label', { for: 'set-ai-mentor' }, "Talk to the Pan's AI")),
    h('p', { class: 'field-hint' }, 'Off, the Pan answers from its written script. Rules, logging and recipes work either way.'),
    accountBox,
    status);

  // --- Signed in: ai_health and forget ----------------------------------------------------------------------------
  let epoch = 0;
  const signedInView = () => {
    const my = ++epoch;
    const box = h('input', { type: 'checkbox', id: 'set-ai-health' });
    box.disabled = true;
    const note = h('p', { class: 'field-hint', id: 'set-ai-health-note' });
    box.setAttribute('aria-describedby', note.id);
    const noticeSlot = h('div', { class: 'ai-health-notice' });
    let state: 'granted' | 'stale' | 'missing' = 'missing';
    const show = () => {
      box.checked = state === 'granted';
      note.textContent = state === 'granted' ? AI_HEALTH_ON : state === 'stale' ? AI_HEALTH_STALE : AI_HEALTH_OFF;
    };
    const load = () => client.consents().then((r) => {
      if (my !== epoch) return null;
      if (!r.ok) { note.textContent = OFFLINE; return null; }
      state = aiHealthGranted(r.data);
      box.disabled = false;
      show();
      return r.data;
    });
    void load();

    box.addEventListener('change', () => {
      status.textContent = '';
      if (!box.checked) {
        // P-4: withdrawing is one tap.
        noticeSlot.replaceChildren();
        box.disabled = true;
        void client.withdrawConsent('ai_health').then((r) => {
          box.disabled = false;
          if (r.ok || r.status === 404) { state = 'missing'; show(); status.textContent = 'Done. The AI no longer sees your allergies, rules or meals.'; }
          else { show(); status.textContent = OFFLINE; }
        });
        return;
      }
      // Granting shows the notice first; only "I agree" files it.
      box.checked = false;
      box.disabled = true;
      void client.consents().then((r) => {
        box.disabled = false;
        const notice = r.ok ? r.data.notices.ai_health : undefined;
        const form = forms.consent_ai as BureauForm | undefined;
        if (notice === undefined || form === undefined) { status.textContent = OFFLINE; return; }
        const card = renderConsentCard('ai_health', {
          form, notice,
          onAgree: async () => {
            const g = await client.grantConsent('ai_health', notice.version);
            if (!g.ok) { status.textContent = OFFLINE; return; }
            state = 'granted';
            show();
            noticeSlot.replaceChildren();
            status.textContent = 'Permission filed. Thank you.';
            box.focus();
          },
          onDecline: () => { noticeSlot.replaceChildren(); show(); box.focus(); },
        });
        noticeSlot.replaceChildren(card);
        card.querySelector<HTMLButtonElement>('.consent-agree')?.focus();
      });
    });

    const forget = h('button', { type: 'button', class: 'btn btn-secondary', id: 'pan-forget' }, 'Forget my conversations with the Pan');
    forget.addEventListener('click', () => {
      const yes = h('button', { type: 'button', class: 'btn btn-primary', id: 'pan-forget-confirm' }, 'Forget them');
      const close = openModal(el.ownerDocument, {
        className: 'confirm-modal',
        title: h('h2', null, 'Forget your conversations?'),
        body: h('div', null,
          h('p', null, "This deletes what you and the Pan have said to each other from the Bureau's files. Your saved rules, meals and pantry stay as they are."),
          h('div', { class: 'button-row' }, yes)),
        opener: forget,
        onClose: () => undefined,
      });
      yes.addEventListener('click', () => {
        yes.disabled = true;
        void client.forgetConversations().then((r) => {
          close();
          if (r.ok) status.replaceChildren(contentText('span', dialogue.say('forget.done').text));
          else status.textContent = OFFLINE;
        });
      });
    });

    return [
      h('div', { class: 'field' }, box, h('label', { for: 'set-ai-health' }, AI_HEALTH_LABEL)),
      note,
      noticeSlot,
      h('div', { class: 'button-row' }, forget),
    ];
  };

  let shown: string | null | undefined;
  const render = () => {
    const s = store.get();
    aiMentor.checked = s.settings.aiMentor;
    const email = s.account?.email ?? null;
    if (email === shown) return;
    shown = email;
    epoch++;
    accountBox.replaceChildren(...(email === null ? [] : signedInView()));
  };
  render();
  const stop = store.subscribe(render);
  return { el, stop };
}
