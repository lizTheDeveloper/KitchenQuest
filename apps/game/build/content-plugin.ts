import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin, Rolldown } from 'vite';
import type { ClientContent, GameContent, MarketContent, SettingsContent } from '../src/content/types';
import { compileContent, ContentError } from './content/compile';
import { compileMarket, parsePinsFile, PINS_PATH, type MarketPins } from './content/market';
import { contentPaths, readContentFiles } from './content/read';

const VIRTUAL_ID = 'virtual:kq-content';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
/** The lazy market module (M6 Step 5): only the market screens import it, through src/market/content.ts. */
const MARKET_VIRTUAL_ID = 'virtual:kq-market';
const RESOLVED_MARKET_ID = `\0${MARKET_VIRTUAL_ID}`;
/**
 * The lazy Settings module (M7 Step 9, first paint): the Settings screen's own copy (`ui.settings.*` in pan.yaml, read
 * only by the lazy Settings screen) and the voice credits (data/voice-models.json). First paint never carries them.
 */
const SETTINGS_VIRTUAL_ID = 'virtual:kq-settings';
const RESOLVED_SETTINGS_ID = `\0${SETTINGS_VIRTUAL_ID}`;
/** Pan triggers that are Settings screen copy: shipped in `virtual:kq-settings`, not in first paint. */
export const SETTINGS_COPY = /^ui\.settings\./;
export const VOICE_MODELS_PATH = 'data/voice-models.json';

/**
 * What the first-paint module carries: no stalls and no Season's Table (both are in `virtual:kq-market`), no
 * ingredient provenance (`source`, `fdcId`) and no writer persona cards (the Pan's and the cooks'): no screen reads
 * them (M6 Step 4 ruling, first paint).
 */
function clientContent(content: GameContent): ClientContent {
  const { stalls: _stalls, seasonality: _seasonality, ...client } = content;
  const { persona: _panPersona, ...pan } = client.pan;
  return {
    ...client,
    pan: { ...pan, triggers: Object.fromEntries(Object.entries(pan.triggers).filter(([id]) => !SETTINGS_COPY.test(id))) },
    cooks: Object.fromEntries(Object.entries(client.cooks).map(([id, { persona: _persona, ...cook }]) => [id, cook])),
    ingredients: {
      ...client.ingredients,
      ingredients: client.ingredients.ingredients.map(({ source: _source, fdcId: _fdcId, ...node }) => node),
    },
  };
}

/** The module text of each virtual module. */
export const contentModule = (content: GameContent): string => `export default ${JSON.stringify(clientContent(content))};`;
export const marketModule = (market: MarketContent): string => `export default ${JSON.stringify(market)};`;

/**
 * Every `allowed` model's credit (Settings → Voice, "Voice credits"): what it is, its licence, its source and the
 * attribution its licence asks for (null when it asks for none). A model of any other status is never listed.
 */
export function voiceCredits(json: string): SettingsContent['voiceCredits'] {
  const problem = (what: string) => new ContentError([`${VOICE_MODELS_PATH}: ${what}`]);
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw problem('is not JSON'); }
  const models = (data as { models?: unknown }).models;
  if (!Array.isArray(models)) throw problem('has no models list');
  return models.flatMap((m: Record<string, unknown>) => {
    if (typeof m.id !== 'string' || typeof m.status !== 'string') throw problem('a model has no id or status');
    if (m.status !== 'allowed') return [];
    const { id, kind, licence, source, attribution } = m;
    if ((kind !== 'stt' && kind !== 'tts') || typeof licence !== 'string' || typeof source !== 'string' || !(attribution === null || typeof attribution === 'string')) {
      throw problem(`model ${id} needs kind, licence, source and attribution (a string or null)`);
    }
    return [{ id, kind, licence, source, attribution }];
  });
}

/** The lazy Settings module's text: the `ui.settings.*` copy and the voice credits. */
export const settingsModule = (content: GameContent, models: string): string => {
  const copy: SettingsContent['copy'] = Object.fromEntries(Object.entries(content.pan.triggers).filter(([id]) => SETTINGS_COPY.test(id)));
  return `export default ${JSON.stringify({ copy, voiceCredits: voiceCredits(models) } satisfies SettingsContent)};`;
};

/** The committed option-order pins (Ruling 2). A missing or unreadable file fails the build. */
export function readPins(repoRoot: string): MarketPins {
  const path = join(repoRoot, PINS_PATH);
  if (!existsSync(path)) throw new ContentError([`${PINS_PATH}: file is missing; run \`npm run content:pin -w @kitchenquest/game\``]);
  try {
    return parsePinsFile(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ContentError([e instanceof Error ? e.message : String(e)]);
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
    for (const path of [...contentPaths(repoRoot), PINS_PATH, VOICE_MODELS_PATH]) ctx.addWatchFile(join(repoRoot, path));
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
      if (id === SETTINGS_VIRTUAL_ID) return RESOLVED_SETTINGS_ID;
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
      if (id === RESOLVED_SETTINGS_ID) {
        const compiled = compile(this);
        try {
          return settingsModule(compiled, readFileSync(join(repoRoot, VOICE_MODELS_PATH), 'utf8'));
        } catch (e) {
          if (e instanceof ContentError) this.error(e.problems.join('\n'));
          throw e;
        }
      }
      return undefined;
    },
    configureServer(server) {
      // Edits to, and new or removed, input files recompile the modules and reload the page.
      const inputs = ['content/', 'recipes/', 'data/', PINS_PATH].map((d) => join(repoRoot, d));
      const refresh = (file: string): void => {
        if (!inputs.some((dir) => file.startsWith(dir))) return;
        for (const id of [RESOLVED_ID, RESOLVED_MARKET_ID, RESOLVED_SETTINGS_ID]) {
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
