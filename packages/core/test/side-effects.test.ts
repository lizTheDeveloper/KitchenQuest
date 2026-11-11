// Guard for `"sideEffects": false` in packages/core/package.json (M5 Step 9). The game's bundler trusts it to drop any
// core module nothing imports, so first paint stays small. The cost: a top-level side effect in a core module (a
// global listener, a registry filled on import, a polyfill) would be silently tree-shaken away in the game. Core
// modules must stay side-effect free: export functions and constants only. This test pins both halves.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = join(ROOT, 'src');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !/fixtures?\.ts$/.test(p) ? [p] : [];
  });
}

test('core declares itself side-effect free for bundlers', () => {
  expect((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { sideEffects?: unknown }).sideEffects).toBe(false);
});

test('no core module does work at the top level that a bundler could drop (listeners, globals, registries)', () => {
  const files = sources(SRC);
  expect(files.length).toBeGreaterThan(20);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // A statement at column 0 that is a call or an assignment to a global, outside a declaration.
    expect(src, f).not.toMatch(/^(globalThis|window|self|document)\b/m);
    expect(src, f).not.toMatch(/^(addEventListener|setTimeout|setInterval|queueMicrotask)\s*\(/m);
    expect(src, f).not.toMatch(/^[A-Za-z_$][\w$.]*\.(push|set|add|register)\s*\(/m);
  }
});
