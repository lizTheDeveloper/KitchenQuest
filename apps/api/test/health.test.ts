import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Mailer } from '../src/types.js';
import { testDb } from './helpers/db.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const goodEnv = { DATABASE_URL: 'postgres://x@localhost/x', DATA_KEY: KEY };

describe('loadConfig', () => {
  it('parses a valid environment with defaults', () => {
    const c = loadConfig(goodEnv);
    expect(c.dataKey.length).toBe(32);
    expect(c.port).toBe(3000);
    expect(c.mailer).toBe('log');
    expect(c.dataKeyId).toBe('k1');
  });

  it('names DATA_KEY when missing', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/DATA_KEY/);
  });

  it('names DATA_KEY when not 32 bytes of base64', () => {
    const short = Buffer.alloc(16).toString('base64');
    expect(() => loadConfig({ ...goodEnv, DATA_KEY: short })).toThrow(/DATA_KEY/);
    expect(() => loadConfig({ ...goodEnv, DATA_KEY: 'not base64!!' })).toThrow(/DATA_KEY/);
  });

  it('names DATABASE_URL when missing', () => {
    expect(() => loadConfig({ DATA_KEY: KEY })).toThrow(/DATABASE_URL/);
  });

  it('requires SMTP_URL when the smtp mailer is chosen', () => {
    expect(() => loadConfig({ ...goodEnv, MAILER: 'smtp' })).toThrow(/SMTP_URL/);
  });
});

describe('app', () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const t = await testDb();
    close = t.close;
    const mailer: Mailer = { async send() {} };
    app = await buildApp({
      config: loadConfig(goodEnv),
      db: t.db,
      mailer,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
  });

  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('unknown route returns the error shape with 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });
});
