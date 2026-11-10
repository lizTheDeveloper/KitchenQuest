// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import type { ApiClient } from '../api/client';
import { content } from '../content';
import { createStore } from '../state/store';
import { getMentor, mountMentor } from './index';

test('Family Table turned on or off (here or from another tab) remounts the panel in that mode (fix round 1, M6)', () => {
  const store = createStore(null);
  const client = new Proxy({}, { get: () => () => Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } }) }) as ApiClient;
  const pan = mountMentor(document, store, content.pan, client);
  expect(getMentor()).toBe(pan);
  expect(pan.mode).toBe('standard');
  expect(document.querySelectorAll('#pan-panel')).toHaveLength(1);
  expect(document.querySelector('#pan-text')).not.toBeNull();
  pan.open();
  store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
  expect(pan.mode).toBe('familyTable');
  expect(document.querySelectorAll('#pan-panel')).toHaveLength(1);
  expect(document.querySelector('#pan-text')).toBeNull();
  expect(pan.isOpen()).toBe(true);
  store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: false } }));
  expect(pan.mode).toBe('standard');
  expect(document.querySelector('#pan-text')).not.toBeNull();
});
