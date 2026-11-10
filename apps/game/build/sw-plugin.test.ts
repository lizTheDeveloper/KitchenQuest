import { expect, test } from 'vitest';
import { precacheList, swVersion } from './sw-plugin';

test('precacheList', () => expect(precacheList(['sw.js', 'index.html', 'assets/a.js', 'assets/a.js.map', 'auth/verify/index.html'], ['manifest.webmanifest', 'icons/icon-192.png']))
  .toEqual(['/assets/a.js', '/icons/icon-192.png', '/index.html', '/manifest.webmanifest']));

test('precacheList drops dotfiles and duplicates', () =>
  expect(precacheList(['index.html'], ['assets/.gitkeep', 'index.html'])).toEqual(['/index.html']));

test('swVersion: 12 hex, changes with the list or the content version, not with list order', () => {
  const v = swVersion(['/a', '/b'], 'c1');
  expect(v).toMatch(/^[0-9a-f]{12}$/);
  expect(swVersion(['/b', '/a'], 'c1')).toBe(v);
  expect(swVersion(['/a', '/c'], 'c1')).not.toBe(v);
  expect(swVersion(['/a', '/b'], 'c2')).not.toBe(v);
});
