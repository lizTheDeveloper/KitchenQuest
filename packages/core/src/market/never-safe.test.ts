// Spec §2.2 and §3.5 as a property: whatever the player's rules, no question a stall bank returns names anything (in
// its contains or in any of its text) that the rules engine reports blocked or unverified, checked on its own with no
// substitutions; no tip shown is for such an item; and no FAQ answer shown names one, unless it is the safety line.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { textMentions } from '../ingredients/mentions';
import { check } from '../rules/check';
import type { Rule, Severity } from '../rules/types';
import { faqFor, stallBank, tipFor } from './bank';
import { ALLERGEN_LINE, BRAM, DAY, graph, MEDICAL_LINE, question, SEASONAL_STRAWBERRY, SPICE, subs, WEN } from './fixtures';
import type { StallFile, StallQuestion } from './types';

const ids = [...new Set(graph.labels().map((l) => graph.resolve(l)!))].sort();
const nameOf = (id: string): string => graph.get(id).name;
const SEVERITIES: Severity[] = ['anaphylactic', 'allergy', 'intolerance', 'preference'];

const ruleArb = fc.record({
  target: fc.uniqueArray(fc.constantFrom(...ids), { minLength: 1, maxLength: 3 }),
  kind: fc.constantFrom('ingredient' as const, 'category' as const, 'component' as const),
  type: fc.constantFrom('avoid' as const, 'avoid' as const, 'limit' as const, 'prefer' as const),
  severity: fc.constantFrom(...SEVERITIES),
});
const rulesArb = fc.array(ruleArb, { maxLength: 3 }).map((rs) =>
  rs.map((r, i): Rule => ({
    id: `r-${i}`,
    target: { kind: r.kind, ids: r.target },
    type: r.type,
    severity: r.severity,
    ...(r.type === 'limit' ? { limit: { amount: 10, unit: 'g', per: 'serving' as const } } : {}),
  })),
);

/** A question made of random graph names (and an unknown id now and then), in random places. */
const nameArb = fc.oneof(fc.constantFrom(...ids).map(nameOf), fc.constant('a plain word'));
const questionArb = fc
  .record({
    n: fc.nat({ max: 9999 }),
    contains: fc.array(fc.oneof({ weight: 9, arbitrary: fc.constantFrom(...ids) }, { weight: 1, arbitrary: fc.constant('tofu') }), { maxLength: 2 }),
    prompt: nameArb,
    options: fc.tuple(nameArb, nameArb, nameArb),
    reaction: nameArb,
    explain: nameArb,
  })
  .map(({ n, contains, prompt, options, reaction, explain }): StallQuestion =>
    question(`prop-${n}`, {
      contains,
      prompt: `Which is ${prompt}?`,
      options: options.map((text, k) => ({ text, correct: k === 0, reaction: k === 1 ? reaction : 'Not that.' })),
      explain: `Because of ${explain}.`,
    }),
  );

/** Everything a question names: its contains, its options' contains, and every graph name in its text. */
const named = (q: StallQuestion): string[] => [
  ...(q.contains ?? []),
  ...q.options.flatMap((o) => o.contains ?? []),
  ...textMentions([q.prompt, ...q.options.flatMap((o) => [o.text, o.reaction]), q.explain], graph),
];
const aloneOk = (id: string, rules: Rule[]): boolean =>
  graph.has(id) &&
  check({ meta: { title: 't', country: '', region: '', credit: '', cook: '', difficulty: 1, skills: [], servings: 1, license: '', status: 'draft', sacred: false, contributors: [] }, ingredients: [{ name: nameOf(id), displayName: null, quantity: null, unit: null, note: null }], timers: [], steps: [], source: '' }, rules, graph, [], DAY).status === 'ok';

describe('never safe (spec §2.2): nothing a stall shows is ⛔ or ❓', () => {
  test('for random rules over graph ids, no question stallBank returns names (contains or text) an id that check() reports blocked or unverified', () => {
    fc.assert(
      fc.property(rulesArb, fc.array(questionArb, { maxLength: 6 }), fc.constantFrom<StallFile>(BRAM, SPICE, WEN), (rules, extra, stall) => {
        const ctx = { rules, graph, subs, date: DAY, country: 'United States' };
        const file: StallFile = { ...stall, questions: [...stall.questions, ...extra] };
        const bank = stallBank(file, ctx, [SEASONAL_STRAWBERRY]);
        for (const q of bank.questions) for (const id of named(q)) expect(aloneOk(id, rules), `${q.id} names ${id}`).toBe(true);
        // Tips: never for an item that isn't ✅ alone.
        const tips = { ...file.item_tips, ...(file.variants?.protein_counter?.item_tips ?? {}) };
        for (const id of Object.keys(tips)) if (tipFor(file, id, ctx) !== null) expect(aloneOk(id, rules), `tip ${id}`).toBe(true);
        // FAQ: an answer that isn't the safety line names nothing that isn't ✅ alone.
        for (const f of faqFor(file, ctx)) {
          if (f.a === MEDICAL_LINE || f.a === ALLERGEN_LINE) continue;
          for (const id of textMentions([f.a], graph)) expect(aloneOk(id, rules), `faq ${f.q} names ${id}`).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
