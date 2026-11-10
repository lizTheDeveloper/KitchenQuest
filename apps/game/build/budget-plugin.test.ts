import { describe, expect, test } from 'vitest';
import { checkEntryBudget, ENTRY_BUDGET_BYTES } from './budget-plugin';

type Chunk = { type: 'chunk'; fileName: string; name: string; isEntry: boolean; code: string; imports: string[]; dynamicImports: string[] };
const chunk = (fileName: string, o: Partial<Chunk> = {}): Chunk =>
  ({ type: 'chunk', fileName, name: fileName.replace(/^assets\//, '').replace(/-.*$/, ''), isEntry: false, code: 'x', imports: [], dynamicImports: [], ...o });
const bundle = (...cs: Chunk[]) => Object.fromEntries(cs.map((c) => [c.fileName, c]));

describe('checkEntryBudget', () => {
  test('the budget is 400 KB', () => { expect(ENTRY_BUDGET_BYTES).toBe(400 * 1024); });

  test('a small entry that only loads Phaser on demand passes', () => {
    const b = bundle(
      chunk('assets/index-a.js', { isEntry: true, imports: ['assets/store-b.js'], dynamicImports: ['assets/phaser-game-c.js'] }),
      chunk('assets/store-b.js'),
      chunk('assets/phaser-game-c.js', { imports: ['assets/phaser-d.js'] }),
      chunk('assets/phaser-d.js', { code: 'p'.repeat(1_200_000) }),
    );
    expect(checkEntryBudget(b, 'index')).toEqual([]);
  });

  test('an entry over 400 KB fails, counting bytes not characters', () => {
    const big = bundle(chunk('assets/index-a.js', { isEntry: true, code: 'é'.repeat(210 * 1024) }));
    expect(checkEntryBudget(big, 'index').join()).toMatch(/over the 400 KB budget/);
  });

  test('an entry that statically imports Phaser, directly or through another chunk, fails', () => {
    const direct = bundle(chunk('assets/index-a.js', { isEntry: true, imports: ['assets/phaser-d.js'] }), chunk('assets/phaser-d.js'));
    expect(checkEntryBudget(direct, 'index').join()).toMatch(/statically imports assets\/phaser-d\.js/);
    const via = bundle(
      chunk('assets/index-a.js', { isEntry: true, imports: ['assets/store-b.js'] }),
      chunk('assets/store-b.js', { imports: ['assets/phaser-d.js'] }), chunk('assets/phaser-d.js'));
    expect(checkEntryBudget(via, 'index').join()).toMatch(/phaser-d\.js/);
  });

  test('an entry that is Phaser, or no entry at all, fails', () => {
    expect(checkEntryBudget(bundle(chunk('assets/phaser-a.js', { isEntry: true, name: 'index' })), 'index').join()).toMatch(/is Phaser/);
    expect(checkEntryBudget(bundle(chunk('assets/store-b.js')), 'index').join()).toMatch(/no entry chunk/);
  });
});
