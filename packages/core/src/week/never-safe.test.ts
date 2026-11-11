// Spec §2.2 as a property: whatever the plan, frame or margin note, a dish that holds an ingredient under an avoid rule
// is never ✅, and no market row or frame filler is something the rules block.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { checkWithNotes } from '../book/margin-notes';
import { check } from '../rules/check';
import type { Rule, Severity } from '../rules/types';
import { canon, dish, graph, planCtx, STALLS, subs } from './fixtures';
import { fillFrame, type Frame } from './frames';
import { marketList } from './market-list';
import { checkPlan, suggestPlan, type Plan } from './plan';

const DAY = '2026-11-11';
const ids = graph.labels().map((l) => graph.resolve(l)!).filter((id, i, all) => all.indexOf(id) === i).sort();
const nameOf = (id: string): string => graph.get(id).name;
const SEVERITIES: Severity[] = ['anaphylactic', 'allergy', 'intolerance', 'preference'];

/** An ingredient X and an avoid rule on X itself or on something X is or contains (so X is under the rule). */
const underRule = fc
  .constantFrom(...ids)
  .chain((x) => {
    const targets = ids.filter((t) => graph.pathTo(x, t) !== null);
    return fc.record({ x: fc.constant(x), target: fc.constantFrom(...targets), severity: fc.constantFrom(...SEVERITIES) });
  })
  .map(({ x, target, severity }) => ({ x, rule: { id: 'r-prop', target: { kind: 'ingredient', ids: [target] }, type: 'avoid', severity } satisfies Rule }));
const others = fc.array(fc.constantFrom(...ids), { maxLength: 4 });
const day = fc.integer({ min: 0, max: 6 });

describe('never safe', () => {
  test('property: any plan/frame/notes containing an ingredient under an avoid rule is never ok', () => {
    fc.assert(
      fc.property(underRule, others, day, fc.integer({ min: 1, max: 7 }), ({ x, rule }, rest, d, n) => {
        const names = [nameOf(x), ...rest.map(nameOf)];
        const recipes = new Map([['test/prop', dish('leela', names)]]);
        const ctx = planCtx({ recipes, rules: [rule], weekStart: '2026-11-09' });
        const plan: Plan = { weekStart: ctx.weekStart, items: [{ day: d, kind: 'dish', slug: 'test/prop', servings: 2 }], hard: false, slot: 'unanswered' };

        // Plan: the item is never ✅, and pick never offers anything that isn't ✅ or a labelled swap.
        expect(checkPlan(plan, ctx)[0].status).not.toBe('ok');
        for (const c of checkPlan({ ...plan, items: suggestPlan(n, ctx) }, ctx)) expect(['ok', 'swap']).toContain(c.status);

        // Market list: no row is something the rules block.
        for (const row of marketList(plan, ctx, [], STALLS)) {
          expect(check({ ...recipes.get('test/prop')!, ingredients: [{ name: row.name, displayName: null, quantity: null, unit: null, note: null }] }, [rule], graph, subs, '2026-11-09').status).not.toBe('blocked');
        }

        // Frame: a slot that accepts X, with X in the pantry; X used → never ✅; X never chosen when it alone is ⛔.
        const frame: Frame = {
          id: 'prop', title: 'Prop', technique: 'stir-fry', status: 'draft', credit: 'test',
          slots: [{ key: 'a', accepts: [x], optional: false }, { key: 'b', accepts: ids, optional: true }],
          steps: ['{a} {b}'], rescues: [],
        };
        const pantry = names.map((name) => ({ name, ingredientId: graph.resolve(name) }));
        for (const pick of [undefined, { a: nameOf(x) }]) {
          const f = fillFrame(frame, pantry, { rules: [rule], graph, subs, today: DAY }, pick);
          if (f.recipe.ingredients.some((i) => graph.resolve(i.name) === x)) expect(f.check.status).not.toBe('ok');
          for (const fill of Object.values(f.fills)) {
            if (fill) expect(check({ ...f.recipe, ingredients: [{ name: fill.name, displayName: null, quantity: null, unit: null, note: null }] }, [rule], graph, subs, DAY).status).not.toBe('blocked');
          }
        }

        // Margin notes: adding X, or swapping any canon line to X, is never ✅.
        for (const r of canon.values()) {
          expect(checkWithNotes(r, [{ recipe: 'x', ops: [{ op: 'add', name: nameOf(x) }], text: null, at: DAY }], [rule], graph, subs, DAY).status).not.toBe('ok');
          const from = r.ingredients[d % r.ingredients.length].name;
          expect(checkWithNotes(r, [{ recipe: 'x', ops: [{ op: 'swap', from, to: nameOf(x) }], text: null, at: DAY }], [rule], graph, subs, DAY).status).not.toBe('ok');
        }
      }),
      { numRuns: 300 },
    );
  });
});
