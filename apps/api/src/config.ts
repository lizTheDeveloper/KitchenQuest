import { isIP } from 'node:net';
import { z } from 'zod';
import { Keyring, parseDataKeys, parseKey, type SecretKey } from './crypto/keyring.js';

/** Fastify `trustProxy`: off, all proxies, a hop count, or the proxies' addresses/CIDRs. */
type TrustProxy = boolean | number | string[];

export interface Config {
  databaseUrl: string;
  /** DATA_KEYS with DATA_KEY_ID active (C-2). Wraps per-user data keys; see docs/compliance/key-management.md. */
  keyring: Keyring;
  /**
   * PSEUDONYM_KEY: HMAC key for audit-log pseudonyms of deleted users (C-5).
   * Separate from the ring and never rotated with it, so pseudonyms stay stable.
   */
  pseudonymKey: SecretKey;
  appOrigin: string;
  mailer: 'log' | 'smtp';
  smtpUrl?: string;
  mailFrom?: string;
  trustProxy: TrustProxy;
  port: number;
}

const dataKeys = z
  .string({ error: 'DATA_KEYS is required: id:base64 pairs, e.g. k1:$(openssl rand -base64 32)' })
  .transform((v, ctx) => {
    try {
      return parseDataKeys(v);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `DATA_KEYS ${(e as Error).message}` });
      return z.NEVER;
    }
  });

function isAddressOrCidr(entry: string): boolean {
  const [addr, prefix, ...rest] = entry.split('/');
  const family = isIP(addr ?? '');
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

const trustProxy = z
  .string()
  .default('false')
  .transform((v, ctx): TrustProxy => {
    const s = v.trim();
    if (s === 'false' || s === '') return false;
    if (s === 'true') return true;
    if (/^\d+$/.test(s)) return Number(s);
    const list = s.split(',').map((e) => e.trim());
    if (list.every(isAddressOrCidr)) return list;
    ctx.addIssue({
      code: 'custom',
      message: 'TRUST_PROXY must be false, true, a hop count, or a comma-separated list of IP addresses/CIDRs',
    });
    return z.NEVER;
  });

const pseudonymKey = z
  .string({ error: 'PSEUDONYM_KEY is required (32 bytes, base64: openssl rand -base64 32)' })
  .transform((v, ctx) => {
    try {
      return parseKey(v);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `PSEUDONYM_KEY ${(e as Error).message}` });
      return z.NEVER;
    }
  });

const Env = z
  .object({
    DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
    DATA_KEY: z
      .undefined({ error: 'DATA_KEY is no longer read; put the key in DATA_KEYS (id:base64) and name it in DATA_KEY_ID' })
      .optional(),
    DATA_KEYS: dataKeys,
    PSEUDONYM_KEY: pseudonymKey,
    DATA_KEY_ID: z
      .string({ error: 'DATA_KEY_ID is required: the id in DATA_KEYS that seals new data' })
      .min(1, 'DATA_KEY_ID is required: the id in DATA_KEYS that seals new data'),
    APP_ORIGIN: z.url({ error: 'APP_ORIGIN must be a URL' }).default('http://localhost:5173'),
    MAILER: z.enum(['log', 'smtp'], { error: 'MAILER must be "log" or "smtp"' }).default('log'),
    SMTP_URL: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(1).optional(),
    TRUST_PROXY: trustProxy,
    NODE_ENV: z.string().optional(),
    PORT: z.coerce.number({ error: 'PORT must be a number' }).int().min(0).max(65535).default(3000),
  })
  .refine((e) => e.DATA_KEYS.has(e.DATA_KEY_ID), {
    path: ['DATA_KEY_ID'],
    error: 'DATA_KEY_ID must name a key in DATA_KEYS',
  })
  .refine((e) => e.MAILER !== 'smtp' || e.SMTP_URL, {
    path: ['SMTP_URL'],
    error: 'SMTP_URL is required when MAILER=smtp',
  })
  .refine((e) => e.MAILER !== 'smtp' || e.MAIL_FROM, {
    path: ['MAIL_FROM'],
    error: 'MAIL_FROM is required when MAILER=smtp',
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.MAILER === 'log'), {
    path: ['MAILER'],
    error: 'MAILER=log writes sign-in links to the log; set MAILER=smtp in production',
  });

/** Throws an Error whose message names every bad variable. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `${String(i.path[0] ?? 'env')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = r.data;
  return {
    databaseUrl: e.DATABASE_URL,
    keyring: new Keyring(e.DATA_KEYS, e.DATA_KEY_ID),
    pseudonymKey: e.PSEUDONYM_KEY,
    appOrigin: e.APP_ORIGIN,
    mailer: e.MAILER,
    smtpUrl: e.SMTP_URL,
    mailFrom: e.MAIL_FROM,
    trustProxy: e.TRUST_PROXY,
    port: e.PORT,
  };
}
