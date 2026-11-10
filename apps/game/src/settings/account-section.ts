import { signOut } from '../api/account';
import type { ApiClient } from '../api/client';
import type { PlayerStore } from '../state/store';
import { h } from '../ui/dom';

/** The same words after a 202 or a 429, so the form never tells anyone whether an address has an account. */
const NEUTRAL = 'If that address can sign in, a link is on its way. It works once, for 15 minutes.';
const OFFLINE = "Couldn't reach the Bureau. Check your connection and try again.";

/**
 * Settings → Account. Signed out: an email field and "Send me a sign-in link". Signed in: who, and "Sign out".
 * Re-renders when the account changes (here, in another tab, or after a refresh).
 */
export function accountSection(store: PlayerStore, client: ApiClient): { el: HTMLElement; stop: () => void } {
  const body = h('div', { id: 'account-body' });
  const status = h('p', { id: 'account-status', role: 'status' });
  const el = h('section', { class: 'panel', 'aria-labelledby': 'set-account' }, h('h2', { id: 'set-account' }, 'Account'), body, status);
  let shown: string | null | undefined; // the email rendered, so unrelated store changes don't wipe the form

  const signedOutView = () => {
    const email = h('input', { type: 'email', id: 'account-email', name: 'email', autocomplete: 'email', required: true, maxlength: 254 });
    const send = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send me a sign-in link');
    const form = h('form', { id: 'signin-form' },
      h('p', null, 'Sign in to keep your rules with your account. The Bureau emails you a link; there is no password.'),
      h('div', { class: 'field' }, h('label', { for: 'account-email' }, 'Email'), email),
      send);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (send.disabled) return;
      send.disabled = true;
      status.textContent = '';
      void client.requestLink(email.value.trim()).then((r) => {
        send.disabled = false;
        status.textContent = r.status === 0 ? OFFLINE : NEUTRAL;
      });
    });
    return [form];
  };

  const signedInView = (address: string) => {
    const out = h('button', { type: 'button', class: 'btn btn-secondary', id: 'sign-out' }, 'Sign out');
    out.addEventListener('click', () => {
      out.disabled = true;
      status.textContent = '';
      void signOut(client, store).then(() => { status.textContent = 'Signed out on this device.'; });
    });
    return [
      h('p', null, `Signed in as ${address}`),
      h('p', null, "While you're signed in, dishes are checked against your account's rules, not the ones saved on this device."),
      out,
    ];
  };

  const render = () => {
    const email = store.get().account?.email ?? null;
    if (email === shown) return;
    shown = email;
    body.replaceChildren(...(email === null ? signedOutView() : signedInView(email)));
  };
  render();
  const stop = store.subscribe(render);
  return { el, stop };
}
