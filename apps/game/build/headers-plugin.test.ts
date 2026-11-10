import { describe, expect, test } from 'vitest';
import { isVerifyPath, verifyHeaders } from './headers-plugin';

describe('isVerifyPath', () => {
  test.each(['/auth/verify', '/auth/verify/', '/auth/verify/index.html'])('%s is a verify path', (p) => {
    expect(isVerifyPath(p)).toBe(true);
  });
  test('other paths are not', () => {
    for (const p of ['/', '/auth/verifyx', '/assets/a.js', '/auth', '/auth/verify/x.js', '/api/auth/verify']) expect(isVerifyPath(p)).toBe(false);
  });
});

describe('verifyHeaders middleware', () => {
  const run = (url: string | undefined) => {
    const set: Record<string, string> = {};
    let nexted = 0;
    verifyHeaders({ url } as never, { setHeader: (k: string, v: string) => { set[k.toLowerCase()] = v; } } as never, () => { nexted++; });
    return { set, nexted };
  };
  test('sets no-referrer and no-store on the verify page, ignoring the query', () => {
    expect(run('/auth/verify?token=abc')).toEqual({ set: { 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }, nexted: 1 });
  });
  test("the emailed link's path (no slash) is served the verify page's own file, query kept", () => {
    const req = { url: '/auth/verify?token=abc' };
    verifyHeaders(req as never, { setHeader: () => {} } as never, () => {});
    expect(req.url).toBe('/auth/verify/index.html?token=abc');
    const slash = { url: '/auth/verify/?token=abc' };
    verifyHeaders(slash as never, { setHeader: () => {} } as never, () => {});
    expect(slash.url).toBe('/auth/verify/?token=abc');
  });
  test('leaves other paths alone', () => {
    expect(run('/index.html')).toEqual({ set: {}, nexted: 1 });
    expect(run(undefined)).toEqual({ set: {}, nexted: 1 });
  });
  test("a static server's own Cache-Control passed to writeHead does not win", () => {
    const set: Record<string, string> = {};
    let written: unknown;
    const res = {
      setHeader: (k: string, v: string) => { set[k.toLowerCase()] = v; },
      writeHead: (status: number, headers?: Record<string, string>) => { written = { status, headers }; return res; },
    };
    verifyHeaders({ url: '/auth/verify/' } as never, res as never, () => {});
    res.writeHead(200, { 'Cache-Control': 'no-cache', 'Content-Type': 'text/html' });
    expect(written).toEqual({ status: 200, headers: { 'Content-Type': 'text/html' } });
    expect(set['cache-control']).toBe('no-store');
  });
});
