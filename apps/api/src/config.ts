import { isIP } from 'node:net';
import { z } from 'zod';

/** Fastify `trustProxy`: off, all proxies, a hop count, or the proxies' addresses/CIDRs. */
export type TrustProxy = boolean | number | string[];

export interface Config {
  databaseUrl: string;
  dataKey: Buffer;
  dataKeyId: string;
  appOrigin: string;
  mailer: 'log' | 'smtp';
  smtpUrl?: string;
  mailFrom?: string;
  trustProxy: TrustProxy;
  port: number;
}

const dataKey = z
  .string({ error: 'DATA_KEY is required (32 bytes, base64)' })
  .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32, {
    error: 'DATA_KEY must be 32 bytes, base64 encoded',
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

const Env = z
  .object({
    DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
    DATA_KEY: dataKey,
    DATA_KEY_ID: z.string().min(1).default('k1'),
    APP_ORIGIN: z.url({ error: 'APP_ORIGIN must be a URL' }).default('http://localhost:5173'),
    MAILER: z.enum(['log', 'smtp'], { error: 'MAILER must be "log" or "smtp"' }).default('log'),
    SMTP_URL: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(1).optional(),
    TRUST_PROXY: trustProxy,
    NODE_ENV: z.string().optional(),
    PORT: z.coerce.number({ error: 'PORT must be a number' }).int().min(0).max(65535).default(3000),
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
    dataKey: Buffer.from(e.DATA_KEY, 'base64'),
    dataKeyId: e.DATA_KEY_ID,
    appOrigin: e.APP_ORIGIN,
    mailer: e.MAILER,
    smtpUrl: e.SMTP_URL,
    mailFrom: e.MAIL_FROM,
    trustProxy: e.TRUST_PROXY,
    port: e.PORT,
  };
}
