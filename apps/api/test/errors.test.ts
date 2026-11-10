import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import type { Db } from '../src/types.js';
import { testEnv } from './helpers/config.js';

const config = loadConfig({
  ...testEnv,
});

function make(logger: Parameters<typeof buildApp>[0]['logger'] = false) {
  // Error handling needs no database; routes here never touch db.
  return buildApp({ config, db: {} as Db, mailer: { async send() {} }, ai: null, now: () => new Date(), logger });
}

describe('error handler', () => {
  it('500 hides the message and stack but logs the error', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app = await make({ level: 'error', stream });
    app.get('/boom', async () => {
      throw new Error('secret db detail');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'Internal server error' } });
    expect(res.body).not.toContain('secret db detail');
    expect(lines.join('')).toContain('secret db detail');
    await app.close();
  });

  it('500 logs no email address and no query parameters', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app = await make({ level: 'error', stream });
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
      code: '23505',
      detail: 'Key (email)=(dup@example.com) already exists.',
    });
    app.get('/q', async () => {
      throw new DrizzleQueryError('insert into "users" ("email") values ($1)', ['param@example.com'], pgError);
    });
    app.get('/m', async () => {
      throw new Error('no account for Message.Person+tag@mail.example.org');
    });
    expect((await app.inject({ method: 'GET', url: '/q' })).statusCode).toBe(500);
    expect((await app.inject({ method: 'GET', url: '/m' })).statusCode).toBe(500);
    const log = lines.join('');
    expect(log).not.toMatch(/@(example\.com|mail\.example\.org)/);
    expect(log).toContain('[email]');
    expect(log).toContain('DrizzleQueryError');
    expect(log).toContain('23505'); // the cause's code survives
    expect(log).toContain('insert into');
    expect(log).toContain('params: [redacted]');
    await app.close();
  });

  it('ZodError becomes 400 bad_request with field details', async () => {
    const app = await make();
    app.post('/z', async (req) => z.object({ n: z.number() }).parse(req.body));
    const res = await app.inject({ method: 'POST', url: '/z', payload: { n: 'x' } });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('bad_request');
    expect(error.details).toEqual([{ path: 'n', message: expect.any(String) }]);
    await app.close();
  });

  it('ApiError keeps its status, code and details', async () => {
    const app = await make();
    app.get('/c', async () => {
      throw new ApiError(409, 'conflict', 'already there', { id: 1 });
    });
    const res = await app.inject({ method: 'GET', url: '/c' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'conflict', message: 'already there', details: { id: 1 } } });
    await app.close();
  });

  it('Fastify 4xx keeps its status with code bad_request', async () => {
    const app = await make();
    app.post('/j', async () => ({}));
    const res = await app.inject({
      method: 'POST',
      url: '/j',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    const unsupported = await app.inject({
      method: 'POST',
      url: '/j',
      headers: { 'content-type': 'application/xml' },
      payload: 'x',
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json().error.code).toBe('bad_request');
    await app.close();
  });
});
