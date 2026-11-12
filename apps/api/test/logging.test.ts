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
  app = await buildApp({ config: testConfig(), db: t.db, mailer, ai: null, now: () => new Date('2026-06-01T12:00:00Z'), logger: logs.logger });
  // A route that fails with health content in the error, its cause and its properties.
  app.get('/test/boom', async () => {
    const err = Object.assign(new Error('boom', { cause: new Error('cause') }), {
      details: { target: 'peanut' },
      params: ['peanut'],
    });
    throw err;
  });
  // The `req.log.error(err)` form: an Error as the first argument.
  app.get('/test/log-error', async (req) => {
    const err = Object.assign(new Error('lookup failed', { cause: Object.assign(new Error('inner'), { detail: 'peanut' }) }), {
      details: { target: 'peanut' },
      params: ['peanut'],
      input: 'peanut',
    });
    req.log.error(err);
    req.log.error(err, 'with a message');
    return { ok: true };
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
      // The search route (Step 5), a matched route with a stray query string, and an unmatched path.
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
    expect(res.map((r) => r.statusCode)).toEqual([200, 200, 404, 200, 400, 400, 400, 401, 500]);

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

  it('req.log.error(err) is scrubbed by the err serializer', async () => {
    const before = logs.lines().length;
    expect((await app.inject({ method: 'GET', url: '/test/log-error' })).statusCode).toBe(200);
    const added = logs.lines().slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
    const errorLines = added.filter((l) => l.level === 50);
    expect(errorLines).toHaveLength(2);
    for (const l of errorLines) {
      expect(l.err).toMatchObject({ name: 'Error', message: 'lookup failed', cause: { message: 'inner' } });
      expect(Object.keys(l.err as object).sort()).toEqual(['cause', 'message', 'name', 'stack']);
    }
    expect(JSON.stringify(added)).not.toMatch(/peanut/);
  });

  it('loggableError drops zod input values', () => {
    const r = z.object({ email: z.email() }).safeParse({ email: 'peanut' });
    const e = loggableError(r.error);
    expect(JSON.stringify(e)).not.toMatch(/peanut/);
    expect(e.name).toBe('ZodError');
  });
});

describe('the voice socket (M7 Step 5, C-9, Review Focus 2)', () => {
  it('/voice logs its pattern, kinds and statuses only: an upgrade with a health term in its query, its cookie and a refused Origin leave no "peanut"; @fastify/websocket\'s raw `path` is censored', async () => {
    const { WebSocket } = await import('ws');
    const vlogs = captureLogs();
    const t = await testDb();
    const voiceConfig = testConfig({ VOICE_ENABLED: 'true', VOICE_SERVICE_URL: 'ws://127.0.0.1:9', VOICE_SERVICE_TOKEN: 'test-token' });
    const vapp = await buildApp({ config: voiceConfig, db: t.db, mailer, ai: null, now: () => new Date('2026-06-01T12:00:00Z'), logger: vlogs.logger });
    vapp.get('/test/plain', async () => ({ ok: true }));
    try {
      await vapp.listen({ port: 0, host: '127.0.0.1' });
      const port = (vapp.server.address() as import('node:net').AddressInfo).port;
      const open = (path: string, origin: string) =>
        new Promise<number>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { origin, cookie: 'kq_session=peanut' } });
          ws.on('close', (code) => resolve(code));
          ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
          ws.on('error', () => {});
        });
      expect(await open('/voice?q=peanut', 'https://peanut.example')).toBe(4403);
      expect(await open('/voice?q=peanut', 'http://localhost:5173')).toBe(4401);
      // an upgrade to a route with no socket handler: the plugin logs its raw path, which pino censors
      await open('/test/plain?q=peanut', 'http://localhost:5173');
      await new Promise((r) => setTimeout(r, 100));
      const text = vlogs.text();
      expect(text).toContain('"url":"/voice"');
      expect(text).toContain('"kind":"voice_refused_bad_origin","status":4403');
      expect(text).toContain('"kind":"voice_refused_signed_out","status":4401');
      expect(text).not.toMatch(/peanut/);
    } finally {
      await vapp.close();
      await t.close();
    }
  });
});
