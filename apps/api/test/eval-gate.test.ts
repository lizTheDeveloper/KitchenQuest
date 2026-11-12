// M4 Step 12 (spec §7.6b.9, pre-flight C28): the Pan's prompt, tools, model and provider order may only change
// together with a recorded passing eval. No network: this reads eval/last-pass.json, which only
// `npm run eval:mentor` writes. The one skip is MENTOR_EVAL_GATE=skip-no-network, never set in the default CI job.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUEST_PARAMS } from '../src/ai/openrouter.js';
import { loadConfig } from '../src/config.js';
import { loadPanBank } from '../src/mentor/lines.js';
import { loadPanPrompt, promptFingerprint } from '../src/mentor/prompt.js';
import { MENTOR_TOOLS } from '../src/mentor/tools.js';
import { CASES } from '../eval/cases.js';
import { meetsBar, REPS, type EvalResult } from '../eval/checks.js';
import { EVAL_FILES, evalHash } from '../eval/hash.js';
import { testAiEnv } from './helpers/config.js';
import { importClosure } from './helpers/import-closure.js';

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

  it('its results meet the bar: 0 hard fails, ≥ 95% of tool cases correct, 3 runs of all 52 cases (M5 Step 8: + P01–P04; M6 Step 8: + M01–M07)', () => {
    expect(existsSync(LAST_PASS), MESSAGE).toBe(true);
    const { results, date } = JSON.parse(readFileSync(LAST_PASS, 'utf8')) as { results: EvalResult[]; date: string };
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CASES).toHaveLength(52);
    expect(results).toHaveLength(52 * REPS);
    expect(new Set(results.map((r) => r.id))).toEqual(new Set(CASES.map((c) => c.id)));
    const bar = meetsBar(results, CASES);
    expect(bar.problems, MESSAGE).toEqual([]);
    expect(bar.hardFails).toBe(0);
  });

  it('the eval hash is stable and covers the cases, the judge, the snapshot, the runner and the code that decides turn outcomes', () => {
    // M5 Step 8 fix round 4 (N8 ruling): the hashed list is the eval's own files, the computed runtime import closure
    // of the API turn entry (core included, db/ and crypto/ left out), the graph and rule-term data and the canon
    // recipes directory. Recomputed here from the source, so a new decision module can't be missed.
    const eval_ = ['./cases.ts', './checks.ts', './run.ts', './snapshot.ts'];
    const data = ['../../../data/ingredients.json', '../../../data/rule-terms.json', '../../../recipes/'];
    // M5 final review (parked m7): the modules the turn gets through its deps are extra closure roots (the mentor
    // routes, the memory, the recipe index and the catalog), and app.ts, which wires them, is hashed as a file.
    const roots = ['../src/mentor/turn.ts', '../src/mentor/routes.ts', '../src/mentor/memory.ts', '../src/recipes/recipe-index.ts', '../src/catalog.ts'];
    const closure = [...new Set(roots.flatMap((r) => importClosure(fileURLToPath(new URL(r, import.meta.url)))))].map((f) =>
      f.startsWith('apps/api/') ? `../${f.slice('apps/api/'.length)}` : `../../../${f}`,
    );
    expect([...EVAL_FILES].sort()).toEqual([...new Set([...eval_, ...data, ...closure, '../src/app.ts'])].sort());
    for (const f of ['../src/mentor/routes.ts', '../src/mentor/memory.ts', '../src/recipes/recipe-index.ts', '../src/catalog.ts', '../src/app.ts']) expect(EVAL_FILES, f).toContain(f);
    expect(new Set(EVAL_FILES).size).toBe(EVAL_FILES.length);
    // The review's named decision modules are in it (N8).
    for (const f of [
      '../src/mentor/turn.ts', '../src/mentor/postchecks.ts', '../src/mentor/plan-turn.ts', '../src/mentor/health.ts', '../src/mentor/filter.ts',
      '../src/mentor/prompt.ts', '../src/mentor/requests.ts', '../src/mentor/writes.ts',
      '../../../packages/core/src/mentor/intents.ts', '../../../packages/core/src/mentor/route.ts', '../../../packages/core/src/mentor/cards.ts',
      '../../../packages/core/src/mentor/plan-card.ts', '../../../packages/core/src/mentor/saved.ts', '../../../packages/core/src/week/plan.ts',
      '../../../packages/core/src/rules/check.ts', '../../../packages/core/src/rules/types.ts', '../../../packages/core/src/rules/active.ts',
      '../../../packages/core/src/ingredients/graph.ts', '../../../packages/core/src/progress/week.ts', '../../../packages/core/src/toolkit/one-more.ts',
      // M6 Step 8: the check-off decision code, the market content code and the Steps 6–7 progress modules.
      '../../../packages/core/src/mentor/check-off.ts', '../../../packages/core/src/market/index.ts', '../src/mentor/check-off-turn.ts',
      '../src/week/market-service.ts', '../src/progress/seal.ts', '../src/progress/snapshot.ts',
    ]) {
      expect(EVAL_FILES, f).toContain(f);
    }
    // Storage is not a decision.
    expect(EVAL_FILES.some((f) => f.includes('/db/') || f.includes('/crypto/'))).toBe(false);
    expect(evalHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(evalHash()).toBe(evalHash());
  });

  it('the import closure follows barrels by name and skips type-only imports', () => {
    const health = importClosure(fileURLToPath(new URL('../src/mentor/health.ts', import.meta.url)));
    // health.ts imports a value from core (through two barrels) and only a type from catalog.ts.
    expect(health).toContain('packages/core/src/mentor/route.ts');
    expect(health).toContain('packages/core/src/index.ts');
    expect(health).not.toContain('apps/api/src/catalog.ts');
    expect(health).not.toContain('packages/core/src/nutrition/compute.ts');
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
    // M4 final I-3: the request parameters are in it too.
    expect(promptFingerprint(prompt, MENTOR_TOOLS, model, providers, REQUEST_PARAMS)).toBe(base);
    for (const change of [{ temperature: 0.7 }, { max_tokens: 400 }, { reasoning: { enabled: true } }, { tool_choice: 'required' }]) {
      expect(promptFingerprint(prompt, MENTOR_TOOLS, model, providers, { ...REQUEST_PARAMS, ...change }), JSON.stringify(change)).not.toBe(base);
    }
  });
});
