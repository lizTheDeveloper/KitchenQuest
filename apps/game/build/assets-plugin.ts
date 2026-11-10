import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin, Rolldown } from 'vite';
import { AssetError, buildAssetManifest } from './assets/manifest';

const VIRTUAL_ID = 'virtual:kq-assets';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const FOLDERS = ['art', 'prototype/art'];

function walk(dir: string, out: string[]): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else out.push(full);
  }
}

/** Every file under art/ and prototype/art/, repo-relative with forward slashes. */
function assetFiles(repoRoot: string): string[] {
  const out: string[] = [];
  for (const f of FOLDERS) walk(join(repoRoot, f), out);
  return out.map((p) => relative(repoRoot, p).split(sep).join('/'));
}

/**
 * `virtual:kq-assets`: `export default { [key]: url }`. Each sprite is a real `?url` import, so Vite hashes
 * and serves it (`no-inline` keeps small sprites out of the JavaScript as data: URLs).
 */
export function kqAssets(opts: { repoRoot: string }): Plugin {
  const { repoRoot } = opts;
  // In dev, a watch file added from `load` becomes an import of the virtual module, and Vite can't import a
  // folder (it 500s the app). The dev server watches the folders itself (configureServer below).
  let serving = false;
  const manifest = (ctx: Rolldown.PluginContext, warn: boolean) => {
    if (!serving) for (const f of FOLDERS) ctx.addWatchFile(join(repoRoot, f));
    try {
      const built = buildAssetManifest(assetFiles(repoRoot));
      if (warn) for (const w of built.warnings) ctx.warn(w);
      return built.entries;
    } catch (e) {
      if (e instanceof AssetError) ctx.error(e.problems.join('\n'));
      throw e;
    }
  };
  return {
    name: 'kq-assets',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    buildStart() {
      manifest(this, true);
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const entries = Object.values(manifest(this, false)).sort((a, b) => a.key.localeCompare(b.key));
      const imports = entries.map((e, i) => `import a${i} from ${JSON.stringify(`${join(repoRoot, e.file)}?url&no-inline`)};`);
      const map = entries.map((e, i) => `  ${JSON.stringify(e.key)}: a${i},`);
      return `${imports.join('\n')}\nexport default {\n${map.join('\n')}\n};\n`;
    },
    configureServer(server) {
      serving = true;
      const dirs = FOLDERS.map((d) => join(repoRoot, d) + sep);
      const refresh = (file: string): void => {
        if (!dirs.some((d) => file.startsWith(d))) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.add(dirs);
      server.watcher.on('change', refresh).on('add', refresh).on('unlink', refresh);
    },
  };
}
