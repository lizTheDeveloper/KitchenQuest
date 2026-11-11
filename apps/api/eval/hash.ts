import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * sha256 of the eval's cases, judge, snapshot and runner, and the turn's decision code, as written (fix round 1, M4). The record stores it and the gate
 * checks it, so a case or check changed after the run can't keep passing on stale results.
 */
/**
 * The files that decide a verdict: cases, judge, write snapshot, and the runner (its seeds and write count, fix round 2
 * N2). M5 Step 8 ruling on eval integrity: also the code that decides a turn's outcome, so a recorded pass always
 * measures the decision code we ship: the API's turn routing, post-checks, plan turn, health gate and output filter,
 * and the core mentor modules they decide with (intents, parse, nonsevere, route, plan-card, and week/plan's
 * resolvePlanRequest). Paths are relative to this file.
 */
export const EVAL_FILES: readonly string[] = [
  './cases.ts',
  './checks.ts',
  './snapshot.ts',
  './run.ts',
  '../src/mentor/turn.ts',
  '../src/mentor/postchecks.ts',
  '../src/mentor/plan-turn.ts',
  '../src/mentor/health.ts',
  '../src/mentor/filter.ts',
  '../../../packages/core/src/mentor/intents.ts',
  '../../../packages/core/src/mentor/parse.ts',
  '../../../packages/core/src/mentor/nonsevere.ts',
  '../../../packages/core/src/mentor/route.ts',
  '../../../packages/core/src/mentor/plan-card.ts',
  '../../../packages/core/src/week/plan.ts',
];

export function evalHash(): string {
  const h = createHash('sha256');
  for (const f of EVAL_FILES) h.update(f).update('\0').update(readFileSync(new URL(f, import.meta.url))).update('\0');
  return h.digest('hex');
}
