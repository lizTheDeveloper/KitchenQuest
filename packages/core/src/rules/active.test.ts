import { describe, expect, it } from 'vitest';
import { IngredientGraph } from '../ingredients/graph';
import { isActive, validateRules } from './active';
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

describe('isActive', () => {
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
