import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { TEST_DATA_KEY as KEY, testAiEnv as aiEnv, testEnv as goodEnv } from './helpers/config.js';

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

  it('names PSEUDONYM_KEY when missing or not 32 bytes, without echoing it', () => {
    const { PSEUDONYM_KEY: _, ...noP } = goodEnv;
    expect(() => loadConfig(noP)).toThrow(/PSEUDONYM_KEY/);
    const short = Buffer.alloc(16, 4).toString('base64');
    expect(() => loadConfig({ ...goodEnv, PSEUDONYM_KEY: short })).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/PSEUDONYM_KEY/) }),
    );
    expect(() => loadConfig({ ...goodEnv, PSEUDONYM_KEY: short })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(short) }),
    );
  });

  it('never echoes a bare key put in DATA_KEYS (the old DATA_KEY format)', () => {
    expect(() => loadConfig({ ...goodEnv, DATA_KEYS: KEY })).toThrow(
      expect.objectContaining({ message: expect.stringMatching(/DATA_KEYS entry 1/) }),
    );
    expect(() => loadConfig({ ...goodEnv, DATA_KEYS: KEY })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(KEY) }),
    );
  });

  it('does not reveal keys when the config is logged', () => {
    const c = loadConfig(goodEnv);
    const json = JSON.stringify(c);
    expect(json).not.toContain(KEY);
    expect(json).not.toContain(goodEnv.PSEUDONYM_KEY);
    expect(json).not.toContain('"type":"Buffer"');
    expect(c.pseudonymKey.bytes.length).toBe(32);
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


const prodMail = { NODE_ENV: 'production', MAILER: 'smtp', SMTP_URL: 'smtp://localhost:25', MAIL_FROM: 'hi@example.com' };

describe('loadConfig: AI (C-14, P-11)', () => {
  it('AI off by default and no AI variable needed', () => {
    expect(loadConfig(goodEnv).ai).toBeNull();
    expect(loadConfig({ ...goodEnv, AI_ENABLED: 'false' }).ai).toBeNull();
    // With AI off, nothing else is read: even a bad value is ignored.
    expect(loadConfig({ ...goodEnv, AI_ENABLED: 'false', AI_MODEL: 'x:free', AI_TIMEOUT_MS: 'soon' }).ai).toBeNull();
  });

  it('parses an enabled AI config with defaults', () => {
    const ai = loadConfig(aiEnv).ai;
    expect(ai?.apiKey).toBe('sk-or-test');
    expect({ ...ai, apiKey: undefined }).toEqual({
      model: 'qwen/qwen3.8-27b',
      providers: ['tenstorrent'],
      timeoutMs: 10000,
      dailyBudgetMicroUsd: 5_000_000,
    });
    const c = loadConfig({ ...aiEnv, AI_MODEL: 'qwen/other', AI_PROVIDERS: ' a , b ', AI_TIMEOUT_MS: '2500', AI_DAILY_BUDGET_USD: '0.25' });
    expect(c.ai).toMatchObject({ model: 'qwen/other', providers: ['a', 'b'], timeoutMs: 2500, dailyBudgetMicroUsd: 250_000 });
  });

  it('names AI_ENABLED when it is not true or false', () => {
    expect(() => loadConfig({ ...goodEnv, AI_ENABLED: 'yes' })).toThrow(/AI_ENABLED/);
  });

  it.each([['OPENROUTER_API_KEY'], ['AI_PROVIDERS'], ['AI_DAILY_BUDGET_USD']])('AI_ENABLED=true without %s fails naming it', (name) => {
    const env: Record<string, string> = { ...aiEnv };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(new RegExp(`${name}:`));
    expect(() => loadConfig({ ...env, [name]: '' })).toThrow(new RegExp(`${name}:`));
  });

  it('refuses an empty provider list and a budget that is not a positive number', () => {
    expect(() => loadConfig({ ...aiEnv, AI_PROVIDERS: ' , ' })).toThrow(/AI_PROVIDERS/);
    for (const bad of ['0', '-1', 'lots']) expect(() => loadConfig({ ...aiEnv, AI_DAILY_BUDGET_USD: bad }), bad).toThrow(/AI_DAILY_BUDGET_USD/);
  });

  it('keeps AI_TIMEOUT_MS within 1000–30000', () => {
    for (const bad of ['999', '30001', 'soon']) expect(() => loadConfig({ ...aiEnv, AI_TIMEOUT_MS: bad }), bad).toThrow(/AI_TIMEOUT_MS/);
    expect(loadConfig({ ...aiEnv, AI_TIMEOUT_MS: '1000' }).ai?.timeoutMs).toBe(1000);
    expect(loadConfig({ ...aiEnv, AI_TIMEOUT_MS: '30000' }).ai?.timeoutMs).toBe(30000);
  });

  it('a :free model is refused, in any case', () => {
    for (const m of ['qwen/qwen3.8-27b:free', 'qwen/qwen3.8-27b:FREE', ' Qwen/Qwen3.8-27b:Free ']) {
      expect(() => loadConfig({ ...aiEnv, AI_MODEL: m }), m).toThrow('AI_MODEL: never use a :free variant for health-adjacent calls (C-14)');
    }
  });

  it('refuses any other variant suffix and router models', () => {
    expect(() => loadConfig({ ...aiEnv, AI_MODEL: 'qwen/qwen3.8-27b:online' })).toThrow(/AI_MODEL: .*variant suffix/);
    expect(() => loadConfig({ ...aiEnv, AI_MODEL: 'qwen/qwen3.8-27b:nitro' })).toThrow(/AI_MODEL: .*variant suffix/);
    expect(() => loadConfig({ ...aiEnv, AI_MODEL: 'openrouter/auto' })).toThrow(/AI_MODEL: .*router model/);
    for (const bad of ['qwen3.8-27b', 'qwen/qwen 3', 'a/b/c', '/x']) {
      expect(() => loadConfig({ ...aiEnv, AI_MODEL: bad }), bad).toThrow(/AI_MODEL: .*vendor\/model slug/);
    }
  });

  it('lowercases AI_MODEL', () => {
    expect(loadConfig({ ...aiEnv, AI_MODEL: ' Qwen/Qwen3.8-27B ' }).ai?.model).toBe('qwen/qwen3.8-27b');
  });

  it('never puts the API key in an error or in the logged config', () => {
    expect(() => loadConfig({ ...aiEnv, AI_PROVIDERS: '' })).toThrow(expect.objectContaining({ message: expect.not.stringContaining('sk-or-test') }));
    expect(JSON.stringify(loadConfig(aiEnv))).not.toContain('sk-or-test');
  });

  it('production refuses AI while the OpenRouter DPA is not signed', () => {
    // processors.json as committed: dpa_status "unknown" for both AI processors.
    expect(() => loadConfig({ ...aiEnv, ...prodMail })).toThrow(
      'AI_ENABLED: OpenRouter\'s DPA is not signed in docs/compliance/processors.json (P-11, C-34). Leave AI_ENABLED=false until it is.',
    );
    // AI off in production is fine.
    expect(loadConfig({ ...goodEnv, ...prodMail }).ai).toBeNull();
  });
});
