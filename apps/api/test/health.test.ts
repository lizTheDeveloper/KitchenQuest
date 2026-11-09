import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Mailer } from '../src/types.js';
import { testDb } from './helpers/db.js';

import { TEST_DATA_KEY as KEY, testEnv as goodEnv } from './helpers/config.js';

const KEY2 = Buffer.alloc(32, 9).toString('base64');

describe('loadConfig', () => {
  it('parses a valid environment with defaults', () => {
    const c = loadConfig(goodEnv);
    expect(c.keyring.activeId).toBe('k1');
    expect(c.keyring.active.length).toBe(32);
    expect(c.port).toBe(3000);
    expect(c.mailer).toBe('log');
  });

  it('loads a ring of keys with the active one chosen by DATA_KEY_ID', () => {
    const c = loadConfig({ ...goodEnv, DATA_KEYS: `k1:${KEY},k2:${KEY2}`, DATA_KEY_ID: 'k2' });
    expect(c.keyring.activeId).toBe('k2');
    expect(Object.keys(c.keyring.all)).toEqual(['k1', 'k2']);
    expect(c.keyring.active.equals(Buffer.from(KEY2, 'base64'))).toBe(true);
  });

  it('names DATA_KEYS when missing or when any key is not 32 bytes of base64', () => {
    const { DATA_KEYS: _, ...noKeys } = goodEnv;
    expect(() => loadConfig(noKeys)).toThrow(/DATA_KEYS/);
    const short = Buffer.alloc(16).toString('base64');
    expect(() => loadConfig({ ...goodEnv, DATA_KEYS: `k1:${KEY},k0:${short}` })).toThrow(/DATA_KEYS/);
    expect(() => loadConfig({ ...goodEnv, DATA_KEYS: 'k1:not base64!!' })).toThrow(/DATA_KEYS/);
  });

  it('never puts key material in the error', () => {
    const short = Buffer.alloc(16, 3).toString('base64');
    expect(() => loadConfig({ ...goodEnv, DATA_KEYS: `k1:${KEY},k0:${short}` })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(KEY) }),
    );
  });

  it('names DATA_KEY_ID when missing or not in the ring', () => {
    const { DATA_KEY_ID: _, ...noId } = goodEnv;
    expect(() => loadConfig(noId)).toThrow(/DATA_KEY_ID/);
    expect(() => loadConfig({ ...goodEnv, DATA_KEY_ID: 'k9' })).toThrow(/DATA_KEY_ID/);
  });

  it('refuses the retired DATA_KEY variable, naming it', () => {
    expect(() => loadConfig({ ...goodEnv, DATA_KEY: KEY })).toThrow(/DATA_KEY: .*DATA_KEYS/);
  });

  it('does not reveal keys when the config is logged', () => {
    const c = loadConfig(goodEnv);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(JSON.stringify(c.keyring)).toBe('{"activeId":"k1","ids":["k1"]}');
  });

  it('names DATABASE_URL when missing', () => {
    const { DATABASE_URL: _, ...noDb } = goodEnv;
    expect(() => loadConfig(noDb)).toThrow(/DATABASE_URL/);
  });

  it('requires SMTP_URL when the smtp mailer is chosen', () => {
    expect(() => loadConfig({ ...goodEnv, MAILER: 'smtp' })).toThrow(/SMTP_URL/);
  });

  it('requires MAIL_FROM when the smtp mailer is chosen', () => {
    const smtp = { ...goodEnv, MAILER: 'smtp', SMTP_URL: 'smtp://localhost:25' };
    expect(() => loadConfig(smtp)).toThrow(/MAIL_FROM/);
    expect(loadConfig({ ...smtp, MAIL_FROM: 'Kitchen Quest <hi@example.com>' }).mailFrom).toBe(
      'Kitchen Quest <hi@example.com>',
    );
  });

  it('refuses the log mailer in production, naming MAILER', () => {
    expect(() => loadConfig({ ...goodEnv, NODE_ENV: 'production' })).toThrow(/MAILER/);
    expect(() => loadConfig({ ...goodEnv, NODE_ENV: 'production', MAILER: 'log' })).toThrow(/MAILER/);
    const prod = loadConfig({
      ...goodEnv,
      NODE_ENV: 'production',
      MAILER: 'smtp',
      SMTP_URL: 'smtp://localhost:25',
      MAIL_FROM: 'hi@example.com',
    });
    expect(prod.mailer).toBe('smtp');
  });

  it('parses TRUST_PROXY: off by default, true, hop count, address/CIDR list', () => {
    expect(loadConfig(goodEnv).trustProxy).toBe(false);
    expect(loadConfig({ ...goodEnv, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...goodEnv, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ...goodEnv, TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ ...goodEnv, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1,fd00::/8' }).trustProxy).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
      'fd00::/8',
    ]);
  });

  it('names TRUST_PROXY when it is not valid', () => {
    for (const bad of ['yes', '10.0.0.0/33', '10.0.0.1,banana', '1.2.3.4/8/8', 'fd00::/129', '-1']) {
      expect(() => loadConfig({ ...goodEnv, TRUST_PROXY: bad }), bad).toThrow(/TRUST_PROXY/);
    }
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
