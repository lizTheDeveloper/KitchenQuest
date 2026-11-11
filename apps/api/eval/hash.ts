import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * sha256 of the eval's cases, judge, snapshot and runner, as written (fix round 1, M4). The record stores it and the gate
 * checks it, so a case or check changed after the run can't keep passing on stale results.
 */
/** The files that decide a verdict: cases, judge, write snapshot, and the runner (its seeds and write count, fix round 2 N2). */
export const EVAL_FILES: readonly string[] = ['./cases.ts', './checks.ts', './snapshot.ts', './run.ts'];

export function evalHash(): string {
  const h = createHash('sha256');
  for (const f of EVAL_FILES) h.update(f).update('\0').update(readFileSync(new URL(f, import.meta.url))).update('\0');
  return h.digest('hex');
}
