import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { describe, expect, test } from 'vitest';
import { checkFirstPaintBudget, firstPaint, FIRST_PAINT_BUDGET_BYTES, FIRST_PAINT_TARGET_BYTES, marketChunk } from './budget-plugin';

type Chunk = { type: 'chunk'; fileName: string; name: string; isEntry: boolean; code: string; imports: string[]; dynamicImports: string[]; moduleIds?: string[] };
const chunk = (fileName: string, o: Partial<Chunk> = {}): Chunk =>
  ({ type: 'chunk', fileName, name: fileName.replace(/^assets\//, '').replace(/-.*$/, ''), isEntry: false, code: 'x', imports: [], dynamicImports: [], ...o });
const bundle = (...cs: Chunk[]) => Object.fromEntries(cs.map((c) => [c.fileName, c]));

describe('checkFirstPaintBudget', () => {
  test('the hard budget is 400 KB; the target the build enforces is 360 KB (M6 Step 4 ruling)', () => {
    expect(FIRST_PAINT_BUDGET_BYTES).toBe(400 * 1024);
    expect(FIRST_PAINT_TARGET_BYTES).toBe(360 * 1024);
  });

  test('first paint at 360 KB passes; one byte over fails, naming the target and the hard budget', () => {
    const at = bundle(chunk('assets/index-a.js', { isEntry: true, code: 'a'.repeat(360 * 1024) }));
    expect(checkFirstPaintBudget(at, 'index')).toEqual([]);
    const over = bundle(chunk('assets/index-a.js', { isEntry: true, code: 'a'.repeat(360 * 1024 + 1) }));
    expect(checkFirstPaintBudget(over, 'index').join()).toMatch(/over the 360\.0 KB target \(hard budget 400\.0 KB\)/);
  });

  test('a small entry that only loads Phaser on demand passes', () => {
    const b = bundle(
      chunk('assets/index-a.js', { isEntry: true, imports: ['assets/store-b.js'], dynamicImports: ['assets/phaser-game-c.js'] }),
      chunk('assets/store-b.js'),
      chunk('assets/phaser-game-c.js', { imports: ['assets/phaser-d.js'] }),
      chunk('assets/phaser-d.js', { code: 'p'.repeat(1_200_000) }),
    );
    expect(checkFirstPaintBudget(b, 'index')).toEqual([]);
  });

  test('an entry over 400 KB fails, counting bytes not characters', () => {
    const big = bundle(chunk('assets/index-a.js', { isEntry: true, code: 'é'.repeat(210 * 1024) }));
    expect(checkFirstPaintBudget(big, 'index').join()).toMatch(/first paint loads 420\.0 KB .*over the 360\.0 KB target/);
  });

  test('a small entry whose static imports push the total over 400 KB fails (the carry: not just the entry chunk)', () => {
    const b = bundle(
      chunk('assets/index-a.js', { isEntry: true, code: 'a'.repeat(100 * 1024), imports: ['assets/dom-b.js'] }),
      chunk('assets/dom-b.js', { code: 'b'.repeat(200 * 1024), imports: ['assets/store-c.js'] }),
      chunk('assets/store-c.js', { code: 'c'.repeat(150 * 1024) }),
    );
    expect(checkFirstPaintBudget(b, 'index').join()).toMatch(/first paint loads 450\.0 KB/);
  });

  test('chunks reached only by a dynamic import do not count toward first paint', () => {
    const b = bundle(
      chunk('assets/index-a.js', { isEntry: true, code: 'a'.repeat(100 * 1024), dynamicImports: ['assets/rules-screen-d.js'] }),
      chunk('assets/rules-screen-d.js', { code: 'd'.repeat(500 * 1024) }),
    );
    expect(checkFirstPaintBudget(b, 'index')).toEqual([]);
    expect(firstPaint(b, 'index')).toEqual({ files: ['assets/index-a.js'], bytes: 100 * 1024 });
  });

  test('a shared chunk reached twice is counted once', () => {
    const b = bundle(
      chunk('assets/index-a.js', { isEntry: true, code: 'a', imports: ['assets/x-b.js', 'assets/y-c.js'] }),
      chunk('assets/x-b.js', { code: 'b', imports: ['assets/y-c.js'] }),
      chunk('assets/y-c.js', { code: 'c' }),
    );
    expect(firstPaint(b, 'index')?.bytes).toBe(3);
  });

  test('an entry that statically imports Phaser, directly or through another chunk, fails', () => {
    const direct = bundle(chunk('assets/index-a.js', { isEntry: true, imports: ['assets/phaser-d.js'] }), chunk('assets/phaser-d.js'));
    expect(checkFirstPaintBudget(direct, 'index').join()).toMatch(/statically imports assets\/phaser-d\.js/);
    const via = bundle(
      chunk('assets/index-a.js', { isEntry: true, imports: ['assets/store-b.js'] }),
      chunk('assets/store-b.js', { imports: ['assets/phaser-d.js'] }), chunk('assets/phaser-d.js'));
    expect(checkFirstPaintBudget(via, 'index').join()).toMatch(/phaser-d\.js/);
  });

  test('an entry that is Phaser, or no entry at all, fails', () => {
    expect(checkFirstPaintBudget(bundle(chunk('assets/phaser-a.js', { isEntry: true, name: 'index' })), 'index').join()).toMatch(/is Phaser/);
    expect(checkFirstPaintBudget(bundle(chunk('assets/store-b.js')), 'index').join()).toMatch(/no entry chunk/);
  });

  test('a bundle whose first-paint chunks include the market module fails the budget check', () => {
    const MARKER = '0123456789ab';
    const market = (code = `export default {"version":"${MARKER}","stalls":{}}`) => chunk('assets/market-m.js', { code });
    // Lazy: reached only by a dynamic import (or emitted on its own) — fine, and measured.
    const lazy = bundle(chunk('assets/index-a.js', { isEntry: true, dynamicImports: ['assets/market-m.js'] }), market());
    expect(checkFirstPaintBudget(lazy, 'index', { marketMarker: MARKER })).toEqual([]);
    expect(marketChunk(lazy, MARKER)).toEqual({ files: ['assets/market-m.js'], bytes: Buffer.byteLength(market().code) });
    // Statically imported, directly or through another chunk, or inlined into the entry: fails.
    const direct = bundle(chunk('assets/index-a.js', { isEntry: true, imports: ['assets/market-m.js'] }), market());
    expect(checkFirstPaintBudget(direct, 'index', { marketMarker: MARKER }).join()).toMatch(/first paint loads the market module .*market-m\.js/);
    const via = bundle(chunk('assets/index-a.js', { isEntry: true, imports: ['assets/store-b.js'] }), chunk('assets/store-b.js', { imports: ['assets/market-m.js'] }), market());
    expect(checkFirstPaintBudget(via, 'index', { marketMarker: MARKER }).join()).toMatch(/market-m\.js/);
    const inlined = bundle(chunk('assets/index-a.js', { isEntry: true, code: `const m={"version":"${MARKER}"}` }));
    expect(checkFirstPaintBudget(inlined, 'index', { marketMarker: MARKER }).join()).toMatch(/market module .*index-a\.js/);
  });

  test('a chunk bundling a test, a fixture or a raw data file fails (Step 2 review M4: the fixture in core src/ imports data)', () => {
    for (const id of [
      '/repo/packages/core/src/market/season.fixture.ts',
      '/repo/packages/core/src/market/fixtures.ts',
      '/repo/packages/core/src/market/bank.test.ts',
      '/repo/data/ingredients.json',
      '/repo/data/seasonality.yaml',
    ]) {
      const b = bundle(chunk('assets/index-a.js', { isEntry: true, dynamicImports: ['assets/x-b.js'] }), chunk('assets/x-b.js', { moduleIds: ['/repo/apps/game/src/a.ts', id] }));
      expect(checkFirstPaintBudget(b, 'index').join(), id).toMatch(/must never reach the client/);
    }
    const fine = bundle(chunk('assets/index-a.js', { isEntry: true, moduleIds: ['/repo/packages/core/src/market/season.ts', '\0virtual:kq-content', '/repo/apps/game/src/content/index.ts'] }));
    expect(checkFirstPaintBudget(fine, 'index')).toEqual([]);
  });
});

describe('the real build (M6 Step 5)', () => {
  test('the real build: first paint ≤ 360 KB and no first-paint chunk carries stall content; the market chunk is lazy and measured', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // what `npm run build` ships (as e2e/setup.ts)
    let out: Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
    try {
      // The build's own kq-first-paint-budget plugin runs too, and would fail this build first.
      out = (await build({ root, configLoader: 'runner', logLevel: 'silent', build: { write: false } })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
    }
    const output = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
    const b = Object.fromEntries(output.map((c) => [c.fileName, c.type === 'chunk' ? { ...c, type: 'chunk' as const } : { type: 'asset' as const }]));
    const fp = firstPaint(b, 'index');
    expect(fp).not.toBeNull();
    expect(fp!.bytes).toBeLessThanOrEqual(FIRST_PAINT_TARGET_BYTES);
    // Stall content: lines only a stall file has, and no first-paint chunk holds any of them.
    const stallOnly = ['Price per pound lies; price per serving tells the truth.', 'That onion has made a wise career choice.', 'Local, stored from the autumn harvest'];
    const firstPaintCode = output.filter((c) => c.type === 'chunk' && fp!.files.includes(c.fileName)).map((c) => (c.type === 'chunk' ? c.code : '')).join('\n');
    for (const text of stallOnly) expect(firstPaintCode.includes(text), text).toBe(false);
    // The market chunk exists, holds the stalls, and is not in first paint.
    const market = output.find((c) => c.type === 'chunk' && c.name === 'market');
    expect(market?.type).toBe('chunk');
    if (market?.type !== 'chunk') return;
    expect(fp!.files).not.toContain(market.fileName);
    for (const text of stallOnly) expect(market.code.includes(text), text).toBe(true);
    const kb = Buffer.byteLength(market.code) / 1024;
    console.info(`first paint ${(fp!.bytes / 1024).toFixed(1)} KB; market chunk ${kb.toFixed(1)} KB`);
    expect(kb).toBeGreaterThan(80);
    expect(kb).toBeLessThan(200);
    // And the bundle holds no fixture, test or raw data file.
    expect(output.flatMap((c) => (c.type === 'chunk' ? c.moduleIds : [])).filter((id) => /fixture|\.test\.|\/data\/[^/]+\.(json|ya?ml)$/.test(id))).toEqual([]);
  }, 120_000);
});
