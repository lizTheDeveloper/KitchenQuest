# Step 7 — M6 batched eval carries and the one eval run

The M6 final review parked every Minor whose fix touches an `EVAL_FILES` path, to batch them into "one run at the next eval-bearing milestone (M7)" (`final-review.md` §"Parked items: severity, fix and whether they need an eval re-run"; `progress.md` final-review ruling: "the 7 eval-gated Minors + gate export + swap graph edge park to M7's batched eval run"). This step lands them. It recomputes `EVAL_FILES` for Steps 1–6 and this step, and makes **the one** `npm run eval:mentor` run of M7. It is the last step that touches an `EVAL_FILES` path.

**Pre-flight:**
- Re-read each item's "Where" against the merged code. The M6 fix wave may have moved lines.
- An item the fix wave already closed is dropped, and the report says so.
- None of these is a safety hole while the game's guards stand (final review). Each is pinned by its own test here.

**Files** (the review's hashed files, plus tests):
- Modify:
  - `packages/core/src/market/bank.ts`, `market/types.ts`, `market/validate.ts`, `market/season.ts`;
  - `apps/game/build/content/{schemas,compile}.ts`: the `contains` requirement for stall FAQs and tips;
  - `content/market/*.yaml`: `contains` on each FAQ answer and tip that names a food;
  - `data/seasonality.yaml`: `match.exclude`;
  - `data/ingredients.json`: `neutral_oil` edges, flagged for review the way the graph already flags its review notes;
  - `apps/api/src/mentor/{turn,requests,postchecks,filter}.ts`;
  - `apps/api/test/mentor-gate.test.ts`;
  - `apps/api/src/progress/{store,seal}.ts`, `apps/api/src/db/schema.ts`, and the next generated migration (indexes);
  - `apps/api/src/week/market-service.ts`, `apps/game/src/week/local-week.ts`;
  - `apps/api/eval/{cases,checks,hash}.ts`, `apps/api/test/eval-gate.test.ts`, `apps/api/eval/last-pass.json`;
  - tests beside each.

**The carries** (ids from `final-review.md`; each fix is the review's own, summarised):

| Id | Fix | Pinning test |
|---|---|---|
| M2 | In `faqFor`, a fallback is used only when `ok(fallback)` holds, else `null` | `bank.test.ts`: under a soy rule, a `medical` fallback naming soy → no answer |
| M6 | Export the turn's code-card gate predicate from `turn.ts` as `codeCardGate(...)`; `mentor-gate.test.ts` calls it instead of its own copy | `mentor-gate.test.ts` imports it; a reorder of the gate fails the test |
| M7 | `contains?: string[]` on `StallFaq` answers and item tips, honoured in `faqFor` / `tipFor` through `namedStatus(declared, …)`; the validator requires it wherever a food word is scanned | core test: a tip naming a food only indirectly, with `contains: ['peanut']`, is ⛔ under a peanut rule; validator test: a food-word answer without `contains` fails the build |
| M11 | `match.exclude` phrases in the seasonal table schema (other US state names and postal codes, "eastern washington", "eastern oregon"); `seasonRegionFor` returns null when any is present | "Oregon, Ohio", "Oregon WI" and "eastern Washington" → null; "Portland, Oregon" still matches |
| M12 | A migration adds an expression index `reward_grants (user_id, (body->>'eventId'))` and a partial index `progress_events (user_id) where kind = 'imported'`; `recordedFacts` queries through them | `progress.test.ts`: `EXPLAIN` uses both indexes; behaviour unchanged |
| M13 | Pad sealed progress bodies to one 1024-byte bucket in `progress/seal.ts` (`_pad`, stripped on open) | Protein Counter and base round blobs have equal `octet_length`; open round-trips |
| M14 | `recompute` keeps a returning dish's row beside its stall swap (`kept.filter((i) => i.stockSwap !== undefined).map((i) => i.stockSwap!.from)` added to `out`); the same in device `local-week.ts` | API and game tests: take red lentil for moong dal → block parippu → unblock → moong dal row is back as swapped, and `take` is not `stock_invalid` |
| M15 | `TICK_PATTERN`: the look-behind gains `star\|lone star\|from a\|after a`, and the look-ahead gains `hiking\|camping\|from`; `isWriteRequest` and the postcheck skip the tick test on `isHealthText` sentences | "I got alpha-gal from a lone star tick", "got ticks hiking" → no `write.not_done`; the four texts pinned |
| M16 | `MEAL_CLAIM` gains the core diet cues (low fodmap, halal, kosher, keto, diabetic, doctor/dietitian approved) | "LOW FODMAP SOUP", "HALAL CHICKEN CURRY", "DOCTOR APPROVED STEW", "keto bread" → no meal card, the ask instead |
| M17 | `claimsTick` reads model text with an uncapped `canonicalFull`; comment at `screenText` that it is for player-bounded text | a tick claim at character 600 of model text → `write.not_done` |
| dup ask | `rule.ask_what_else` is said once on an AI health turn with a check-off card | new eval case C01 and a turn test: the trigger appears once |
| M3 data | `neutral_oil`: a rapeseed/canola → mustard-family edge and the sunflower edges, each flagged for review | core `check`: under a mustard rule the canola-oil swap is ⛔ or ❓, never ✅ |

- [ ] **7.1 Write the failing tests** in the right-hand column, plus `eval-gate.test.ts`: "3 runs of all 57 cases (M7: + V01–V04, C01)". `EVAL_FILES` equals the recomputed closure; it now includes core `voice/*` and whatever Steps 1–6 added to the turn's closure.
- [ ] **7.2 Run** `npm test -w @kitchenquest/core`, `npm test -w @kitchenquest/api -- mentor progress week eval-gate`, `npm test -w @kitchenquest/game -- week content` → FAIL on the new tests.
- [ ] **7.3 Implement** each fix as summarised. Then recompute `EVAL_FILES` from the closure helper (`test/helpers/import-closure.ts`) and update `hash.ts`'s list and its comment (M7: core `voice/`, the transcript gate).
- [ ] **7.4 Run** every suite except the eval gate → PASS: `npm run typecheck`, `npm run lint`, `npm test` (only `eval-gate.test.ts` fails), `npm run build -w @kitchenquest/game`.
- [ ] **7.5 Eval: one run, by the implementer.** `OPENROUTER_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1 npm run eval:mentor -w @kitchenquest/api` (synthetic data only). Bar: 0 hard fails and ≥ 95% of tool cases. Commit `apps/api/eval/last-pass.json`. If it fails, report **BLOCKED** with the per-case results. Do not tune the prompt or re-run for luck: the controller rules.
- [ ] **7.6 Run** `npm test` in every workspace, `eval-gate.test.ts` included → PASS. Only now do Steps 1–7 get their one PR.
- [ ] **7.7 Commit** `fix(m6-carries): batched eval-gated Minors; eval pass recorded for M7 voice`
