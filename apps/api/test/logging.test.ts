import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { loggableError } from '../src/errors.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb } from './helpers/db.js';
import { captureLogs } from './helpers/logs.js';

let app: FastifyInstance;
let close: () => Promise<void>;
let logs: ReturnType<typeof captureLogs>;
const mailer = new CaptureMailer();

beforeAll(async () => {
  const t = await testDb();
  close = t.close;
  logs = captureLogs();
  app = await buildApp({ config: testConfig(), db: t.db, mailer, now: () => new Date('2026-06-01T12:00:00Z'), logger: logs.logger });
  // A route that fails with health content in the error, its cause and its properties.
  app.get('/test/boom', async () => {
    const err = Object.assign(new Error('boom', { cause: new Error('cause') }), {
      details: { target: 'peanut' },
      params: ['peanut'],
    });
    throw err;
  });
});
afterAll(async () => {
  await app?.close();
  await close?.();
});

describe('log redaction (C-9)', () => {
  it('a search-style query, a body, cookies and auth headers leave no "peanut" in the log', async () => {
    const cookie = await signIn(app, mailer, 'logs@example.com');
    const cookies = { kq_session: cookie };
    const reqs = [
      // No search route yet (Step 5): an unmatched route, and a matched one with a query string.
      app.inject({ method: 'GET', url: '/ingredients/search?q=peanut' }),
      app.inject({ method: 'GET', url: '/health?q=peanut' }),
      app.inject({ method: 'GET', url: '/rules/peanut' }),
      app.inject({ method: 'PUT', url: '/profile', cookies, payload: { region: 'peanut' } }),
      app.inject({ method: 'PUT', url: '/profile', cookies, payload: { region: 'peanut', bogus: 'peanut' } }),
      app.inject({ method: 'POST', url: '/me/consents', cookies, payload: { purpose: 'peanut', noticeVersion: 'peanut' } }),
      app.inject({
        method: 'POST',
        url: '/auth/request',
        headers: { 'content-type': 'application/json' },
        payload: '{"email": "peanut',
      }),
      app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer peanut', cookie: 'other=peanut' } }),
      app.inject({ method: 'GET', url: '/test/boom?q=peanut' }),
    ];
    const res = await Promise.all(reqs);
    expect(res.map((r) => r.statusCode)).toEqual([404, 200, 404, 200, 400, 400, 400, 401, 500]);

    const text = logs.text();
    expect(logs.lines().length).toBeGreaterThan(10);
    expect(text).not.toMatch(/peanut/i);
    // The session cookie value never reaches the log either.
    expect(text).not.toContain(cookie);
  });

  it('logs route patterns, not raw URLs', async () => {
    const lines = logs.lines().map((l) => JSON.parse(l) as { req?: { url?: string } });
    const urls = lines.flatMap((l) => (l.req?.url ? [l.req.url] : []));
    expect(urls).toContain('/health');
    expect(urls).toContain('/profile');
    expect(urls).toContain('(unmatched)');
    expect(urls.some((u) => u.includes('?'))).toBe(false);
  });

  it('keeps no client address or body in request lines', async () => {
    const lines = logs.lines().map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const l of lines) {
      expect(l).not.toHaveProperty('body');
      const req = l.req as Record<string, unknown> | undefined;
      if (req) expect(Object.keys(req).sort()).toEqual(['id', 'method', 'url']);
    }
  });

  it('pino redact censors bodies, queries and auth headers logged by hand', () => {
    const before = logs.lines().length;
    app.log.info({ body: { target: 'peanut' }, query: { q: 'peanut' }, headers: { cookie: 'peanut', authorization: 'peanut' } }, 'manual');
    app.log.error({ err: Object.assign(new Error('x'), { details: 'peanut' }) }, 'manual error');
    const added = logs.lines().slice(before).join('\n');
    expect(added).toContain('[redacted]');
    expect(added).not.toMatch(/peanut/);
  });

  it('loggableError drops zod input values', () => {
    const r = z.object({ email: z.email() }).safeParse({ email: 'peanut' });
    const e = loggableError(r.error);
    expect(JSON.stringify(e)).not.toMatch(/peanut/);
    expect(e.name).toBe('ZodError');
  });
});
