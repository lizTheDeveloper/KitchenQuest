// The shipped progress data: data/rewards.yaml and data/techniques.yaml are valid and hold the plan's first values.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { validateRewards, validateTechniques, validateThresholds, type TechniqueNode } from '../src/index';
import { DATA } from '../src/progress/fixtures';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): unknown => parse(readFileSync(`${ROOT}${path}`, 'utf8'));

describe('data/rewards.yaml', () => {
  test('is valid and equals the values the tests use', () => {
    const rewards = read('data/rewards.yaml');
    expect(validateRewards(rewards)).toEqual([]);
    expect(rewards).toEqual(DATA);
  });

  test('M6 Ruling 1: 5 XP per stall question answered correctly the first time, one stall stamp per week', () => {
    const rewards = read('data/rewards.yaml') as { xp: Record<string, unknown>; stamps: Record<string, unknown> };
    expect(rewards.xp.market_game).toBe(5);
    expect(rewards.stamps.market_game).toBe(1);
  });
});

describe('data/techniques.yaml', () => {
  const file = read('data/techniques.yaml') as { freshness: { warm_after_days: number; rusty_after_days: number }; techniques: TechniqueNode[] };
  const byId = new Map(file.techniques.map((t) => [t.id, t]));

  test('the shipped file has no problems', () => {
    expect(validateTechniques(file.techniques)).toEqual([]);
    expect(validateThresholds({ warmAfterDays: file.freshness.warm_after_days, rustyAfterDays: file.freshness.rusty_after_days })).toEqual([]);
  });

  test('the seven launch techniques plus the three frame techniques, with the first adjacency values', () => {
    expect(Object.fromEntries(file.techniques.map((t) => [t.id, { adjacent: t.adjacent, prereqs: t.prereqs }]))).toEqual({
      legumes: { adjacent: ['tempering'], prereqs: [] },
      'heat-control': { adjacent: ['tempering', 'stir-fry', 'quick-sauce'], prereqs: [] },
      tempering: { adjacent: ['quick-sauce'], prereqs: ['heat-control'] },
      grains: { adjacent: ['shaping', 'stir-fry'], prereqs: [] },
      shaping: { adjacent: ['knife'], prereqs: ['grains'] },
      patience: { adjacent: ['emulsion'], prereqs: [] },
      knife: { adjacent: ['emulsion'], prereqs: [] },
      'stir-fry': { adjacent: [], prereqs: ['heat-control', 'grains'] },
      emulsion: { adjacent: [], prereqs: ['knife'] },
      'quick-sauce': { adjacent: [], prereqs: ['heat-control'] },
    });
  });

  test('frijoles de olla alone (legumes, heat-control, patience at Tried) leads to tempering (Step 12 relies on it)', () => {
    const offered = new Set(['legumes', 'heat-control', 'patience'].flatMap((t) => byId.get(t)?.adjacent ?? []));
    expect(offered.has('tempering')).toBe(true);
  });

  test('every canon recipe skill is a technique', () => {
    const recipes = ['india/kerala/parippu.cook', 'japan/osaka/onigiri.cook', 'mexico/oaxaca/frijoles-de-olla.cook'];
    for (const r of recipes) {
      const skills = /^skills: \[(.*)\]$/m.exec(readFileSync(`${ROOT}recipes/${r}`, 'utf8'))?.[1].split(',').map((s) => s.trim()) ?? [];
      expect(skills.length, r).toBeGreaterThan(0);
      for (const s of skills) expect(byId.has(s), `${r}: ${s}`).toBe(true);
    }
  });
});
