import { loadConfig, type Config } from '../../src/config.js';

/** A fixed, test-only ring key. Never use it outside tests. */
export const TEST_DATA_KEY = Buffer.alloc(32, 7).toString('base64');

/** The minimum valid environment for loadConfig; spread overrides over it. */
export const testEnv = {
  DATABASE_URL: 'postgres://x@localhost/x',
  DATA_KEYS: `k1:${TEST_DATA_KEY}`,
  DATA_KEY_ID: 'k1',
  PSEUDONYM_KEY: Buffer.alloc(32, 5).toString('base64'),
};

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...testEnv, ...overrides });
}
