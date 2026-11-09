import { join } from 'node:path';
import type { Plugin, Rolldown } from 'vite';
import type { GameContent } from '../src/content/types';
import { compileContent, ContentError } from './content/compile';
import { contentPaths, readContentFiles } from './content/read';

const VIRTUAL_ID = 'virtual:kq-content';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/** Compiles content/, recipes/ and data/ into the `virtual:kq-content` module. Invalid input fails the build. */
export function kqContent(opts: { repoRoot: string }): Plugin {
  const { repoRoot } = opts;
  const compile = (ctx: Rolldown.PluginContext): GameContent => {
    for (const path of contentPaths(repoRoot)) ctx.addWatchFile(join(repoRoot, path));
    try {
      return compileContent(readContentFiles(repoRoot));
    } catch (e) {
      if (e instanceof ContentError) ctx.error(e.problems.join('\n'));
      throw e;
    }
  };
  return {
    name: 'kq-content',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    // Validate up front, so invalid content fails the build even before anything imports the module.
    buildStart() {
      compile(this);
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return `export default ${JSON.stringify(compile(this))};`;
    },
    configureServer(server) {
      // Edits to, and new or removed, input files recompile the module and reload the page.
      const inputs = ['content/', 'recipes/', 'data/'].map((d) => join(repoRoot, d));
      const refresh = (file: string): void => {
        if (!inputs.some((dir) => file.startsWith(dir))) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.add(inputs);
      server.watcher.on('change', refresh).on('add', refresh).on('unlink', refresh);
    },
  };
}
