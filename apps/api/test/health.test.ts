import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Mailer } from '../src/types.js';
import { testDb } from './helpers/db.js';

import { testEnv as goodEnv } from './helpers/config.js';

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
      ai: null,
      now: () => new Date('2026-01-01T00:00:00Z'),
      logger: false,
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
