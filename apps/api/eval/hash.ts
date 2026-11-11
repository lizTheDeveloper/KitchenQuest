import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * sha256 of the eval's cases and judge, as written (fix round 1, M4). The record stores it and the gate
 * checks it, so a case or check changed after the run can't keep passing on stale results.
 */
export function evalHash(): string {
  const h = createHash('sha256');
  for (const f of ['./cases.ts', './checks.ts', './snapshot.ts']) h.update(f).update('\0').update(readFileSync(new URL(f, import.meta.url))).update('\0');
  return h.digest('hex');
}
