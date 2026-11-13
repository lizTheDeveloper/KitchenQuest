import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** The voice benchmark's record (Step 3), whose `manual[]` holds the operator's browser echo checklist. */
export const BENCH_LATEST = fileURLToPath(new URL('../../voice/bench/latest.json', import.meta.url));
const BROWSERS = ['chromium', 'safari', 'firefox'] as const;

/**
 * M7 Ruling 7 (C9): hands-free with barge-in ships only once echo handling is tested in browsers. `VITE_HANDS_FREE=on`
 * is refused unless `latestPath` records a `manual[]` entry for Chromium, Safari and Firefox, every one of them with
 * `echoBargeInPass: true` (a failure recorded for a browser is never hidden by a pass). null when the build may go on.
 */
export function handsFreeProblem(env: Readonly<Record<string, string | undefined>>, latestPath = BENCH_LATEST): string | null {
  const v = env.VITE_HANDS_FREE;
  if (v === undefined || v === '' || v === 'off') return null;
  if (v !== 'on') return `VITE_HANDS_FREE must be "on" or "off", not "${v}"`;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(latestPath, 'utf8'));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    return missing
      ? `VITE_HANDS_FREE=on: there is no voice benchmark record (${latestPath} latest.json); run the echo checklist first (Ruling 7)`
      : `VITE_HANDS_FREE=on: ${latestPath} cannot be read`;
  }
  const manual = typeof doc === 'object' && doc !== null ? (doc as { manual?: unknown }).manual : undefined;
  if (!Array.isArray(manual)) return 'VITE_HANDS_FREE=on: the voice benchmark record has no manual[] browser echo checklist (Ruling 7)';
  const entries = manual as unknown[];
  for (const browser of BROWSERS) {
    const mine = entries.filter((e) => typeof e === 'object' && e !== null && (e as { browser?: unknown }).browser === browser);
    if (mine.length === 0) return `VITE_HANDS_FREE=on: the echo checklist has no ${browser} entry (Ruling 7)`;
    if (!mine.every((e) => (e as { echoBargeInPass?: unknown }).echoBargeInPass === true)) return `VITE_HANDS_FREE=on: ${browser} did not pass the echo and barge-in checklist (Ruling 7)`;
  }
  return null;
}

export function kqHandsFree(latestPath = BENCH_LATEST): Plugin {
  return {
    name: 'kq-hands-free',
    configResolved(config) {
      if (config.command !== 'build') return;
      const problem = handsFreeProblem(config.env as Record<string, string | undefined>, latestPath);
      if (problem !== null) throw new Error(problem);
    },
  };
}
