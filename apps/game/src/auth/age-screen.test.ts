// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { ageFromYear, mountAgeScreen, UNDER_16_TEXT } from './age-screen';

test.each([[2000, 2026, 'ok'], [2010, 2026, 'ask_birthday'], [2011, 2026, 'under'], [2009, 2026, 'ok'], [2026, 2026, 'under']] as const)(
  'born %i in %i → %s', (year, now, want) => {
    expect(ageFromYear(year, now)).toBe(want);
  });

function mount() {
  document.body.replaceChildren();
  const el = document.createElement('div');
  document.body.append(el);
  const onOk = vi.fn();
  const onUnder = vi.fn();
  mountAgeScreen(el, { thisYear: 2026, onOk, onUnder });
  const select = el.querySelector<HTMLSelectElement>('#birth-year')!;
  const create = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Create my account');
  const pick = (v: string) => { select.value = v; select.dispatchEvent(new Event('change')); };
  return { el, onOk, onUnder, select, create, pick };
}

describe('mountAgeScreen', () => {
  test('a neutral question: no year chosen, every year from this one back 100, and the button off', () => {
    const { el, select, create } = mount();
    expect(el.querySelector('h2')!.textContent).toBe('Before we make your account');
    expect(el.querySelector('label[for="birth-year"]')!.textContent).toBe('What year were you born?');
    const opts = [...select.options];
    expect(opts[0].textContent).toBe('Choose a year');
    expect(opts[0].value).toBe('');
    expect(select.value).toBe('');
    expect(opts.slice(1).map((o) => o.value)).toEqual(Array.from({ length: 101 }, (_, i) => String(2026 - i)));
    expect(opts.filter((o) => o.defaultSelected && o.value !== '')).toEqual([]);
    expect(create()!.disabled).toBe(true);
  });

  test('ok: the button turns on, and a tap calls onOk', () => {
    const { pick, create, onOk, onUnder } = mount();
    pick('2000');
    expect(create()!.disabled).toBe(false);
    create()!.click();
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(onUnder).not.toHaveBeenCalled();
  });

  test('exactly 16 asks about the birthday: Yes is ok, No is under', () => {
    let m = mount();
    m.pick('2010');
    expect(m.el.querySelector<HTMLElement>('.age-birthday')!.hidden).toBe(false);
    expect(m.el.querySelector('legend')!.textContent).toBe('Have you had your birthday yet this year?');
    expect(m.create()!.disabled).toBe(true);
    m.el.querySelector<HTMLInputElement>('input[value="yes"]')!.click();
    expect(m.create()!.disabled).toBe(false);
    m.create()!.click();
    expect(m.onOk).toHaveBeenCalledTimes(1);

    m = mount();
    m.pick('2010');
    m.el.querySelector<HTMLInputElement>('input[value="no"]')!.click();
    m.create()!.click();
    expect(m.onUnder).toHaveBeenCalledTimes(1);
    expect(m.onOk).not.toHaveBeenCalled();
  });

  test('changing the year away from 16 hides the birthday question again; nothing is final until the tap', () => {
    const m = mount();
    m.pick('2010');
    m.pick('2015'); // arrowing through the list: not final
    m.pick('1990');
    expect(m.el.querySelector<HTMLElement>('.age-birthday')!.hidden).toBe(true);
    expect(m.onUnder).not.toHaveBeenCalled();
    m.create()!.click();
    expect(m.onOk).toHaveBeenCalledTimes(1);
  });

  test('under 16: the form is replaced for good, with a way back to the kitchen', () => {
    const m = mount();
    m.pick('2015');
    m.create()!.click();
    expect(m.onUnder).toHaveBeenCalledTimes(1);
    expect(m.el.querySelector('#birth-year')).toBeNull();
    expect(m.el.textContent).toContain(UNDER_16_TEXT);
    expect(m.el.querySelector('a')!.getAttribute('href')).toBe('/#/kitchen');
    expect(m.create()).toBeUndefined();
  });
});
