import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * sha256 of everything a recorded eval pass measured (fix round 1, M4), as written. The record stores it and the
 * gate checks it, so a case, a check or the code that decides a turn, changed after the run, can't keep passing on
 * stale results.
 *
 * - The eval itself: cases, judge, write snapshot and the runner (its seeds and write count, fix round 2 N2).
 * - M5 Step 8 fix round 4 (N8 ruling): the runtime import closure of the API turn entry (`src/mentor/turn.ts`),
 *   the core modules it reaches and the prompt render code (`prompt.ts`) among them; the API's `db/` and `crypto/`
 *   and type-only imports are left out. The gate test recomputes the closure from the source and fails when this
 *   list and it differ, so a new decision module can't be missed.
 * - M5 final review (parked m7): the modules the turn reaches through its injected deps are extra closure roots
 *   (`mentor/routes.ts`, `mentor/memory.ts`, `recipes/recipe-index.ts`, `catalog.ts`), and `app.ts`, which wires
 *   them, is hashed as a file (not its whole closure).
 * - M6 Step 8 (the Steps 1–7 carries, recomputed from the closure): the turn now reaches core `market/` (through
 *   `catalog.ts`), `mentor/check-off.ts`, `ingredients/mentions.ts`, `nutrition/units.ts`, `week/amounts.ts` and
 *   `week/stock.ts`, and the API's `mentor/check-off-turn.ts`, `week/market-service.ts`, `progress/seal.ts` and
 *   `progress/snapshot.ts`.
 * - The data the turn decides with: `data/ingredients.json` (the graph: `mentionsHealthTerm`, `resolve`),
 *   `data/rule-terms.json` (rule terms and cards) and every file of the canon recipes directory (the exact dish
 *   names `planIntent` accepts).
 *
 * Paths are relative to this file; a path ending in "/" is a directory, hashed file by file in sorted order.
 */
export const EVAL_FILES: readonly string[] = [
  './cases.ts',
  './checks.ts',
  './snapshot.ts',
  './run.ts',
  '../src/ai/openrouter.ts',
  '../src/app.ts',
  '../src/audit/audit.ts',
  '../src/auth/live-user.ts',
  '../src/auth/rate-limit.ts',
  '../src/auth/session.ts',
  '../src/auth/tokens.ts',
  '../src/catalog.ts',
  '../src/consent/ledger.ts',
  '../src/consent/notices.ts',
  '../src/entitlements/entitlements.ts',
  '../src/errors.ts',
  '../src/meals/service.ts',
  '../src/meals/store.ts',
  '../src/mentor/allowance.ts',
  '../src/mentor/check-off-turn.ts',
  '../src/mentor/constants.ts',
  '../src/mentor/conversations.ts',
  '../src/mentor/filter.ts',
  '../src/mentor/health.ts',
  '../src/mentor/lines.ts',
  '../src/mentor/memory.ts',
  '../src/mentor/plan-turn.ts',
  '../src/mentor/postchecks.ts',
  '../src/mentor/prompt.ts',
  '../src/mentor/proposals.ts',
  '../src/mentor/requests.ts',
  '../src/mentor/routes.ts',
  '../src/mentor/tools.ts',
  '../src/mentor/turn.ts',
  '../src/mentor/writes.ts',
  '../src/pantry/service.ts',
  '../src/pantry/store.ts',
  '../src/profile/routes.ts',
  '../src/profile/store.ts',
  '../src/progress/catalogue.ts',
  '../src/progress/seal.ts',
  '../src/progress/service.ts',
  '../src/progress/snapshot.ts',
  '../src/progress/store.ts',
  '../src/recipes/recipe-index.ts',
  '../src/rules/service.ts',
  '../src/rules/store.ts',
  '../src/usage/usage.ts',
  '../src/usage/write-cap.ts',
  '../src/week/local-date.ts',
  '../src/week/market-service.ts',
  '../src/week/plan-service.ts',
  '../src/week/store.ts',
  '../../../packages/core/src/book/margin-notes.ts',
  '../../../packages/core/src/index.ts',
  '../../../packages/core/src/ingredients/graph.ts',
  '../../../packages/core/src/ingredients/mentions.ts',
  '../../../packages/core/src/market/bank.ts',
  '../../../packages/core/src/market/country.ts',
  '../../../packages/core/src/market/index.ts',
  '../../../packages/core/src/market/round.ts',
  '../../../packages/core/src/market/season.ts',
  '../../../packages/core/src/market/validate.ts',
  '../../../packages/core/src/mentor/cards.ts',
  '../../../packages/core/src/mentor/check-off.ts',
  '../../../packages/core/src/mentor/index.ts',
  '../../../packages/core/src/mentor/intents.ts',
  '../../../packages/core/src/mentor/lines.ts',
  '../../../packages/core/src/mentor/nonsevere.ts',
  '../../../packages/core/src/mentor/outcomes.ts',
  '../../../packages/core/src/mentor/parse.ts',
  '../../../packages/core/src/mentor/plan-card.ts',
  '../../../packages/core/src/mentor/protocol.ts',
  '../../../packages/core/src/mentor/route.ts',
  '../../../packages/core/src/mentor/rule-terms.ts',
  '../../../packages/core/src/mentor/saved.ts',
  '../../../packages/core/src/mentor/spell.ts',
  '../../../packages/core/src/nutrition/units.ts',
  '../../../packages/core/src/progress/derive.ts',
  '../../../packages/core/src/progress/fold.ts',
  '../../../packages/core/src/progress/index.ts',
  '../../../packages/core/src/progress/rewards.ts',
  '../../../packages/core/src/progress/week.ts',
  '../../../packages/core/src/quests/alternatives.ts',
  '../../../packages/core/src/quests/index.ts',
  '../../../packages/core/src/quests/validate.ts',
  '../../../packages/core/src/recipe/parse.ts',
  '../../../packages/core/src/recipe/types.ts',
  '../../../packages/core/src/rules/active.ts',
  '../../../packages/core/src/rules/check.ts',
  '../../../packages/core/src/rules/types.ts',
  '../../../packages/core/src/toolkit/one-more.ts',
  '../../../packages/core/src/toolkit/techniques.ts',
  '../../../packages/core/src/toolkit/toolkit.ts',
  '../../../packages/core/src/week/amounts.ts',
  '../../../packages/core/src/week/data.ts',
  '../../../packages/core/src/week/frames.ts',
  '../../../packages/core/src/week/index.ts',
  '../../../packages/core/src/week/market-list.ts',
  '../../../packages/core/src/week/plan.ts',
  '../../../packages/core/src/week/stock.ts',
  '../../../packages/core/src/week/use-it-up.ts',
  '../../../data/ingredients.json',
  '../../../data/rule-terms.json',
  '../../../recipes/',
];

/** The files under a directory, recursively, as paths relative to this file, sorted. */
function filesUnder(dir: string): string[] {
  return readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(`${dir}${e.name}/`) : e.isFile() ? [`${dir}${e.name}`] : []))
    .sort();
}

export function evalHash(): string {
  const h = createHash('sha256');
  for (const entry of EVAL_FILES) {
    for (const f of entry.endsWith('/') ? filesUnder(entry) : [entry]) h.update(f).update('\0').update(readFileSync(new URL(f, import.meta.url))).update('\0');
  }
  return h.digest('hex');
}
