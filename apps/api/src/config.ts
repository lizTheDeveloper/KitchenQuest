import { isIP } from 'node:net';
import { z } from 'zod';
import { AI_PROCESSOR_IDS, processorsNotReady } from './ai/processors.js';
import type { AiConfig } from './ai/openrouter.js';
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
  /** null when AI_ENABLED is not true: the mentor runs scripted only. The API key is left out of JSON. */
  ai: AiConfig | null;
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

const AiSwitch = z.object({
  AI_ENABLED: z.enum(['true', 'false'], { error: 'AI_ENABLED must be "true" or "false"' }).default('false'),
});

const required = (name: string) => z.string({ error: `${name} is required when AI_ENABLED=true` }).trim().min(1, `${name} is required when AI_ENABLED=true`);

/**
 * C-14: one plain, pinned model. A variant suffix changes routing or retention
 * (`:free` may train on prompts, `:online` adds a web search), and a router model
 * (`openrouter/auto`) picks the model itself, so both are refused. Input is lowercased first.
 */
function aiModelProblem(m: string): string | null {
  if (m.endsWith(':free')) return 'never use a :free variant for health-adjacent calls (C-14)';
  if (m.includes(':')) return 'no variant suffix (":online", ":nitro", ...): name the plain model, e.g. qwen/qwen3.8-27b (C-14)';
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(m)) return 'must be a vendor/model slug, e.g. qwen/qwen3.8-27b (C-14)';
  if (m.startsWith('openrouter/')) return 'a router model picks the model itself; pin a plain model, e.g. qwen/qwen3.8-27b (C-14)';
  return null;
}

/** Read only when AI_ENABLED=true. The data policy itself is pinned in ai/openrouter.ts (C-14), not here. */
const AiEnv = z.object({
  OPENROUTER_API_KEY: required('OPENROUTER_API_KEY'),
  AI_MODEL: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'AI_MODEL must not be empty')
    .default('qwen/qwen3.8-27b')
    .superRefine((m, ctx) => {
      const issue = aiModelProblem(m);
      if (issue) ctx.addIssue({ code: 'custom', message: issue });
    }),
  // Spike §6.6: re-check the order monthly from /models/qwen/qwen3.8-27b/endpoints; exclude fp4 providers.
  AI_PROVIDERS: required('AI_PROVIDERS')
    .transform((v) => v.split(',').map((p) => p.trim()).filter(Boolean))
    .refine((list) => list.length > 0, { error: 'AI_PROVIDERS must list at least one OpenRouter provider slug, e.g. tenstorrent' }),
  AI_DAILY_BUDGET_USD: required('AI_DAILY_BUDGET_USD').pipe(
    z.coerce.number<string>({ error: 'AI_DAILY_BUDGET_USD must be a number of US dollars' }).positive('AI_DAILY_BUDGET_USD must be greater than 0'),
  ),
  AI_TIMEOUT_MS: z.coerce
    .number({ error: 'AI_TIMEOUT_MS must be a number of milliseconds' })
    .int()
    .min(1000, 'AI_TIMEOUT_MS must be 1000–30000')
    .max(30000, 'AI_TIMEOUT_MS must be 1000–30000')
    .default(10000),
});

const DPA_NOT_SIGNED =
  "OpenRouter's DPA is not signed in docs/compliance/processors.json (P-11, C-34). Leave AI_ENABLED=false until it is.";

type Issue = { path: PropertyKey[]; message: string };

/** AI config, or null when AI is off; with AI off no other AI variable is read. */
function loadAi(env: NodeJS.ProcessEnv, issues: Issue[]): AiConfig | null {
  const sw = AiSwitch.safeParse(env);
  if (!sw.success) {
    issues.push(...sw.error.issues);
    return null;
  }
  if (sw.data.AI_ENABLED !== 'true') return null;
  // P-11 / N-9: in production AI stays off until the AI processors' DPAs are signed.
  if (env.NODE_ENV === 'production' && processorsNotReady(AI_PROCESSOR_IDS).length > 0) {
    issues.push({ path: ['AI_ENABLED'], message: DPA_NOT_SIGNED });
  }
  const r = AiEnv.safeParse(env);
  if (!r.success) {
    issues.push(...r.error.issues);
    return null;
  }
  const ai: AiConfig = {
    apiKey: r.data.OPENROUTER_API_KEY,
    model: r.data.AI_MODEL,
    providers: r.data.AI_PROVIDERS,
    timeoutMs: r.data.AI_TIMEOUT_MS,
    dailyBudgetMicroUsd: Math.round(r.data.AI_DAILY_BUDGET_USD * 1e6),
  };
  // Kept off JSON so a logged config never carries the key.
  Object.defineProperty(ai, 'apiKey', { enumerable: false });
  return ai;
}

/** Throws an Error whose message names every bad variable. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const r = Env.safeParse(env);
  const issues: Issue[] = r.success ? [] : [...r.error.issues];
  const ai = loadAi(env, issues);
  if (!r.success || issues.length > 0) {
    const lines = issues.map((i) => `${String(i.path[0] ?? 'env')}: ${i.message}`);
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
    ai,
  };
}
