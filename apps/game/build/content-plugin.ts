import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin, Rolldown } from 'vite';
import type { ClientContent, GameContent, MarketContent } from '../src/content/types';
import { compileContent, ContentError } from './content/compile';
import { compileMarket, PINS_PATH, type MarketPins } from './content/market';
import { contentPaths, readContentFiles } from './content/read';

const VIRTUAL_ID = 'virtual:kq-content';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
/** The lazy market module (M6 Step 5): only the market screens import it, through src/market/content.ts. */
const MARKET_VIRTUAL_ID = 'virtual:kq-market';
const RESOLVED_MARKET_ID = `\0${MARKET_VIRTUAL_ID}`;

/**
 * What the first-paint module carries: no stalls and no Season's Table (both are in `virtual:kq-market`), and no
 * ingredient provenance (`source`, `fdcId`: no screen reads them; M6 Step 4 ruling, first paint).
 */
function clientContent(content: GameContent): ClientContent {
  const { stalls: _stalls, seasonality: _seasonality, ...client } = content;
  return {
    ...client,
    ingredients: {
      ...client.ingredients,
      ingredients: client.ingredients.ingredients.map(({ source: _source, fdcId: _fdcId, ...node }) => node),
    },
  };
}

/** The module text of each virtual module. */
export const contentModule = (content: GameContent): string => `export default ${JSON.stringify(clientContent(content))};`;
export const marketModule = (market: MarketContent): string => `export default ${JSON.stringify(market)};`;

/** The committed option-order pins (Ruling 2). A missing or unreadable file fails the build. */
export function readPins(repoRoot: string): MarketPins {
  const path = join(repoRoot, PINS_PATH);
  if (!existsSync(path)) throw new ContentError([`${PINS_PATH}: file is missing; run \`npm run content:pin -w @kitchenquest/game\``]);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MarketPins;
  } catch (e) {
    throw new ContentError([`${PINS_PATH}: JSON does not parse: ${e instanceof Error ? e.message : String(e)}`]);
  }
}

/**
 * Compiles content/, recipes/ and data/ into `virtual:kq-content` (first paint) and `virtual:kq-market` (the lazy
 * market chunk). Invalid input fails the build.
 */
export function kqContent(opts: { repoRoot: string }): Plugin {
  const { repoRoot } = opts;
  let version: string | null = null;
  let marketVersion: string | null = null;
  let command: 'build' | 'serve' = 'serve';
  const compile = (ctx: Rolldown.PluginContext): GameContent => {
    for (const path of [...contentPaths(repoRoot), PINS_PATH]) ctx.addWatchFile(join(repoRoot, path));
    try {
      const compiled = compileContent(readContentFiles(repoRoot), { pins: readPins(repoRoot) });
      version = compiled.version;
      marketVersion = compileMarket(compiled).version;
      return compiled;
    } catch (e) {
      if (e instanceof ContentError) ctx.error(e.problems.join('\n'));
      throw e;
    }
  };
  return {
    name: 'kq-content',
    api: {
      /** The last compiled content's version, with the market's: the service worker's cache name (build/sw-plugin.ts). */
      contentVersion: () => (version === null || marketVersion === null ? null : `${version}.${marketVersion}`),
      /** The market module's version. It is in the market chunk's code, so the budget check can find that chunk. */
      marketVersion: () => marketVersion,
    },
    configResolved(config) {
      command = config.command;
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      if (id === MARKET_VIRTUAL_ID) return RESOLVED_MARKET_ID;
      return undefined;
    },
    // Validate up front, so invalid content fails the build even before anything imports the module.
    // In a production build the market module is always its own chunk, named `market`, even before a screen imports
    // it: the service worker precaches it (practice works offline) and the budget check measures it. A screen's
    // `import('virtual:kq-market')` (src/market/content.ts) loads that same chunk.
    buildStart() {
      compile(this);
      if (command === 'build') this.emitFile({ type: 'chunk', id: MARKET_VIRTUAL_ID, name: 'market', preserveSignature: 'strict' });
    },
    load(id) {
      if (id === RESOLVED_ID) return contentModule(compile(this));
      if (id === RESOLVED_MARKET_ID) return marketModule(compileMarket(compile(this)));
      return undefined;
    },
    configureServer(server) {
      // Edits to, and new or removed, input files recompile the modules and reload the page.
      const inputs = ['content/', 'recipes/', 'data/', PINS_PATH].map((d) => join(repoRoot, d));
      const refresh = (file: string): void => {
        if (!inputs.some((dir) => file.startsWith(dir))) return;
        for (const id of [RESOLVED_ID, RESOLVED_MARKET_ID]) {
          const mod = server.moduleGraph.getModuleById(id);
          if (mod) server.moduleGraph.invalidateModule(mod);
        }
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.add(inputs);
      server.watcher.on('change', refresh).on('add', refresh).on('unlink', refresh);
    },
  };
}
