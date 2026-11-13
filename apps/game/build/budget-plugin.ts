import type { Plugin } from 'vite';

/** The spec's hard ceiling for first paint (minified, before compression). */
export const FIRST_PAINT_BUDGET_BYTES = 400 * 1024;
/**
 * The milestone's target, which the build enforces (M6 Step 4 ruling: ≤ 360 KB once the graph's provenance fields
 * are stripped, hard budget 400). First paint loads the entry chunk and every chunk it statically imports (Vite turns
 * those into the page's modulepreloads), so that total, not the entry alone, must stay at or under it.
 */
export const FIRST_PAINT_TARGET_BYTES = 360 * 1024;
/**
 * M7 (B8, Step 7 ruling round): voice may grow first paint by at most 2 KB over Step 7's measured 357.6 KB, so Steps 8
 * and 9 build against this cap. The target and the hard budget stay as they are.
 */
export const M7_FIRST_PAINT_CAP_BYTES = Math.floor(359.6 * 1024);
/** The game's voice client (M7 Step 8): a lazy library, reached only by `import('../voice')`. */
const VOICE_CLIENT = /\/apps\/game\/src\/voice\//;

interface ChunkLike { type: 'chunk'; fileName: string; name: string; isEntry: boolean; code: string; imports: string[]; moduleIds?: string[] }
type BundleLike = Record<string, ChunkLike | { type: 'asset' }>;

const isPhaser = (fileName: string) => /(^|\/)phaser-[^/]*\.js$/.test(fileName); // phaser-* and phaser-game-*
const KB = (bytes: number): string => (bytes / 1024).toFixed(1);
const chunksOf = (bundle: BundleLike): ChunkLike[] => Object.values(bundle).filter((c): c is ChunkLike => c.type === 'chunk');
const bytesOf = (cs: readonly ChunkLike[]): number => cs.reduce((n, c) => n + Buffer.byteLength(c.code, 'utf8'), 0);

/**
 * Modules that must never reach the client (M6 Step 2 review M4): test files and fixtures (core's `market/fixtures.ts`
 * and `season.fixture.ts` live in src/ and import data/ingredients.json), and the repo's data files themselves,
 * which reach the client only through the compiled `virtual:kq-*` modules.
 */
const NOT_FOR_THE_CLIENT = /(?:\.test|\.fixtures?|\/fixtures)\.[cm]?[jt]s$|\/test\/|\/data\/[^/]+\.(?:json|ya?ml)$/;

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
  const chunks = chunksOf(bundle);
  const main = chunks.find((c) => c.isEntry && c.name === entry);
  if (!main) return null;
  const parts = firstPaintChunks(chunks, main);
  return { files: parts.map((c) => c.fileName), bytes: bytesOf(parts) };
}

/**
 * The chunks that carry the market module (M6 Step 5), found by its marker (the market content's `version`, a string
 * only that module holds), and their total bytes. null when no chunk carries it.
 */
export function marketChunk(bundle: BundleLike, marker: string): { files: string[]; bytes: number } | null {
  const hits = chunksOf(bundle).filter((c) => c.code.includes(marker));
  return hits.length === 0 ? null : { files: hits.map((c) => c.fileName), bytes: bytesOf(hits) };
}

/**
 * Problems with the entry named `entry`:
 * - the first-paint total (entry plus its static imports) over `target` (default 360 KB; 400 KB is the hard budget);
 * - the entry being Phaser, or Phaser among its static imports (Phaser may only arrive through a dynamic import);
 * - a first-paint chunk carrying the market module (`marketMarker`): the stalls are lazy;
 * - a first-paint chunk bundling the voice client (apps/game/src/voice/): it is lazy too (M7 B8);
 * - any chunk of the bundle holding a test, a fixture or a raw data file (`NOT_FOR_THE_CLIENT`).
 */
export function checkFirstPaintBudget(bundle: BundleLike, entry: string, opts: { marketMarker?: string | null; target?: number } = {}): string[] {
  const fp = firstPaint(bundle, entry);
  if (!fp) return [`no entry chunk named "${entry}"`];
  const target = opts.target ?? FIRST_PAINT_TARGET_BYTES;
  const problems: string[] = [];
  const [main, ...deps] = fp.files;
  if (isPhaser(main)) problems.push(`the entry chunk ${main} is Phaser`);
  for (const dep of deps) if (isPhaser(dep)) problems.push(`the entry chunk ${main} statically imports ${dep}`);
  if (fp.bytes > target) {
    problems.push(`first paint loads ${KB(fp.bytes)} KB (${fp.files.join(', ')}), over the ${KB(target)} KB target (hard budget ${KB(FIRST_PAINT_BUDGET_BYTES)} KB)`);
  }
  const marker = opts.marketMarker;
  if (marker) {
    for (const c of chunksOf(bundle)) {
      if (fp.files.includes(c.fileName) && c.code.includes(marker)) problems.push(`first paint loads the market module (stall content) in ${c.fileName}; it must be a lazy chunk`);
    }
  }
  for (const c of chunksOf(bundle)) {
    if (!fp.files.includes(c.fileName)) continue;
    const voice = (c.moduleIds ?? []).find((id) => VOICE_CLIENT.test(id.replaceAll('\\', '/')));
    if (voice !== undefined) problems.push(`first paint loads the voice client (${voice}) in ${c.fileName}; it must be a lazy chunk`);
  }
  for (const c of chunksOf(bundle)) {
    for (const id of c.moduleIds ?? []) {
      if (NOT_FOR_THE_CLIENT.test(id.replaceAll('\\', '/'))) problems.push(`${c.fileName} bundles ${id}, which must never reach the client (a test, a fixture or a raw data file)`);
    }
  }
  return problems;
}

/**
 * Fails the build when what first paint loads breaks its budget (see `checkFirstPaintBudget`), and logs the total and
 * the market chunk's size. The market marker comes from the kq-content plugin (its `marketVersion`).
 */
export function kqFirstPaintBudget(entry = 'index'): Plugin {
  let marketVersion: (() => string | null) | null = null;
  return {
    name: 'kq-first-paint-budget',
    apply: 'build',
    configResolved(config) {
      const api = config.plugins.find((p) => p.name === 'kq-content')?.api as { marketVersion?: () => string | null } | undefined;
      marketVersion = api?.marketVersion ?? null;
    },
    // Last, after Vite's own generateBundle work (its preload helper rewrites the chunks' code), so the bytes measured
    // are the bytes shipped.
    generateBundle: {
      order: 'post',
      handler(_opts, bundle) {
        const marker = marketVersion?.() ?? null;
        const problems = checkFirstPaintBudget(bundle, entry, { marketMarker: marker, target: M7_FIRST_PAINT_CAP_BYTES });
        const market = marker === null ? null : marketChunk(bundle, marker);
        if (marker === null) problems.push('the kq-content plugin gave no market version, so the market chunk cannot be checked');
        else if (market === null) problems.push('no chunk carries the market module (virtual:kq-market)');
        if (problems.length > 0) this.error(`First-paint budget: ${problems.join('; ')}`);
        const fp = firstPaint(bundle, entry);
        if (fp) this.info(`first paint: ${KB(fp.bytes)} KB JS in ${fp.files.length} chunks (M7 cap ${KB(M7_FIRST_PAINT_CAP_BYTES)} KB, target ${KB(FIRST_PAINT_TARGET_BYTES)} KB, hard budget ${KB(FIRST_PAINT_BUDGET_BYTES)} KB)`);
        if (market) this.info(`market chunk (lazy): ${KB(market.bytes)} KB JS in ${market.files.join(', ')}`);
      },
    },
  };
}
