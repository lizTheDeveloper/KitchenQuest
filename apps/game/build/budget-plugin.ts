import type { Plugin } from 'vite';

/**
 * First paint loads the entry chunk and every chunk it statically imports (Vite turns those into the page's
 * modulepreloads), so that total, not the entry alone, must stay under this (minified, before compression).
 */
export const FIRST_PAINT_BUDGET_BYTES = 400 * 1024;

interface ChunkLike { type: 'chunk'; fileName: string; name: string; isEntry: boolean; code: string; imports: string[] }
type BundleLike = Record<string, ChunkLike | { type: 'asset' }>;

const isPhaser = (fileName: string) => /(^|\/)phaser-[^/]*\.js$/.test(fileName); // phaser-* and phaser-game-*

/** The entry chunk and everything it statically imports, followed through every chunk. */
function firstPaintChunks(chunks: ChunkLike[], main: ChunkLike): ChunkLike[] {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const seen = new Set<string>([main.fileName]);
  const out = [main];
  const walk = (c: ChunkLike) => {
    for (const dep of c.imports) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const next = byName.get(dep);
      if (next) { out.push(next); walk(next); }
    }
  };
  walk(main);
  return out;
}

/** What first paint loads for the entry named `entry`: its chunks and their total bytes, or null with no such entry. */
export function firstPaint(bundle: BundleLike, entry: string): { files: string[]; bytes: number } | null {
  const chunks = Object.values(bundle).filter((c): c is ChunkLike => c.type === 'chunk');
  const main = chunks.find((c) => c.isEntry && c.name === entry);
  if (!main) return null;
  const parts = firstPaintChunks(chunks, main);
  return { files: parts.map((c) => c.fileName), bytes: parts.reduce((n, c) => n + Buffer.byteLength(c.code, 'utf8'), 0) };
}

/**
 * Problems with the entry named `entry`: the first-paint total (entry plus its static imports) over budget, the
 * entry being Phaser, or Phaser among its static imports. Phaser may only arrive through a dynamic import.
 */
export function checkFirstPaintBudget(bundle: BundleLike, entry: string): string[] {
  const fp = firstPaint(bundle, entry);
  if (!fp) return [`no entry chunk named "${entry}"`];
  const problems: string[] = [];
  const [main, ...deps] = fp.files;
  if (isPhaser(main)) problems.push(`the entry chunk ${main} is Phaser`);
  for (const dep of deps) if (isPhaser(dep)) problems.push(`the entry chunk ${main} statically imports ${dep}`);
  if (fp.bytes >= FIRST_PAINT_BUDGET_BYTES) {
    problems.push(`first paint loads ${Math.round(fp.bytes / 1024)} KB (${fp.files.join(', ')}), over the 400 KB budget`);
  }
  return problems;
}

/** Fails the build when what first paint loads breaks its budget (see `checkFirstPaintBudget`), and logs the total. */
export function kqFirstPaintBudget(entry = 'index'): Plugin {
  return {
    name: 'kq-first-paint-budget',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const problems = checkFirstPaintBudget(bundle, entry);
      if (problems.length > 0) this.error(`First-paint budget: ${problems.join('; ')}`);
      const fp = firstPaint(bundle, entry);
      if (fp) this.info(`first paint: ${(fp.bytes / 1024).toFixed(1)} KB JS in ${fp.files.length} chunks (budget 400 KB)`);
    },
  };
}
