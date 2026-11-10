import { refreshAccount } from '../api/account';
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

type Purpose = 'health_data' | 'ai_health';
type Grant = 'granted' | 'stale' | 'missing';

/** Each permission's words. `health_data` is the Bureau keeping them at all; `ai_health` is the AI seeing them (P-4: separate). */
const COPY: Readonly<Record<Purpose, { label: string; on: string; off: string; stale: string; done: string }>> = {
  health_data: {
    label: 'Let the Bureau keep my health details',
    on: 'The Bureau keeps your allergies, diet rules and meals with your account. Untick the box to stop; you choose what happens to what is saved.',
    off: "The Bureau doesn't keep health details with your account. Rules you make are kept on this device only.",
    stale: 'The notice for this permission has changed, so it no longer counts. Tick the box to read the new one.',
    done: 'Permission filed. Thank you.',
  },
  ai_health: {
    label: 'Let the AI see my allergies, rules and meals',
    on: 'The AI can see your allergies, rules and meals. Untick the box to stop it; that takes effect at once.',
    off: "The AI doesn't see your allergies, rules or meals. Rule help and meal logging still work without it.",
    stale: 'The notice for this permission has changed, so it no longer counts. Tick the box to read the new one.',
    done: 'Permission filed. Thank you.',
  },
};

/** A current, unwithdrawn grant (a stale notice never counts: it asks again with the new notice). */
function grantOf(c: Consents, purpose: Purpose): Grant {
  const active = c.consents.filter((x) => x.purpose === purpose && x.withdrawnAt === null);
  if (c.needsReconsent.includes(purpose) || active.some((x) => !x.current)) return 'stale';
  return active.length > 0 ? 'granted' : 'missing';
}

/**
 * Settings → The Pan (M4 Step 11). The C-16 disclosure, always. "Talk to the Pan's AI" (`settings.aiMentor`).
 * Signed in: the `health_data` and `ai_health` permissions, each granted only by tapping "I agree" on its own notice
 * and withdrawn with one tap (P-4: as easy as granting; health_data then asks keep or delete), and "Forget my
 * conversations with the Pan" behind a confirm.
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

  // --- Signed in: the two permissions, and forget -----------------------------------------------------------------
  let epoch = 0;
  const signedInView = () => {
    const my = ++epoch;
    const toggles: { purpose: Purpose; show(g: Grant): void; box: HTMLInputElement }[] = [];
    /** Reads both grants again (a health_data withdraw can end ai_health too). */
    const load = () => client.consents().then((r) => {
      if (my !== epoch) return;
      for (const t of toggles) {
        t.box.disabled = !r.ok;
        if (r.ok) t.show(grantOf(r.data, t.purpose));
      }
      if (!r.ok) status.textContent = OFFLINE;
    });

    /**
     * One permission, as a box. Ticking shows its notice; only "I agree" files it. Unticking is one tap (P-4). For
     * health_data that tap opens the keep-or-delete choice the API needs (GDPR Art. 7(3)). [lawyer] P-4, C-30.
     */
    const toggle = (purpose: Purpose): HTMLElement[] => {
      const copy = COPY[purpose];
      const id = purpose === 'ai_health' ? 'set-ai-health' : 'set-health-data';
      const box = h('input', { type: 'checkbox', id });
      box.disabled = true;
      const note = h('p', { class: 'field-hint', id: `${id}-note` });
      box.setAttribute('aria-describedby', note.id);
      const slot = h('div', { class: purpose === 'ai_health' ? 'ai-health-notice' : 'health-data-notice' });
      let grant: Grant = 'missing';
      const show = (g: Grant) => {
        grant = g;
        box.checked = g === 'granted';
        note.textContent = g === 'granted' ? copy.on : g === 'stale' ? copy.stale : copy.off;
      };
      toggles.push({ purpose, show, box });

      const withdraw = (healthData?: 'keep' | 'delete') => {
        slot.replaceChildren();
        box.disabled = true;
        void client.withdrawConsent(purpose, healthData).then((r) => {
          box.disabled = false;
          if (!(r.ok || r.status === 404)) { show(grant); status.textContent = OFFLINE; return; }
          status.textContent = purpose === 'ai_health'
            ? 'Done. The AI no longer sees your allergies, rules or meals.'
            : healthData === 'delete'
              ? 'Done. Your health details have been deleted from your account.'
              : 'Done. Nothing new is kept; what was saved stays, read-only.';
          // Deleted rules (or a withdraw that ended the AI permission too) show at once.
          if (purpose === 'health_data') void refreshAccount(client, store);
          void load();
          box.focus();
        });
      };

      box.addEventListener('change', () => {
        status.textContent = '';
        if (!box.checked) {
          if (purpose === 'ai_health') { withdraw(); return; }
          // health_data: the one tap opens the choice the API needs; nothing changes until one is chosen.
          box.checked = true;
          const keep = h('button', { type: 'button', class: 'btn btn-secondary', id: 'health-keep' }, 'Stop, and keep what is saved');
          const del = h('button', { type: 'button', class: 'btn btn-secondary', id: 'health-delete' }, 'Stop, and delete it now');
          const cancel = h('button', { type: 'button', class: 'btn btn-secondary', id: 'health-cancel' }, 'Keep my permission');
          keep.addEventListener('click', () => { withdraw('keep'); });
          del.addEventListener('click', () => { withdraw('delete'); });
          cancel.addEventListener('click', () => { slot.replaceChildren(); box.focus(); });
          slot.replaceChildren(h('div', { class: 'health-withdraw', role: 'group', 'aria-labelledby': 'health-withdraw-title' },
            h('h3', { id: 'health-withdraw-title' }, 'Stop keeping health details?'),
            h('p', null, 'Keep: your saved rules, meals and conversations stay, read-only, and nothing new is added. Delete: they are removed from your account now. Either way, rules on this device are untouched.'),
            h('div', { class: 'button-row' }, keep, del, cancel)));
          keep.focus();
          return;
        }
        // Granting shows the notice first (the current one, so a stale grant re-consents to the new text).
        box.checked = false;
        box.disabled = true;
        void client.consents().then((r) => {
          box.disabled = false;
          const notice = r.ok ? r.data.notices[purpose] : undefined;
          const form = forms[purpose === 'ai_health' ? 'consent_ai' : 'consent_health'] as BureauForm | undefined;
          if (notice === undefined || form === undefined) { status.textContent = OFFLINE; return; }
          const card = renderConsentCard(purpose, {
            form, notice,
            onAgree: async () => {
              const g = await client.grantConsent(purpose, notice.version);
              if (!g.ok) { status.textContent = OFFLINE; return; }
              show('granted');
              slot.replaceChildren();
              status.textContent = copy.done;
              box.focus();
            },
            onDecline: () => { slot.replaceChildren(); show(grant); box.focus(); },
          });
          slot.replaceChildren(card);
          card.querySelector<HTMLButtonElement>('.consent-agree')?.focus();
        });
      });
      return [h('div', { class: 'field' }, box, h('label', { for: id }, copy.label)), note, slot];
    };
    const health = toggle('health_data');
    const ai = toggle('ai_health');
    void load();

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

    return [...health, ...ai, h('div', { class: 'button-row' }, forget)];
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
