import type { Plugin } from 'vite';

/** The main entry chunk must stay under this (minified, before compression): the app's first paint waits on it. */
export const ENTRY_BUDGET_BYTES = 400 * 1024;

interface ChunkLike { type: 'chunk'; fileName: string; name: string; isEntry: boolean; code: string; imports: string[] }
type BundleLike = Record<string, ChunkLike | { type: 'asset' }>;

const isPhaser = (fileName: string) => /(^|\/)phaser-[^/]*\.js$/.test(fileName); // phaser-* and phaser-game-*

/**
 * Problems with the entry chunk named `entry`: over budget, Phaser itself, or Phaser among its static imports
 * (followed through every chunk it statically imports). Phaser may only arrive through a dynamic import.
 */
export function checkEntryBudget(bundle: BundleLike, entry: string): string[] {
  const chunks = Object.values(bundle).filter((c): c is ChunkLike => c.type === 'chunk');
  const main = chunks.find((c) => c.isEntry && c.name === entry);
  if (!main) return [`no entry chunk named "${entry}"`];
  const problems: string[] = [];
  if (isPhaser(main.fileName)) problems.push(`the entry chunk ${main.fileName} is Phaser`);
  const bytes = Buffer.byteLength(main.code, 'utf8');
  if (bytes >= ENTRY_BUDGET_BYTES) problems.push(`the entry chunk ${main.fileName} is ${Math.round(bytes / 1024)} KB, over the 400 KB budget`);
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const seen = new Set<string>();
  const walk = (c: ChunkLike) => {
    for (const dep of c.imports) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      if (isPhaser(dep)) problems.push(`the entry chunk ${main.fileName} statically imports ${dep}`);
      const next = byName.get(dep);
      if (next) walk(next);
    }
  };
  walk(main);
  return problems;
}

/** Fails the build when the main entry chunk breaks its budget (see `checkEntryBudget`). */
export function kqEntryBudget(entry = 'index'): Plugin {
  return {
    name: 'kq-entry-budget',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const problems = checkEntryBudget(bundle as unknown as BundleLike, entry);
      if (problems.length > 0) this.error(`Entry chunk budget: ${problems.join('; ')}`);
    },
  };
}
