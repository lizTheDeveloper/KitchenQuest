import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { CaptureMailer } from '../../src/mail/mailer.js';

/** Signs `email` in through the real magic-link flow; returns the session cookie value. */
export async function signIn(app: FastifyInstance, mailer: CaptureMailer, email: string): Promise<string> {
  const req = await app.inject({ method: 'POST', url: '/auth/request', payload: { email } });
  expect(req.statusCode).toBe(202);
  const token = mailer.sent.at(-1)!.text.match(/\/auth\/verify\?token=([A-Za-z0-9_-]+)/)![1];
  const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token, ageConfirmed: true } });
  expect(res.statusCode).toBe(200);
  return res.cookies.find((c) => c.name === 'kq_session')!.value;
}
