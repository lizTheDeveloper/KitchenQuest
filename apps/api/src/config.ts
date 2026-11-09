import { z } from 'zod';

export interface Config {
  databaseUrl: string;
  dataKey: Buffer;
  dataKeyId: string;
  appOrigin: string;
  mailer: 'log' | 'smtp';
  smtpUrl?: string;
  port: number;
}

const dataKey = z
  .string({ error: 'DATA_KEY is required (32 bytes, base64)' })
  .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32, {
    error: 'DATA_KEY must be 32 bytes, base64 encoded',
  });

const Env = z
  .object({
    DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
    DATA_KEY: dataKey,
    DATA_KEY_ID: z.string().min(1).default('k1'),
    APP_ORIGIN: z.string().min(1).default('http://localhost:5173'),
    MAILER: z.enum(['log', 'smtp'], { error: 'MAILER must be "log" or "smtp"' }).default('log'),
    SMTP_URL: z.string().min(1).optional(),
    PORT: z.coerce.number({ error: 'PORT must be a number' }).int().min(0).max(65535).default(3000),
  })
  .refine((e) => e.MAILER !== 'smtp' || e.SMTP_URL, {
    path: ['SMTP_URL'],
    error: 'SMTP_URL is required when MAILER=smtp',
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
    port: e.PORT,
  };
}
