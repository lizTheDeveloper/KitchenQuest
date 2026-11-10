import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

/** Never precached: the worker itself, source maps, and the sign-in page (it must always come from the network). */
const EXCLUDE: readonly RegExp[] = [/^sw\.js$/, /\.map$/, /^auth\/verify\//, /(^|\/)\./];

/** Every file the worker precaches, '/'-prefixed and sorted. Takes bundle and public-dir file names. */
export function precacheList(bundleFileNames: string[], publicFiles: string[]): string[] {
  const all = [...bundleFileNames, ...publicFiles].filter((f) => !EXCLUDE.some((re) => re.test(f)));
  return [...new Set(all.map((f) => `/${f}`))].sort();
}

/** First 12 hex of sha256 over the sorted precache list plus the compiled content's version. */
export function swVersion(precache: string[], contentVersion: string): string {
  const h = createHash('sha256');
  for (const f of [...precache].sort()) h.update(`${f}\n`);
  h.update(contentVersion);
  return h.digest('hex').slice(0, 12);
}

function walk(dir: string, out: string[]): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else out.push(full);
  }
}

const PRECACHE_TOKEN = 'self.__KQ_PRECACHE__';
const VERSION_TOKEN = '__KQ_VERSION__';

/**
 * Fills in the hand-written service worker (`src/pwa/sw.ts`, built as the `sw` entry to `sw.js`): replaces
 * `self.__KQ_PRECACHE__` with the precache list and `__KQ_VERSION__` with its version. Runs after Vite has
 * emitted index.html, so the list holds every file of the build.
 */
export function kqServiceWorker(): Plugin {
  let publicDir = '';
  let contentVersion: (() => string | null) | null = null;
  return {
    name: 'kq-service-worker',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir;
      const api = config.plugins.find((p) => p.name === 'kq-content')?.api as { contentVersion?: () => string | null } | undefined;
      contentVersion = api?.contentVersion ?? null;
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const sw = Object.values(bundle).find((c) => c.type === 'chunk' && c.name === 'sw');
        if (!sw || sw.type !== 'chunk') { this.error('kq-service-worker: no "sw" chunk in the bundle'); return; }
        const cv = contentVersion?.();
        if (!cv) { this.error('kq-service-worker: the kq-content plugin has not compiled content'); return; }
        const files: string[] = [];
        if (publicDir) walk(publicDir, files);
        const list = precacheList(Object.keys(bundle), files.map((p) => relative(publicDir, p).split(sep).join('/')));
        if (!list.includes('/index.html')) { this.error('kq-service-worker: index.html is missing from the precache'); return; }
        for (const token of [PRECACHE_TOKEN, VERSION_TOKEN]) {
          if (!sw.code.includes(token)) { this.error(`kq-service-worker: ${token} not found in sw.js`); return; }
        }
        sw.code = sw.code
          .replaceAll(PRECACHE_TOKEN, JSON.stringify(list))
          .replaceAll(VERSION_TOKEN, JSON.stringify(swVersion(list, cv)));
      },
    },
  };
}
