import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Never precached: the worker itself, source maps, dotfiles, and anything under /api or /auth (the sign-in
 * page must always come from the network; the worker never holds player data, even by accident).
 */
const EXCLUDE: readonly RegExp[] = [/^sw\.js$/, /\.map$/, /^(api|auth)(\/|$)/, /(^|\/)\./];

/** A Vite asset name without its `-[hash]` and extension: 'assets/vt323-latin-400-normal'. */
const fontStem = (f: string) => f.replace(/-[A-Za-z0-9_-]{8}\.woff2?$/, '');

/**
 * Every file the worker precaches, '/'-prefixed and sorted. Takes bundle and public-dir file names. A `.woff`
 * is dropped when the same font ships as `.woff2`: every browser that runs the worker reads woff2.
 */
export function precacheList(bundleFileNames: string[], publicFiles: string[]): string[] {
  const all = [...bundleFileNames, ...publicFiles].filter((f) => !EXCLUDE.some((re) => re.test(f)));
  const woff2 = new Set(all.filter((f) => f.endsWith('.woff2')).map(fontStem));
  const kept = all.filter((f) => !(f.endsWith('.woff') && woff2.has(fontStem(f))));
  return [...new Set(kept.map((f) => `/${f}`))].sort();
}

/**
 * First 12 hex of sha256 over the sorted precache list, the compiled content's version, and the bytes of the
 * files whose names carry no hash (index.html, public files, the worker's own code), so changing any of them
 * yields a new sw.js and a new cache.
 */
export function swVersion(precache: string[], contentVersion: string, bytes: Readonly<Record<string, string | Uint8Array>> = {}): string {
  const h = createHash('sha256');
  for (const f of [...precache].sort()) h.update(`${f}\n`);
  h.update(contentVersion);
  for (const k of Object.keys(bytes).sort()) {
    h.update(`\0${k}\0`);
    h.update(bytes[k]);
  }
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
        const html = bundle['index.html'] as (typeof bundle)[string] | undefined;
        if (!list.includes('/index.html') || html?.type !== 'asset') { this.error('kq-service-worker: index.html is missing from the precache'); return; }
        const bytes: Record<string, string | Uint8Array> = { '/index.html': html.source, 'sw.js': sw.code };
        for (const p of files) bytes[`/${relative(publicDir, p).split(sep).join('/')}`] = readFileSync(p);
        for (const token of [PRECACHE_TOKEN, VERSION_TOKEN]) {
          if (!sw.code.includes(token)) { this.error(`kq-service-worker: ${token} not found in sw.js`); return; }
        }
        sw.code = sw.code
          .replaceAll(PRECACHE_TOKEN, JSON.stringify(list))
          .replaceAll(VERSION_TOKEN, JSON.stringify(swVersion(list, cv, bytes)));
      },
    },
  };
}
