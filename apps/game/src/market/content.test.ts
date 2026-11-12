import { keeperLines, type MarketCtx, type Rule } from '@kitchenquest/core/engine';
import { describe, expect, test, vi } from 'vitest';
import { content, graph } from '../content';
import type { MarketContent } from '../content/types';
import { loadMarket, marketLoader } from './content';

const stall = { id: 'x' };
const market = (): MarketContent =>
  ({ stalls: { wen: { ...stall }, bram: { ...stall }, 'okafor-sato': { ...stall }, spice: { ...stall } }, seasonality: { r: { months: { 11: { now: ['kale'] } } } }, version: 'abc' }) as unknown as MarketContent;

describe('loadMarket (M6 Step 5)', () => {
  test('loadMarket imports once and memoises; a failed import rejects (the screen shows its offline line), never a partial bank', async () => {
    const importer = vi.fn(() => Promise.resolve({ default: market() }));
    const load = marketLoader(importer);
    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBe(b);
    expect(await load()).toBe(a);
    expect(importer).toHaveBeenCalledTimes(1);

    // A failed import rejects, and the next call tries again (a retry once online).
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module')).mockResolvedValue({ default: market() });
    const loadFlaky = marketLoader(flaky);
    await expect(loadFlaky()).rejects.toThrow(/dynamically imported/);
    await expect(loadFlaky()).resolves.toMatchObject({ version: 'abc' });
    expect(flaky).toHaveBeenCalledTimes(2);

    // A module missing a stall, the table or its version is refused whole: never a partial bank.
    const partial = market() as unknown as { stalls: Record<string, unknown> };
    delete partial.stalls.spice;
    await expect(marketLoader(() => Promise.resolve({ default: partial as unknown as MarketContent }))()).rejects.toThrow(/missing spice/);
    const noTable = { ...market(), seasonality: null } as unknown as MarketContent;
    await expect(marketLoader(() => Promise.resolve({ default: noTable }))()).rejects.toThrow(/incomplete/);
  });

  test('the content is frozen on load, The Season\'s Table included (Step 2 carry)', async () => {
    const m = await marketLoader(() => Promise.resolve({ default: market() }))();
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.stalls.wen)).toBe(true);
    const months = (m.seasonality as unknown as { r: { months: Record<string, { now: string[] }> } }).r.months;
    expect(Object.isFrozen(months[11].now)).toBe(true);
    expect(() => months[11].now.push('strawberry')).toThrow(TypeError);
  });

  test('the real virtual:kq-market module: all four stalls, the pnw-usa table and a version; frozen', async () => {
    const m = await loadMarket();
    expect(Object.keys(m.stalls).sort()).toEqual(['bram', 'okafor-sato', 'spice', 'wen']);
    expect(Object.keys(m.seasonality)).toEqual(['pnw-usa']);
    expect(m.version).toMatch(/^[0-9a-f]{12}$/);
    expect(Object.isFrozen(m.seasonality['pnw-usa'].categories)).toBe(true);
    expect(await loadMarket()).toBe(m);
  });
});

describe('keeper lines on the shipped stalls (fix round 1, Task 5 ruling 1: what Step 9 uses)', () => {
  const avoid = (...ids: string[]): Rule => ({ id: `r-${ids.join('-')}`, target: { kind: 'category', ids }, type: 'avoid', severity: 'allergy' });
  const ctx = (rules: Rule[]): MarketCtx => ({ rules, graph, subs: content.substitutions, date: '2026-11-12', country: null });
  const CHUCK = "Take your time. The chuck isn't going anywhere. It's had a very hard-working life and it's resting.";
  const RICE = 'Rice in the sack, because Haruka did not ask nicely.';

  test("Bram's \"The chuck isn't going anywhere\" is dropped for a no-beef player; \"Rice in the sack\" under a rice rule", async () => {
    const m = await loadMarket();
    expect(keeperLines(m.stalls.bram, 'idle', ctx([]))).toContain(CHUCK);
    expect(keeperLines(m.stalls.bram, 'idle', ctx([avoid('beef')]))).not.toContain(CHUCK);
    expect(keeperLines(m.stalls.bram, 'idle', ctx([avoid('beef')])).length).toBeGreaterThan(0);
    const greet = (rules: Rule[]) => keeperLines(m.stalls['okafor-sato'], 'greet', ctx(rules)).filter((l) => l.includes(RICE));
    expect(greet([])).toHaveLength(1);
    expect(greet([avoid('rice')])).toEqual([]);
    expect(greet([avoid('rice_grain')])).toEqual([]);
    // Wen's squash greet under a butternut-squash rule; the plums under a plum rule.
    expect(keeperLines(m.stalls.wen, 'greet', ctx([avoid('butternut_squash')])).some((l) => /squash/i.test(l))).toBe(false);
    expect(keeperLines(m.stalls.wen, 'greet', ctx([avoid('plum')])).some((l) => /plums/i.test(l))).toBe(false);
  });
});

