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

test('precacheList never holds /api or /auth paths', () =>
  expect(precacheList(['index.html', 'api/me', 'auth/verify/index.html', 'auth', 'apiary.png', 'authors.txt'], ['api/x.json']))
    .toEqual(['/apiary.png', '/authors.txt', '/index.html']));

test('precacheList drops a .woff when the same font ships as .woff2', () =>
  expect(precacheList(['assets/vt323-latin-400-normal-AbCd_123.woff', 'assets/vt323-latin-400-normal-Zy-x9876.woff2', 'assets/solo-latin-400-normal-QwErTy12.woff'], []))
    .toEqual(['/assets/solo-latin-400-normal-QwErTy12.woff', '/assets/vt323-latin-400-normal-Zy-x9876.woff2']));

test('swVersion changes when the bytes of an unhashed file change', () => {
  const list = ['/index.html', '/manifest.webmanifest'];
  const v = swVersion(list, 'c1', { '/index.html': '<html>1', '/manifest.webmanifest': new TextEncoder().encode('{}') });
  expect(swVersion(list, 'c1', { '/manifest.webmanifest': new TextEncoder().encode('{}'), '/index.html': '<html>1' })).toBe(v);
  expect(swVersion(list, 'c1', { '/index.html': '<html>2', '/manifest.webmanifest': new TextEncoder().encode('{}') })).not.toBe(v);
  expect(swVersion(list, 'c1', { '/index.html': '<html>1', '/manifest.webmanifest': new TextEncoder().encode('{ }') })).not.toBe(v);
  expect(swVersion(list, 'c1', { '/index.html': '<html>1', '/manifest.webmanifest': new TextEncoder().encode('{}'), 'sw.js': 'code' })).not.toBe(v);
});
