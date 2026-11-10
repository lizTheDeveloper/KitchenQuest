// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { h } from './dom';
import { showDialogue } from './dialogue-box';

describe('showDialogue abort', () => {
  beforeEach(() => { vi.useFakeTimers(); document.body.replaceChildren(); });
  afterEach(() => { vi.useRealTimers(); });

  test('aborting mid-intro settles the promise, removes the box and stops the typing', async () => {
    const root = h('div', null);
    const opener = h('button', null, 'opener');
    document.body.append(opener, root);
    opener.focus();
    const ac = new AbortController();
    const done = vi.fn();
    void showDialogue(root, { speaker: 'Ama', portrait: null, lines: ['A long first line of the intro', 'Second'], reducedMotion: false, signal: ac.signal }).then(done);
    vi.advanceTimersByTime(30);
    expect(root.querySelector('.dialogue')).not.toBeNull();
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.dialogue')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('an already-aborted signal shows nothing', async () => {
    const root = h('div', null);
    document.body.append(root);
    const ac = new AbortController();
    ac.abort();
    await showDialogue(root, { speaker: 'Ama', portrait: null, lines: ['Hi'], reducedMotion: true, signal: ac.signal });
    expect(root.childElementCount).toBe(0);
  });
});
