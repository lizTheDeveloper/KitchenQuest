import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { handsFreeProblem, kqHandsFree } from './hands-free-gate';

const root = fileURLToPath(new URL('..', import.meta.url));
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A latest.json holding `manual` (or no file at all when null). */
function latest(manual: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'kq-hands-free-'));
  dirs.push(dir);
  const path = join(dir, 'latest.json');
  if (manual !== null) writeFileSync(path, JSON.stringify({ id: '2026-11-13-box-0123abcd', manual }));
  return path;
}
const pass = (b: string) => ({ browser: b, echoBargeInPass: true });
const THREE = [pass('chromium'), pass('safari'), pass('firefox')];

describe('kqHandsFree (Ruling 7, C9)', () => {
  test('kqHandsFree: VITE_HANDS_FREE=on fails without latest.json or with any failing browser, and passes with three passes', () => {
    const on = { VITE_HANDS_FREE: 'on' };
    expect(handsFreeProblem(on, latest(null))).toMatch(/no .*latest\.json/);
    expect(handsFreeProblem(on, latest(undefined))).toMatch(/manual\[\]/);
    expect(handsFreeProblem(on, latest([pass('chromium'), pass('safari')]))).toMatch(/firefox/);
    expect(handsFreeProblem(on, latest([pass('chromium'), { browser: 'safari', echoBargeInPass: false }, pass('firefox')]))).toMatch(/safari/);
    // A pass recorded after a failure for the same browser does not hide the failure.
    expect(handsFreeProblem(on, latest([...THREE, { browser: 'chromium', echoBargeInPass: false }]))).toMatch(/chromium/);
    expect(handsFreeProblem(on, latest([pass('chromium'), pass('safari'), { browser: 'firefox', echoBargeInPass: 'yes' }]))).toMatch(/firefox/);
    const garbled = latest(null);
    writeFileSync(garbled, '{not json');
    expect(handsFreeProblem(on, garbled)).toMatch(/cannot be read/);
    expect(handsFreeProblem(on, latest(THREE))).toBeNull();
    // Off (or unset) never reads the file.
    expect(handsFreeProblem({}, latest(null))).toBeNull();
    expect(handsFreeProblem({ VITE_HANDS_FREE: 'off' }, latest(null))).toBeNull();
    expect(handsFreeProblem({ VITE_HANDS_FREE: 'yes' }, latest(THREE))).toMatch(/"on" or "off"/);
  });

  test('the real config refuses `vite build` with VITE_HANDS_FREE=on and no recorded checklist (apps/voice/bench/latest.json)', async () => {
    vi.stubEnv('VITE_HANDS_FREE', 'on');
    vi.stubEnv('KQ_APP_ORIGIN', 'https://example.test');
    await expect(build({ root, logLevel: 'silent', configLoader: 'runner', build: { write: false } })).rejects.toThrow(/VITE_HANDS_FREE/);
    expect(kqHandsFree().name).toBe('kq-hands-free');
  });
});
