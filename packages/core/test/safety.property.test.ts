import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER, IngredientGraph, SEVERE, check, parseRecipe } from '../src/index';
import type { IngredientData, Rule, Severity, Substitution } from '../src/index';

/**
 * Property tests for the spec's core promise (§12): a recipe containing an ingredient under an
 * active avoid rule can never come back `ok`. Run over the real seed graph and substitutions.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const data = readJson('data/ingredients.json') as IngredientData;
const subs = readJson('data/substitutions.json') as Substitution[];
const graph = IngredientGraph.fromData(data);

const NUM_RUNS = 500;
const ALL_IDS = data.ingredients.map((n) => n.id);
const SEVERITIES: Severity[] = ['anaphylactic', 'allergy', 'intolerance', 'preference'];
const SEVERE_SEVERITIES = SEVERITIES.filter((s) => SEVERE.has(s));
const MILD_SEVERITIES = SEVERITIES.filter((s) => !SEVERE.has(s));

/** Every id reachable from `id` over isA ∪ contains, including `id` itself (pathTo(x, x) is [x]). */
function ancestors(id: string): string[] {
  const seen = new Set<string>([id]);
  const queue = [id];
  for (let i = 0; i < queue.length; i++) {
    const node = graph.get(queue[i]!);
    for (const next of [...(node.isA ?? []), ...(node.contains ?? [])]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

// --- dates -----------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const BASE_MS = Date.UTC(2026, 0, 1);
const iso = (dayOffset: number) => new Date(BASE_MS + dayOffset * DAY_MS).toISOString().slice(0, 10);

/** A check date as a day offset from 2026-01-01, so phases can be placed around it. */
const dayArb = fc.integer({ min: 0, max: 3 * 365 });

/** No phase, or a phase containing `day` (start and end inclusive, end optional). */
const activePhaseArb = (day: number): fc.Arbitrary<Rule['phase']> =>
  fc.oneof(
    fc.constant(undefined),
    fc
      .record({ before: fc.nat({ max: 400 }), after: fc.option(fc.nat({ max: 400 }), { nil: undefined }) })
      .map(({ before, after }) =>
        after === undefined ? { start: iso(day - before) } : { start: iso(day - before), end: iso(day + after) },
      ),
  );

/** A phase that ended strictly before `day`. */
const endedPhaseArb = (day: number): fc.Arbitrary<NonNullable<Rule['phase']>> =>
  fc
    .record({ endedDaysAgo: fc.integer({ min: 1, max: 400 }), length: fc.nat({ max: 400 }) })
    .map(({ endedDaysAgo, length }) => ({
      start: iso(day - endedDaysAgo - length),
      end: iso(day - endedDaysAgo),
    }));

// --- recipes ---------------------------------------------------------------------------------

type Line = { name: string; amount: string };

/** Cooklang source with valid front matter; every ingredient uses the `@name{...}` brace form. */
function cook(lines: Line[], servings: number): string {
  const body = lines.map((l) => `Add @${l.name}{${l.amount}}.`).join('\n');
  return `---
title: Property Dish
country: Testland
region: Test Region
credit: Property Tester
cook: Property Tester
difficulty: 3
skills: [stirring]
servings: ${servings}
license: CC-BY-SA-4.0
status: draft
---

${body}
`;
}

const servingsArb = fc.integer({ min: 1, max: 8 });

/** Ways people write a name: as is, shouted, title case, or with a doubled space. */
const SPELLINGS: ((name: string) => string)[] = [
  (n) => n,
  (n) => n.toUpperCase(),
  (n) => n.replace(/(^|\s)(\S)/g, (_, gap: string, c: string) => gap + c.toUpperCase()),
  (n) => n.replace(' ', '  '),
];
/** `name` as written, usually unchanged, sometimes respelled. */
const spellingArb = (name: string): fc.Arbitrary<string> =>
  fc.oneof({ weight: 3, arbitrary: fc.constant(name) }, { weight: 1, arbitrary: fc.constantFrom(...SPELLINGS).map((f) => f(name)) });
/** A name for ingredient `id`: its name or one of its aliases, sometimes respelled. */
const nameForArb = (id: string): fc.Arbitrary<string> => {
  const node = graph.get(id);
  return fc.constantFrom(node.name, ...(node.aliases ?? [])).chain(spellingArb);
};
/** Names for each of `ids`, in order. */
const namesForArb = (ids: string[]): fc.Arbitrary<string[]> => fc.tuple(...ids.map(nameForArb));

/** Names people might write: canonical names, aliases, and names the graph doesn't know. */
const KNOWN_NAMES = data.ingredients.flatMap((n) => [n.name, ...(n.aliases ?? [])]);
const UNKNOWN_NAMES = ['dragon fruit', 'mystery spice', 'unicorn tears'];
const amountArb = fc.oneof(
  fc.constant(''),
  fc.integer({ min: 1, max: 500 }).map((q) => `${q}%g`),
  fc.integer({ min: 1, max: 20 }).map((q) => `${q}%tsp`),
  fc.integer({ min: 1, max: 6 }).map(String),
);

/** Any recipe: 1–8 lines drawn from known and unknown names, with varied amounts. */
const anyRecipeArb = fc
  .record({
    names: fc.uniqueArray(fc.constantFrom(...KNOWN_NAMES, ...UNKNOWN_NAMES), {
      minLength: 1,
      maxLength: 8,
      // Two names resolving to the same id would just repeat an ingredient; keep lines distinct.
      selector: (name) => graph.resolve(name) ?? name,
    }),
    amounts: fc.array(amountArb, { minLength: 8, maxLength: 8 }),
    servings: servingsArb,
  })
  .chain(({ names, amounts, servings }) =>
    fc.tuple(...names.map(spellingArb)).map((written) =>
      parseRecipe(cook(written.map((name, i) => ({ name, amount: amounts[i]! })), servings)),
    ),
  );

// --- rules -----------------------------------------------------------------------------------

/**
 * Seed substitutions are few, so uniform picks rarely exercise them. Bias recipe ids toward
 * substitution sources, and rule targets toward what substitution replacements reach, the
 * `unsafeFor` ids, and wheat and fish (whose swaps, tamari and shio kombu, are label-dependent).
 * That way swap candidates are regularly offered and regularly rejected for each reason.
 */
const SUB_FROM = [...new Set(subs.map((s) => s.from))];
const SUB_TARGET_BIAS = [
  ...new Set([...subs.flatMap((s) => [...ancestors(s.to), ...(s.unsafeFor ?? [])]), 'wheat', 'fish']),
];
const recipeIdArb = fc.oneof(fc.constantFrom(...ALL_IDS), fc.constantFrom(...SUB_FROM));
const targetIdArb = fc.oneof(fc.constantFrom(...ALL_IDS), fc.constantFrom(...SUB_TARGET_BIAS));
const targetIdsArb = fc.uniqueArray(targetIdArb, { minLength: 1, maxLength: 3 });
const kindArb = fc.constantFrom<Rule['target']['kind']>('ingredient', 'category', 'component');

/** Any rule body (no id, no phase): avoid, prefer, or a per-serving / per-day limit. */
const ruleBodyArb = (severityArb: fc.Arbitrary<Severity>): fc.Arbitrary<Omit<Rule, 'id' | 'phase'>> =>
  fc.record({ ids: targetIdsArb, kind: kindArb, severity: severityArb }).chain(({ ids, kind, severity }) => {
    const base = { target: { kind, ids }, severity };
    return fc.oneof(
      fc.constant({ ...base, type: 'avoid' as const }),
      fc.constant({ ...base, type: 'prefer' as const }),
      fc
        .record({
          amount: fc.integer({ min: 1, max: 100 }),
          unit: fc.constantFrom('g', 'tsp'),
          per: fc.constantFrom<'serving' | 'day'>('serving', 'day'),
        })
        .map((limit) => ({ ...base, type: 'limit' as const, limit })),
    );
  });

const activeRulesArb = (day: number, maxLength: number, severities = SEVERITIES): fc.Arbitrary<Rule[]> =>
  fc
    .array(fc.record({ body: ruleBodyArb(fc.constantFrom(...severities)), phase: activePhaseArb(day) }), {
      maxLength,
    })
    .map((rs) => rs.map(({ body, phase }, i) => withPhase({ id: `rule-${i}`, ...body }, phase)));

function withPhase(rule: Rule, phase: Rule['phase']): Rule {
  return phase === undefined ? rule : { ...rule, phase };
}

// --- properties ------------------------------------------------------------------------------

describe('safety properties (seed graph)', () => {
  it('avoid rule never ok', () => {
    const arb = fc
      .record({
        ids: fc.uniqueArray(recipeIdArb, { minLength: 1, maxLength: 8 }),
        servings: servingsArb,
        day: dayArb,
        severity: fc.constantFrom(...SEVERITIES),
        kind: kindArb,
      })
      .chain(({ ids, servings, day, severity, kind }) =>
        fc.record({
          ids: fc.constant(ids),
          names: namesForArb(ids),
          servings: fc.constant(servings),
          day: fc.constant(day),
          // The avoid target: an ancestor (or the ingredient itself) of one included ingredient.
          target: fc.constantFrom(...ids).chain((id) => fc.constantFrom(...ancestors(id))),
          avoid: activePhaseArb(day).map((phase) =>
            withPhase({ id: 'avoid-under-test', target: { kind, ids: [] }, type: 'avoid', severity }, phase),
          ),
          others: activeRulesArb(day, 3),
        }),
      );

    fc.assert(
      fc.property(arb, ({ ids, names, servings, day, target, avoid, others }) => {
        const recipe = parseRecipe(cook(names.map((name) => ({ name, amount: '1%g' })), servings));
        // Precondition: the recipe really contains the ingredients we generated.
        expect(recipe.ingredients.map((i) => graph.resolve(i.name))).toEqual(ids);

        const rule: Rule = { ...avoid, target: { ...avoid.target, ids: [target] } };
        const rules = [rule, ...others];
        const date = iso(day);
        const result = check(recipe, rules, graph, subs, date);

        expect(result.status).not.toBe('ok');
        // ...and the reason is the avoid rule itself, on an included ingredient that reaches it.
        expect(
          result.findings.some(
            (f) =>
              f.ruleId === rule.id &&
              f.kind === 'match' &&
              f.ingredientId !== null &&
              ids.includes(f.ingredientId) &&
              graph.pathTo(f.ingredientId, target) !== null,
          ),
        ).toBe(true);

        // The brief asks this when the status is `swap`; checking every offered swap, whatever the
        // overall status, is stronger (a swap can sit beside an unverified or blocked finding).
        // Every generated rule is active by construction. Prefer rules and per-day limits produce
        // no findings, so only avoid and per-serving limit targets restrict a swap.
        const byId = new Map(rules.map((r) => [r.id, r]));
        const restrictingTargets = rules
          .filter((r) => r.type === 'avoid' || (r.type === 'limit' && r.limit?.per === 'serving'))
          .flatMap((r) => r.target.ids);
        for (const f of result.findings) {
          if (!f.swap) continue;
          const toId = f.swap.toId;
          // The replacement reaches no restricting target...
          for (const t of restrictingTargets) expect(graph.pathTo(toId, t)).toBeNull();
          // ...is not itself "check the label"...
          expect(graph.get(toId).labelDependent).not.toBe(true);
          // ...and is not marked unsafe for any target of a rule that hit this ingredient.
          const sub = subs.find((s) => s.from === f.ingredientId && s.to === toId);
          expect(sub).toBeDefined();
          const hitTargets = result.findings
            .filter((g) => g.ingredientId === f.ingredientId && g.ruleId !== undefined)
            .flatMap((g) => byId.get(g.ruleId!)!.target.ids);
          for (const unsafe of sub!.unsafeFor ?? []) expect(hitTargets).not.toContain(unsafe);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a rule on a kind of an included ingredient is never ok', () => {
    // A category line ("nuts") could be any of its isA descendants (peanuts), so a rule on one of
    // them can't be verified safe. Recipes always include at least one ingredient that has kinds.
    const withKinds = ALL_IDS.filter((id) => graph.descendants(id).length > 0);
    const arb = fc
      .record({
        category: fc.constantFrom(...withKinds),
        rest: fc.uniqueArray(recipeIdArb, { maxLength: 6 }),
        servings: servingsArb,
        day: dayArb,
        severity: fc.constantFrom(...SEVERITIES),
        kind: kindArb,
      })
      .chain(({ category, rest, servings, day, severity, kind }) => {
        const ids = [category, ...rest.filter((id) => id !== category)];
        return fc.record({
          ids: fc.constant(ids),
          names: namesForArb(ids),
          amounts: fc.array(amountArb, { minLength: ids.length, maxLength: ids.length }),
          servings: fc.constant(servings),
          day: fc.constant(day),
          // The target: an isA descendant (a kind) of the category ingredient.
          target: fc.constantFrom(...graph.descendants(category)),
          rule: fc.record({
            phase: activePhaseArb(day),
            limit: fc.option(
              fc.record({
                amount: fc.integer({ min: 0, max: 1000 }),
                unit: fc.constantFrom('g', 'tsp'),
                per: fc.constant<'serving'>('serving'),
              }),
              { nil: undefined },
            ),
          }),
          others: activeRulesArb(day, 3),
          kind: fc.constant(kind),
          severity: fc.constant(severity),
        });
      });

    fc.assert(
      fc.property(arb, ({ ids, names, amounts, servings, day, target, rule: shape, others, kind, severity }) => {
        const recipe = parseRecipe(cook(names.map((name, i) => ({ name, amount: amounts[i]! })), servings));
        expect(recipe.ingredients.map((i) => graph.resolve(i.name))).toEqual(ids);

        const base = { id: 'kind-under-test', target: { kind, ids: [target] }, severity };
        const body: Rule =
          shape.limit === undefined ? { ...base, type: 'avoid' } : { ...base, type: 'limit', limit: shape.limit };
        const rule = withPhase(body, shape.phase);
        const result = check(recipe, [rule, ...others], graph, subs, iso(day));

        expect(result.status).not.toBe('ok');
        expect(
          result.findings.some((f) => f.ruleId === rule.id && f.ingredientId !== null && ids.includes(f.ingredientId)),
        ).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('severe always carries the disclaimer', () => {
    const arb = dayArb.chain((day) =>
      fc.record({
        recipe: anyRecipeArb,
        day: fc.constant(day),
        severe: fc.record({ body: ruleBodyArb(fc.constantFrom(...SEVERE_SEVERITIES)), phase: activePhaseArb(day) }),
        others: activeRulesArb(day, 3),
        inactive: fc.array(fc.record({ body: ruleBodyArb(fc.constantFrom(...SEVERITIES)), phase: endedPhaseArb(day) }), {
          maxLength: 2,
        }),
      }),
    );

    fc.assert(
      fc.property(arb, ({ recipe, day, severe, others, inactive }) => {
        const rules: Rule[] = [
          withPhase({ id: 'severe-under-test', ...severe.body }, severe.phase),
          ...others,
          ...inactive.map(({ body, phase }, i) => ({ id: `ended-${i}`, ...body, phase })),
        ];
        const result = check(recipe, rules, graph, subs, iso(day));
        expect(result.severe).toBe(true);
        expect(result.disclaimer).toBe(DISCLAIMER);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('no active severe rule means no disclaimer', () => {
    const arb = dayArb.chain((day) =>
      fc.record({
        recipe: anyRecipeArb,
        day: fc.constant(day),
        mild: activeRulesArb(day, 4, MILD_SEVERITIES),
        ended: fc.array(fc.record({ body: ruleBodyArb(fc.constantFrom(...SEVERITIES)), phase: endedPhaseArb(day) }), {
          maxLength: 2,
        }),
      }),
    );

    fc.assert(
      fc.property(arb, ({ recipe, day, mild, ended }) => {
        const rules: Rule[] = [...mild, ...ended.map(({ body, phase }, i) => ({ id: `ended-${i}`, ...body, phase }))];
        const result = check(recipe, rules, graph, subs, iso(day));
        expect(result.severe).toBe(false);
        expect(result.disclaimer).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('inactive rules change nothing', () => {
    const arb = dayArb.chain((day) =>
      fc.record({
        recipe: anyRecipeArb,
        day: fc.constant(day),
        ended: fc.record({ body: ruleBodyArb(fc.constantFrom(...SEVERITIES)), phase: endedPhaseArb(day) }),
      }),
    );

    fc.assert(
      fc.property(arb, ({ recipe, day, ended }) => {
        const date = iso(day);
        const rule: Rule = { id: 'ended-under-test', ...ended.body, phase: ended.phase };
        expect(check(recipe, [rule], graph, subs, date)).toEqual(check(recipe, [], graph, subs, date));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('inactive rules change nothing alongside active rules', () => {
    const arb = dayArb.chain((day) =>
      fc.record({
        recipe: anyRecipeArb,
        day: fc.constant(day),
        active: activeRulesArb(day, 3),
        ended: fc.record({ body: ruleBodyArb(fc.constantFrom(...SEVERITIES)), phase: endedPhaseArb(day) }),
      }),
    );

    fc.assert(
      fc.property(arb, ({ recipe, day, active, ended }) => {
        const date = iso(day);
        const rule: Rule = { id: 'ended-under-test', ...ended.body, phase: ended.phase };
        expect(check(recipe, [...active, rule], graph, subs, date)).toEqual(
          check(recipe, active, graph, subs, date),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
