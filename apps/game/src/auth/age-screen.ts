/**
 * The neutral age screen (C-39) that replaces M3's "I'm 16 or older" checkbox when `/auth/verify` answers 400
 * `age_confirmation_required`. It asks for a birth year with no year chosen, so nothing nudges the answer.
 *
 * [lawyer] C-39: the 16+ threshold, the wording and the "exactly 16 asks a second question" rule are marked for
 * lawyer review. The year is only compared on this page: it is never sent, stored, logged or put in the URL.
 */
export type AgeAnswer = 'ok' | 'under' | 'ask_birthday';

/** How many years back the list goes, from this year. */
const YEARS_BACK = 100;

export const UNDER_16_TEXT = 'Kitchen Quest accounts are for people aged 16 and over. You can still play on this device without an account.';

/** From the year alone: 17 or more years ago is ok, exactly 16 needs the birthday question, fewer is under 16. */
export function ageFromYear(birthYear: number, thisYear: number): AgeAnswer {
  const diff = thisYear - birthYear;
  if (diff >= 17) return 'ok';
  if (diff === 16) return 'ask_birthday';
  return 'under';
}

/**
 * Nothing is final until "Create my account" is tapped: arrowing through the year list (which fires `change`
 * on every step) never shows the under-16 answer. Once it is shown, this page load never shows the form again.
 */
export function mountAgeScreen(el: HTMLElement, opts: { thisYear: number; onOk(): void; onUnder(): void }): void {
  const doc = el.ownerDocument;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const select = make('select', { id: 'birth-year' });
  const none = make('option', { value: '' }, 'Choose a year');
  none.selected = true;
  select.append(none);
  for (let y = opts.thisYear; y >= opts.thisYear - YEARS_BACK; y--) select.append(make('option', { value: String(y) }, String(y)));

  const yearField = make('div', { class: 'field' });
  yearField.append(make('label', { for: 'birth-year' }, 'What year were you born?'), select);

  const birthday = make('fieldset', { class: 'field age-birthday' });
  birthday.hidden = true;
  birthday.append(make('legend', {}, 'Have you had your birthday yet this year?'));
  const radios: HTMLInputElement[] = [];
  for (const [value, label] of [['yes', 'Yes'], ['no', 'No']] as const) {
    const id = `age-birthday-${value}`;
    const r = make('input', { type: 'radio', name: 'age-birthday', id, value });
    radios.push(r);
    const row = make('div', { class: 'age-radio' });
    row.append(r, make('label', { for: id }, label));
    birthday.append(row);
  }

  // Fix round 1 (M4): the extra question is announced when it appears.
  const announce = make('p', { class: 'visually-hidden age-announce', role: 'status' });
  const create = make('button', { type: 'button', id: 'create-account', class: 'btn btn-primary' }, 'Create my account');
  create.disabled = true;

  const answer = (): AgeAnswer | null => {
    if (select.value === '') return null;
    const year = Number(select.value);
    const a = ageFromYear(year, opts.thisYear);
    if (a !== 'ask_birthday') return a;
    const picked = radios.find((r) => r.checked)?.value;
    return picked === 'yes' ? 'ok' : picked === 'no' ? 'under' : 'ask_birthday';
  };
  const refresh = () => {
    const year = select.value === '' ? null : Number(select.value);
    const ask = year !== null && ageFromYear(year, opts.thisYear) === 'ask_birthday';
    if (ask !== !birthday.hidden) announce.textContent = ask ? 'One more question appeared: Have you had your birthday yet this year?' : '';
    birthday.hidden = !ask;
    if (!ask) for (const r of radios) r.checked = false;
    const a = answer();
    create.disabled = a === null || a === 'ask_birthday';
  };
  select.addEventListener('change', refresh);
  for (const r of radios) r.addEventListener('change', refresh);
  // happy-dom and some browsers fire `click` before `change` on radios: both refresh.
  for (const r of radios) r.addEventListener('click', refresh);

  let done = false;
  create.addEventListener('click', () => {
    if (done) return;
    const a = answer();
    if (a === 'ok') { opts.onOk(); return; }
    if (a !== 'under') return;
    done = true;
    const back = make('p');
    back.append(make('a', { href: '/#/kitchen' }, 'Back to the kitchen'));
    el.replaceChildren(make('h2', {}, 'Before we make your account'), make('p', { role: 'status' }, UNDER_16_TEXT), back);
    opts.onUnder();
  });

  el.replaceChildren(make('h2', {}, 'Before we make your account'), yearField, birthday, announce, create);
}
