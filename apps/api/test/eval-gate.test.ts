// M4 Step 12 (spec §7.6b.9, pre-flight C28): the Pan's prompt, tools, model and provider order may only change
// together with a recorded passing eval. No network: this reads eval/last-pass.json, which only
// `npm run eval:mentor` writes. The one skip is MENTOR_EVAL_GATE=skip-no-network, never set in the default CI job.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadPanBank } from '../src/mentor/lines.js';
import { loadPanPrompt, promptFingerprint } from '../src/mentor/prompt.js';
import { MENTOR_TOOLS } from '../src/mentor/tools.js';
import { CASES } from '../eval/cases.js';
import { meetsBar, REPS, type EvalResult } from '../eval/checks.js';
import { EVAL_FILES, evalHash } from '../eval/hash.js';
import { testAiEnv } from './helpers/config.js';

const MESSAGE =
  'The Pan\'s prompt, tools, model or provider order changed: run `npm run eval:mentor` against OpenRouter and commit the new eval/last-pass.json (spec §7.6b.9)';
const LAST_PASS = new URL('../eval/last-pass.json', import.meta.url);
const ENV_EXAMPLE = new URL('../../../.env.example', import.meta.url);
const skip = process.env.MENTOR_EVAL_GATE === 'skip-no-network';

/** AI_PROVIDERS exactly as .env.example writes it, and AI_MODEL's default (the config the eval is run with). */
function shippedAi(): { model: string; providers: string[] } {
  const line = readFileSync(ENV_EXAMPLE, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('AI_PROVIDERS='));
  if (line === undefined) throw new Error('.env.example has no AI_PROVIDERS= line');
  // testAiEnv sets no AI_MODEL, so the config's default is used.
  const ai = loadConfig({ ...testAiEnv, AI_PROVIDERS: line.slice('AI_PROVIDERS='.length).trim() }).ai!;
  return { model: ai.model, providers: ai.providers };
}

const fingerprint = () => {
  const { model, providers } = shippedAi();
  return promptFingerprint(loadPanPrompt(loadPanBank()), MENTOR_TOOLS, model, providers);
};

describe('the mentor eval gate', () => {
  if (skip) {
    it.skip('MENTOR_EVAL_GATE=skip-no-network: skipped', () => {});
    console.warn(`MENTOR_EVAL_GATE=skip-no-network: ${MESSAGE}`);
    return;
  }

  it('eval/last-pass.json was recorded for the shipped prompt, tools, model and providers', () => {
    expect(existsSync(LAST_PASS), MESSAGE).toBe(true);
    const record = JSON.parse(readFileSync(LAST_PASS, 'utf8')) as { fingerprint: string; evalHash?: string; model: string; providers: string[] };
    expect(record.fingerprint, MESSAGE).toBe(fingerprint());
    // Fix round 1 (M4): the record was judged by these cases and these checks.
    expect(record.evalHash, MESSAGE).toBe(evalHash());
    const { model, providers } = shippedAi();
    expect({ model: record.model, providers: record.providers }, MESSAGE).toEqual({ model, providers });
  });

  it('its results meet the bar: 0 hard fails, ≥ 95% of tool cases correct, 3 runs of all 41 cases', () => {
    expect(existsSync(LAST_PASS), MESSAGE).toBe(true);
    const { results, date } = JSON.parse(readFileSync(LAST_PASS, 'utf8')) as { results: EvalResult[]; date: string };
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CASES).toHaveLength(41);
    expect(results).toHaveLength(41 * REPS);
    expect(new Set(results.map((r) => r.id))).toEqual(new Set(CASES.map((c) => c.id)));
    const bar = meetsBar(results, CASES);
    expect(bar.problems, MESSAGE).toEqual([]);
    expect(bar.hardFails).toBe(0);
  });

  it('the eval hash is stable and covers the cases, the judge, the snapshot and the runner (seeds, write count)', () => {
    expect([...EVAL_FILES].sort()).toEqual(['./cases.ts', './checks.ts', './run.ts', './snapshot.ts']);
    expect(evalHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(evalHash()).toBe(evalHash());
  });

  it('the fingerprint moves with each input it covers', () => {
    const { model, providers } = shippedAi();
    const prompt = loadPanPrompt(loadPanBank());
    const base = promptFingerprint(prompt, MENTOR_TOOLS, model, providers);
    expect(promptFingerprint(prompt, MENTOR_TOOLS, model, [...providers, 'other'])).not.toBe(base);
    expect(promptFingerprint(prompt, MENTOR_TOOLS, model, ['other', ...providers])).not.toBe(base);
    expect(promptFingerprint(prompt, MENTOR_TOOLS, 'qwen/other', providers)).not.toBe(base);
    expect(promptFingerprint(prompt, MENTOR_TOOLS.slice(1), model, providers)).not.toBe(base);
    expect(promptFingerprint({ ...prompt, system: `${prompt.system} ` }, MENTOR_TOOLS, model, providers)).not.toBe(base);
  });
});
