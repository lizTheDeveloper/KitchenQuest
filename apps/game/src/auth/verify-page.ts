import type { ApiClient } from '../api/client';
import type { ApiResult } from '../api/types';

const BUSY = "The Bureau couldn't finish that just now. Try again in a moment.";
const OFFLINE = "Couldn't reach the Bureau. Check your connection and try again.";

type VerifyResult = ApiResult<{ user: { id: string; email: string } }>;

/**
 * The page a sign-in link opens (`/auth/verify?token=…`). The token is read once into this closure and the
 * address bar is cleaned at once; it is never stored, logged or put in the DOM. Nothing is sent until the
 * player taps a button (login CSRF): no form, no autofocus, no timer. At most one request is in flight.
 */
export function startVerifyPage(opts: {
  doc: Document; location: Location; history: History; client: ApiClient;
  /** Called after a successful sign-in (main uses it to clear a pending sign-out). */
  onSignedIn?: (email: string) => void;
}): void {
  const { doc, location, history, client } = opts;
  let token: string | null = new URLSearchParams(location.search).get('token');
  history.replaceState(null, '', location.pathname);

  const root = doc.getElementById('verify-main') ?? doc.body;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const link = (href: string, text: string) => el('a', { href }, text);

  const h1 = el('h1', {}, 'Sign in to Kitchen Quest');
  if (!token) {
    const again = el('p');
    again.append(link('/#/settings', 'Ask for a new sign-in link in Settings'));
    root.replaceChildren(h1, el('p', {}, 'This sign-in link is incomplete.'), again);
    return;
  }

  const status = el('p', { id: 'verify-status', role: 'status' });
  const signIn = el('button', { type: 'button', id: 'verify', class: 'btn btn-primary' }, 'Sign me in');
  const panel = el('div', { class: 'panel' });
  panel.append(el('p', {}, 'Tap the button to finish signing in on this device.'), signIn);
  root.replaceChildren(h1, panel, status);

  let inFlight = false;
  let ageBox: HTMLInputElement | null = null;

  const finish = (...nodes: Node[]) => {
    token = null; // used once, whatever happened
    panel.replaceChildren(...nodes);
  };

  const showAgeGate = () => {
    signIn.remove();
    const id = 'age-confirm';
    ageBox = el('input', { type: 'checkbox', id, required: '' });
    const create = el('button', { type: 'button', id: 'create-account', class: 'btn btn-primary' }, 'Create my account');
    create.disabled = true;
    ageBox.addEventListener('change', () => { create.disabled = !ageBox!.checked; });
    create.addEventListener('click', () => { if (ageBox?.checked) void send(create, true); });
    const field = el('div', { class: 'field' });
    field.append(ageBox, el('label', { for: id }, "I'm 16 or older"));
    panel.append(el('p', {}, 'This email address has no Kitchen Quest account yet. To create one, confirm your age.'), field, create);
  };

  async function send(button: HTMLButtonElement, ageConfirmed?: true): Promise<void> {
    if (inFlight || !token) return;
    inFlight = true;
    button.disabled = true;
    status.textContent = 'Signing you in…';
    let r: VerifyResult;
    try { r = await client.verify(token, ageConfirmed); } finally { inFlight = false; }
    if (r.ok) {
      const email = r.data.user.email;
      status.textContent = '';
      finish(el('p', {}, `Signed in as ${email}.`), link('/#/kitchen', 'Into the kitchen'));
      opts.onSignedIn?.(email);
      return;
    }
    const details = r.error.details as { code?: unknown } | undefined;
    if (r.status === 400 && details?.code === 'age_confirmation_required' && !ageConfirmed) {
      status.textContent = '';
      showAgeGate();
      return;
    }
    if (r.status === 401) {
      status.textContent = '';
      const again = el('p', {});
      again.append(link('/#/settings', 'Ask for a new sign-in link in Settings'));
      finish(el('p', {}, 'This link has expired or has already been used.'), again);
      return;
    }
    status.textContent = r.status === 0 ? OFFLINE : BUSY;
    button.disabled = ageConfirmed ? !ageBox?.checked : false;
  }

  signIn.addEventListener('click', () => { void send(signIn); });
}
