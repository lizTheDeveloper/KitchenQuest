// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from 'vitest';
import { h } from './dom';
import { inertOthers, trapFocus } from './focus-trap';

const tab = (shiftKey = false) => new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });

describe('inertOthers', () => {
  beforeEach(() => { document.body.replaceChildren(); });
  test('inerts siblings of the root, skips the announcer and already-inert ones, and restores only its own', () => {
    const main = h('main', null), ann = h('div', { id: 'announcer' }), was = h('div', null), overlay = h('div', { id: 'overlay-root' });
    was.inert = true;
    document.body.append(main, ann, was, overlay);
    const restore = inertOthers(overlay);
    expect([main.inert, ann.inert, was.inert, overlay.inert]).toEqual([true, false, true, false]);
    restore();
    expect([main.inert, ann.inert, was.inert, overlay.inert]).toEqual([false, false, true, false]);
  });
});

describe('trapFocus', () => {
  beforeEach(() => { document.body.replaceChildren(); });
  test('wraps at both ends and pulls focus back in', () => {
    const a = h('button', null, 'a'), b = h('button', null, 'b'), off = h('button', { disabled: true }, 'off');
    const box = h('div', null, a, b, off), outside = h('button', null, 'out');
    document.body.append(box, outside);
    b.focus();
    let ev = tab(); expect(trapFocus(box, ev)).toBe(true); expect(ev.defaultPrevented).toBe(true); expect(document.activeElement).toBe(a);
    ev = tab(true); trapFocus(box, ev); expect(document.activeElement).toBe(b);
    a.focus(); ev = tab(); trapFocus(box, ev); expect(ev.defaultPrevented).toBe(false);
    outside.focus(); trapFocus(box, tab()); expect(document.activeElement).toBe(a);
  });
  test('holds still with nothing focusable, and ignores other keys', () => {
    const box = h('div', null, h('p', null, 'text'));
    document.body.append(box);
    const ev = tab();
    expect(trapFocus(box, ev)).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    expect(trapFocus(box, new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);
  });
});
