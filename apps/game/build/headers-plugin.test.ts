import { describe, expect, test } from 'vitest';
import { isVerifyPath, referrerMetaFirst, verifyHeaders } from './headers-plugin';

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
    verifyHeaders({ url }, { setHeader: (k: string, v: string) => { set[k.toLowerCase()] = v; } } as never, () => { nexted++; });
    return { set, nexted };
  };
  test('sets no-referrer and no-store on the verify page, ignoring the query', () => {
    expect(run('/auth/verify?token=abc')).toEqual({
      set: {
        'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
        // Clickjacking: the "Sign me in" button must never be framed by another site.
        'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY',
      },
      nexted: 1,
    });
  });
  test("the emailed link's path (no slash) is served the verify page's own file, query kept", () => {
    const req = { url: '/auth/verify?token=abc' };
    verifyHeaders(req, { setHeader: () => {} } as never, () => {});
    expect(req.url).toBe('/auth/verify/index.html?token=abc');
    const slash = { url: '/auth/verify/?token=abc' };
    verifyHeaders(slash, { setHeader: () => {} } as never, () => {});
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
    verifyHeaders({ url: '/auth/verify/' }, res as never, () => {});
    res.writeHead(200, { 'Cache-Control': 'no-cache', 'Content-Type': 'text/html' });
    expect(written).toEqual({ status: 200, headers: { 'Content-Type': 'text/html' } });
    expect(set['cache-control']).toBe('no-store');
  });
});

describe('referrerMetaFirst', () => {
  test("moves the referrer <meta> to be <head>'s first child (dev injects /@vite/client before it)", () => {
    const html = '<html><head>\n<script type="module" src="/@vite/client"></script>\n\n<meta name="referrer" content="no-referrer" />\n<meta charset="UTF-8" /></head></html>';
    expect(referrerMetaFirst(html)).toBe('<html><head><meta name="referrer" content="no-referrer" />\n<script type="module" src="/@vite/client"></script>\n\n\n<meta charset="UTF-8" /></head></html>');
  });
  test('leaves a page without one alone', () => {
    expect(referrerMetaFirst('<html><head><title>x</title></head></html>')).toBe('<html><head><title>x</title></head></html>');
  });
});
