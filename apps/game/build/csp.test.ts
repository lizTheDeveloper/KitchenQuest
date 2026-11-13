import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cspProblem, fillCsp, KQ_WS_TOKEN, kqCsp, wsOriginFor } from './csp';

const root = fileURLToPath(new URL('..', import.meta.url));
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
afterEach(() => { vi.unstubAllEnvs(); });

const cspOf = (html: string): string => /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';

describe('kqCsp (B8)', () => {
  test('index.html carries the token in connect-src, and media-src \'self\'', () => {
    expect(cspOf(indexHtml)).toContain(`connect-src 'self' ${KQ_WS_TOKEN}`);
    expect(cspOf(indexHtml)).toContain("media-src 'self'");
  });

  test("kqCsp: the built index.html has connect-src 'self' wss://<KQ_APP_ORIGIN host>; dev without one is ws://localhost:5173", () => {
    expect(wsOriginFor('https://kitchenquest.example')).toBe('wss://kitchenquest.example');
    expect(wsOriginFor('https://kitchenquest.example:8443/some/path/')).toBe('wss://kitchenquest.example:8443');
    expect(wsOriginFor('http://localhost:4173')).toBe('ws://localhost:4173');
    expect(wsOriginFor('http://127.0.0.1:4173')).toBe('ws://127.0.0.1:4173');
    // Fix round 1 (M6): plaintext only for a local preview; never a public host.
    expect(() => wsOriginFor('http://kitchenquest.example')).toThrow(/https/);
    expect(() => wsOriginFor('ftp://x.example')).toThrow(/https/);
    expect(() => wsOriginFor('not a url')).toThrow(/KQ_APP_ORIGIN/);
    const html = fillCsp(indexHtml, wsOriginFor('https://kitchenquest.example'));
    expect(cspOf(html)).toContain("connect-src 'self' wss://kitchenquest.example;");
    expect(html).not.toContain(KQ_WS_TOKEN);
    // A page without the token (the sign-in page) is left alone.
    expect(fillCsp('<html></html>', 'wss://x')).toBe('<html></html>');
    expect(cspProblem('build', {})).toMatch(/KQ_APP_ORIGIN/);
    expect(cspProblem('build', { KQ_APP_ORIGIN: 'https://kitchenquest.example' })).toBeNull();
    expect(cspProblem('serve', {})).toBeNull();
  });

  test('the transform fills the token from KQ_APP_ORIGIN, or ws://localhost:5173 on the dev server', () => {
    const run = (env: Record<string, string>, command: 'build' | 'serve') => {
      const p = kqCsp(env);
      (p.configResolved as (c: unknown) => void)({ command });
      const t = p.transformIndexHtml as { handler: (html: string) => string };
      return t.handler(indexHtml);
    };
    expect(cspOf(run({ KQ_APP_ORIGIN: 'https://kq.example' }, 'build'))).toContain("connect-src 'self' wss://kq.example;");
    expect(cspOf(run({}, 'serve'))).toContain("connect-src 'self' ws://localhost:5173;");
  });

  test('a build without KQ_APP_ORIGIN fails (the real config)', async () => {
    vi.stubEnv('KQ_APP_ORIGIN', '');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(build({ root, logLevel: 'silent', configLoader: 'runner', build: { write: false } })).rejects.toThrow(/KQ_APP_ORIGIN/);
  });
});
