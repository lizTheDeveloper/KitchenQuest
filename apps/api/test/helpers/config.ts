import { loadConfig, type Config } from '../../src/config.js';

/** A fixed, test-only ring key. Never use it outside tests. */
export const TEST_DATA_KEY = Buffer.alloc(32, 7).toString('base64');

/** The minimum valid environment for loadConfig; spread overrides over it. AI is off (`config.ai` is null). */
export const testEnv = {
  DATABASE_URL: 'postgres://x@localhost/x',
  DATA_KEYS: `k1:${TEST_DATA_KEY}`,
  DATA_KEY_ID: 'k1',
  PSEUDONYM_KEY: Buffer.alloc(32, 5).toString('base64'),
};

/**
 * testEnv with AI on (outside production), for tests that need `config.ai`, e.g.
 * its daily budget. No request is ever made: pass `fakeAi` (./fake-ai.ts) as `deps.ai`.
 */
export const testAiEnv = {
  ...testEnv,
  AI_ENABLED: 'true',
  OPENROUTER_API_KEY: 'sk-or-test',
  AI_PROVIDERS: 'tenstorrent',
  AI_DAILY_BUDGET_USD: '5',
};

/** A config from testEnv plus overrides; AI stays off unless the overrides turn it on. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...testEnv, ...overrides });
}
