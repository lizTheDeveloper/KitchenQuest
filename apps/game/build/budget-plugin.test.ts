import { describe, expect, test } from 'vitest';
import { checkFirstPaintBudget, firstPaint, FIRST_PAINT_BUDGET_BYTES } from './budget-plugin';

type Chunk = { type: 'chunk'; fileName: string; name: string; isEntry: boolean; code: string; imports: string[]; dynamicImports: string[] };
const chunk = (fileName: string, o: Partial<Chunk> = {}): Chunk =>
  ({ type: 'chunk', fileName, name: fileName.replace(/^assets\//, '').replace(/-.*$/, ''), isEntry: false, code: 'x', imports: [], dynamicImports: [], ...o });
const bundle = (...cs: Chunk[]) => Object.fromEntries(cs.map((c) => [c.fileName, c]));

describe('checkFirstPaintBudget', () => {
  test('the budget is 400 KB', () => { expect(FIRST_PAINT_BUDGET_BYTES).toBe(400 * 1024); });

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
    expect(checkFirstPaintBudget(big, 'index').join()).toMatch(/over the 400 KB budget/);
  });

  test('a small entry whose static imports push the total over 400 KB fails (the carry: not just the entry chunk)', () => {
    const b = bundle(
      chunk('assets/index-a.js', { isEntry: true, code: 'a'.repeat(100 * 1024), imports: ['assets/dom-b.js'] }),
      chunk('assets/dom-b.js', { code: 'b'.repeat(200 * 1024), imports: ['assets/store-c.js'] }),
      chunk('assets/store-c.js', { code: 'c'.repeat(150 * 1024) }),
    );
    expect(checkFirstPaintBudget(b, 'index').join()).toMatch(/first paint loads 450 KB/);
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
});
