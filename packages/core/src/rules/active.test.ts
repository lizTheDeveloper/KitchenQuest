import { describe, expect, it } from 'vitest';
import { IngredientGraph } from '../ingredients/graph';
import { isActive, isValidDate, validateRules } from './active';
import type { Rule } from './types';

const graph = IngredientGraph.fromData({
  ingredients: [{ id: 'peanut', name: 'peanut' }, { id: 'soy', name: 'soy' }],
});

const base: Rule = {
  id: 'r1',
  target: { kind: 'ingredient', ids: ['peanut'] },
  type: 'avoid',
  severity: 'allergy',
};

describe('validateRules', () => {
  it('returns [] for a valid rule', () => {
    expect(validateRules([base], graph)).toEqual([]);
  });

  it('reports a target id missing from the graph, naming the rule', () => {
    const problems = validateRules(
      [{ ...base, id: 'bad-target', target: { kind: 'ingredient', ids: ['nope'] } }],
      graph,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('bad-target');
    expect(problems[0]).toContain('nope');
  });

  it('reports an empty target.ids', () => {
    const problems = validateRules(
      [{ ...base, id: 'empty', target: { kind: 'ingredient', ids: [] } }],
      graph,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('empty');
  });

  it('reports a limit rule without a limit', () => {
    const problems = validateRules([{ ...base, id: 'no-limit', type: 'limit' }], graph);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no-limit');
  });

  it('accepts a limit rule with a limit', () => {
    const rule: Rule = { ...base, type: 'limit', limit: { amount: 5, unit: 'g', per: 'day' } };
    expect(validateRules([rule], graph)).toEqual([]);
  });

  it('reports a malformed date', () => {
    const problems = validateRules(
      [{ ...base, id: 'bad-date', phase: { start: '12/01/2026' } }],
      graph,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('bad-date');
  });

  it('reports a well-shaped but non-existent date', () => {
    const problems = validateRules(
      [{ ...base, id: 'feb30', phase: { start: '2026-02-30' } }],
      graph,
    );
    expect(problems).toHaveLength(1);
  });
});

describe('validateRules: deep runtime checks', () => {
  /** Problems for one rule built from `base` with fields overridden as untyped data would be. */
  const problemsFor = (overrides: Record<string, unknown>): string[] =>
    validateRules([{ ...base, ...overrides } as unknown as Rule], graph);
  const limitRule = (limit: Record<string, unknown>) =>
    problemsFor({ id: 'lim', type: 'limit', limit: { amount: 5, unit: 'g', per: 'serving', ...limit } });

  it('reports a phase that ends before it starts, naming the rule', () => {
    const problems = problemsFor({ id: 'backwards', phase: { start: '2026-12-01', end: '2026-11-30' } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('backwards');
    expect(problemsFor({ phase: { start: '2026-12-01', end: '2026-12-01' } })).toEqual([]);
  });

  it("rejects an unknown type ('Avoid')", () => {
    const problems = problemsFor({ id: 'caps', type: 'Avoid' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/caps.*type/);
  });

  it("rejects an unknown severity ('Allergy')", () => {
    const problems = problemsFor({ id: 'sev', severity: 'Allergy' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/sev.*severity/);
  });

  it('rejects an unknown target kind', () => {
    expect(problemsFor({ id: 'kind', target: { kind: 'food', ids: ['peanut'] } })[0]).toMatch(/kind.*target\.kind/);
  });

  it('rejects target.ids that are not a non-empty string array', () => {
    expect(problemsFor({ id: 'ids1', target: { kind: 'ingredient', ids: 'peanut' } })[0]).toMatch(/ids1/);
    expect(problemsFor({ id: 'ids2', target: { kind: 'ingredient', ids: [42] } })[0]).toMatch(/ids2/);
    expect(problemsFor({ id: 'ids3', target: { kind: 'ingredient', ids: [''] } })[0]).toMatch(/ids3/);
    expect(problemsFor({ id: 'ids4', target: null })[0]).toMatch(/ids4/);
  });

  it('rejects a NaN, infinite or negative limit amount', () => {
    for (const amount of [NaN, Infinity, -1, '5']) {
      const problems = limitRule({ amount });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/lim.*amount/);
    }
    expect(limitRule({ amount: 0 })).toEqual([]);
  });

  it('rejects an empty or non-string limit unit', () => {
    expect(limitRule({ unit: '' })[0]).toMatch(/lim.*unit/);
    expect(limitRule({ unit: 5 })[0]).toMatch(/lim.*unit/);
  });

  it("rejects an unknown limit per ('Serving')", () => {
    const problems = limitRule({ per: 'Serving' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/lim.*per/);
  });

  it('rejects a limit object on a rule that is not a limit', () => {
    const problems = problemsFor({ id: 'stray', limit: { amount: 5, unit: 'g', per: 'serving' } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('stray');
  });

  it('rejects duplicate and empty rule ids', () => {
    const dup = validateRules([base, { ...base }], graph);
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatch(/duplicate.*r1/);
    expect(problemsFor({ id: '' })).toHaveLength(1);
    expect(problemsFor({ id: 7 })).toHaveLength(1);
  });

  it('rejects a phase that is not an object with string dates', () => {
    expect(problemsFor({ id: 'p1', phase: 'always' })[0]).toContain('p1');
    expect(problemsFor({ id: 'p2', phase: { start: 20261109 } })[0]).toContain('p2');
  });
});

describe('isValidDate', () => {
  it('accepts real YYYY-MM-DD dates only', () => {
    expect(isValidDate('2026-11-09')).toBe(true);
    expect(isValidDate('2024-02-29')).toBe(true);
    for (const bad of ['2026-02-30', '2026-11-09T12:00:00Z', '6/1/2026', '', '2026-1-9']) {
      expect(isValidDate(bad)).toBe(false);
    }
  });
});

describe('isActive', () => {
  it('throws on an invalid date', () => {
    for (const bad of ['2026-11-09T12:00:00Z', '6/1/2026']) {
      expect(() => isActive(base, bad)).toThrow(new RegExp(bad.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    }
  });

  it('is active with no phase', () => {
    expect(isActive(base, '2026-11-09')).toBe(true);
  });

  it('treats start and end as inclusive', () => {
    const rule: Rule = { ...base, phase: { start: '2026-11-10', end: '2026-12-01' } };
    expect(isActive(rule, '2026-11-09')).toBe(false);
    expect(isActive(rule, '2026-11-10')).toBe(true);
    expect(isActive(rule, '2026-12-01')).toBe(true);
    expect(isActive(rule, '2026-12-02')).toBe(false);
  });

  it('is open-ended without an end', () => {
    const rule: Rule = { ...base, phase: { start: '2026-11-10' } };
    expect(isActive(rule, '2030-01-01')).toBe(true);
    expect(isActive(rule, '2026-11-09')).toBe(false);
  });
});
