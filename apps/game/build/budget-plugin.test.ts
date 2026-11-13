import { describe, expect, test } from 'vitest';
import { checkFirstPaintBudget, firstPaint, FIRST_PAINT_BUDGET_BYTES, FIRST_PAINT_TARGET_BYTES, M7_FIRST_PAINT_CAP_BYTES, marketChunk } from './budget-plugin';

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

  test('no voice module is in the first-paint graph; first paint ≤ 359.6 KB (Step 7 baseline 357.6 KB + 2 KB, ruling round)', () => {
    expect(M7_FIRST_PAINT_CAP_BYTES).toBe(Math.floor(359.6 * 1024));
    // B8, Step 9's measured number, with the talk control's row and Settings → Voice in (the real dist is asserted
    // against the cap in e2e/budget.e2e.test.ts): the Settings copy moved to its lazy module paid for both.
    expect(M7_STEP9_FIRST_PAINT_KB).toBeLessThanOrEqual(M7_FIRST_PAINT_CAP_BYTES / 1024);
    expect(M7_FIRST_PAINT_CAP_BYTES).toBeLessThan(FIRST_PAINT_TARGET_BYTES);
    const at = bundle(chunk('assets/index-a.js', { isEntry: true, code: 'a'.repeat(M7_FIRST_PAINT_CAP_BYTES) }));
    expect(checkFirstPaintBudget(at, 'index', { target: M7_FIRST_PAINT_CAP_BYTES })).toEqual([]);
    const over = bundle(chunk('assets/index-a.js', { isEntry: true, code: 'a'.repeat(M7_FIRST_PAINT_CAP_BYTES + 1) }));
    expect(checkFirstPaintBudget(over, 'index', { target: M7_FIRST_PAINT_CAP_BYTES }).join()).toMatch(/over the 359\.6 KB target/);
    // The voice client lazy: fine. In first paint, directly or through another chunk: fails, naming the module.
    const voice = (fileName: string) => chunk(fileName, { moduleIds: ['/repo/apps/game/src/voice/controller.ts', '/repo/apps/game/src/voice/vad.ts'] });
    const lazy = bundle(chunk('assets/index-a.js', { isEntry: true, dynamicImports: ['assets/voice-v.js'] }), voice('assets/voice-v.js'));
    expect(checkFirstPaintBudget(lazy, 'index')).toEqual([]);
    const direct = bundle(chunk('assets/index-a.js', { isEntry: true, imports: ['assets/voice-v.js'] }), voice('assets/voice-v.js'));
    expect(checkFirstPaintBudget(direct, 'index').join()).toMatch(/first paint loads the voice client .*src\/voice\/controller\.ts.*voice-v\.js/);
    const inlined = bundle(chunk('assets/index-a.js', { isEntry: true, moduleIds: ['/repo/apps/game/src/main.ts', '/repo/apps/game/src/voice/index.ts'] }));
    expect(checkFirstPaintBudget(inlined, 'index').join()).toMatch(/voice client/);
    // Another app's voice path (say core's voice protocol, which first paint may well hold) is not the client.
    const core = bundle(chunk('assets/index-a.js', { isEntry: true, moduleIds: ['/repo/packages/core/src/voice/protocol.ts'] }));
    expect(checkFirstPaintBudget(core, 'index')).toEqual([]);
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

/**
 * M7 Step 9's measured first paint after fix round 1 (KB, `KQ_APP_ORIGIN=https://example.test npm run build`): a record
 * for B8 only. The real gate is e2e/budget.e2e.test.ts, which asserts the built dist against the cap (M-11).
 */
const M7_STEP9_FIRST_PAINT_KB = 358.5;

// The real build's check (first paint ≤ 360 KB, no stall content in it, the market chunk lazy and precached) is
// e2e/budget.e2e.test.ts: it reads the dist/ that e2e/setup.ts builds, instead of a second build here that would
// compete for CPU with the wall-clock tests in this suite.
