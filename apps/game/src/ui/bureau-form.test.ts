// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { h } from './dom';
import { showBureauForm } from './bureau-form';

const form = { number: '1', title: 'Certificate', fields: [{ key: 'dish', label: 'Dish' }], buttons: { confirm: 'Continue' }, stamp: 'cooked' };

describe('showBureauForm signal', () => {
  test('aborting declines it, removes it and un-inerts the page', async () => {
    const main = h('main', null), root = h('div', { id: 'overlay-root' });
    document.body.replaceChildren(main, root);
    const ac = new AbortController();
    const answer = showBureauForm(root, { form, values: { dish: 'Dal' }, reducedMotion: true, signal: ac.signal });
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(main.inert).toBe(true);
    ac.abort();
    await expect(answer).resolves.toBe('decline');
    expect(root.childElementCount).toBe(0);
    expect(main.inert).toBe(false);
  });

  test('an already-aborted signal declines without showing anything', async () => {
    const main = h('main', null), root = h('div', { id: 'overlay-root' });
    document.body.replaceChildren(main, root);
    const ac = new AbortController();
    ac.abort();
    await expect(showBureauForm(root, { form, values: {}, reducedMotion: true, signal: ac.signal })).resolves.toBe('decline');
    expect(root.childElementCount).toBe(0);
    expect(main.inert).toBe(false);
  });
});
