import { expect, test } from 'vitest';
import { cacheName, routeFor, staleCaches } from './sw-routes';

test.each([
  ['POST', 'https://kq.test/api/auth/verify', 'cors', 'passthrough'],
  ['GET', 'https://fonts.example/x.css', 'no-cors', 'passthrough'],
  ['GET', 'https://kq.test/api/me', 'cors', 'network-only'],
  ['GET', 'https://kq.test/auth/verify?token=abc', 'navigate', 'network-only'],
  ['GET', 'https://kq.test/auth/verify/', 'navigate', 'network-only'],
  ['GET', 'https://kq.test/', 'navigate', 'shell'],
  ['GET', 'https://kq.test/assets/index-abc.js', 'cors', 'precache'],
  // Not in the brief's table: the bare prefixes are never cached either.
  ['GET', 'https://kq.test/api', 'cors', 'network-only'],
  ['GET', 'https://kq.test/auth', 'navigate', 'network-only'],
  ['GET', 'https://kq.test/apiary.png', 'no-cors', 'precache'],
])('%s %s → %s', (method, url, mode, want) => expect(routeFor({ method, url, mode }, 'https://kq.test')).toBe(want));

test('cacheName', () => expect(cacheName('abc123')).toBe('kq-shell-abc123'));

test('staleCaches keeps only current kq caches', () =>
  expect(staleCaches(['kq-shell-a', 'kq-shell-b', 'other'], 'kq-shell-b')).toEqual(['kq-shell-a']));
