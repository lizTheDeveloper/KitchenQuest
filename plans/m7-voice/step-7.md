# Step 7 — M6 batched eval carries and the one eval run

The M6 final review parked every Minor whose fix touches an `EVAL_FILES` path, to batch them "into one run at the next eval-bearing milestone (M7)":
- `final-review.md` §"Parked items: severity, fix and whether they need an eval re-run";
- `progress.md`: "the 7 eval-gated Minors + gate export + swap graph edge park to M7's batched eval run".

This step lands those carries and adds the eval check for Ruling 18. It recomputes `EVAL_FILES`, then makes **the one** `npm run eval:mentor` run of M7. It is the last step that touches an `EVAL_FILES` path.

**Pre-flight:**
- Re-read each carry's "Where" against the merged code. An item the M6 fix wave already closed is dropped, and the report says so.
- The `neutral_oil` row needs the controller's confirmation in the dispatch note, because `final-review.md` line 149 says M10 and `progress.md` says M7. The default is M7 (B7).
- **D5:** the voice change set (Steps 1–6) and the carries are separate commits and separate sections of the one PR. The controller reviews the carry set apart from voice.

**Files** (the carries' code, data, content and tests, hashed or not, plus the eval files):
- Modify:
  - core: `packages/core/src/market/{bank,types,validate,season}.ts`;
  - game build and content: `apps/game/build/content/{schemas,compile}.ts`, `content/market/*.yaml`;
  - data: `data/seasonality.yaml`, `data/ingredients.json` (the `neutral_oil` row only);
  - API: `apps/api/src/mentor/{turn,requests,postchecks}.ts`, `apps/api/src/progress/{store,seal}.ts`, `apps/api/src/db/schema.ts` and the next migration (indexes), `apps/api/src/week/market-service.ts`;
  - game: `apps/game/src/week/local-week.ts`;
  - eval: `apps/api/eval/{cases,checks,hash}.ts`, `apps/api/test/{eval-gate,mentor-gate}.test.ts`, `apps/api/eval/last-pass.json`;
  - bench: `apps/voice/bench/run.ts` (`--selftest`, P15);
  - tests beside each.

**The carries** (ids from `final-review.md`; M17 is dropped, because the review says "No change needed now", B7):

| Id | Fix | Pinning test |
|---|---|---|
| M2 | `faqFor` uses a fallback only when `ok(fallback)`, else `null` | `bank.test.ts`: under a soy rule, a `medical` fallback naming soy → no answer |
| M6 | export `codeCardGate(...)` from `turn.ts`; `mentor-gate.test.ts` calls it | a reorder of the gate fails; **P13:** a transcript naming a food reaches the heard part **before** the check-off grammar and before `codeCardGate` (Step 6's probes reused) |
| M7 | `contains?: string[]` on `StallFaq` answers and item tips, honoured in `faqFor` / `tipFor` via `namedStatus`; the validator requires it where a food word is scanned | a tip naming a food indirectly, with `contains: ['peanut']`, is ⛔ under a peanut rule; a food-word answer without `contains` fails the build |
| M11 | `match.exclude` phrases in the seasonal table; `seasonRegionFor` → null when any is present | "Oregon, Ohio", "Oregon WI", "eastern Washington" → null; "Portland, Oregon" matches |
| M12 | indexes `reward_grants (user_id, (body->>'eventId'))` and `progress_events (user_id) where kind = 'imported'` | `EXPLAIN` uses both; behaviour unchanged |
| M13 | sealed progress bodies padded to one 1024-byte bucket (`_pad`, stripped on open) | Protein Counter and base blobs have equal `octet_length`; they round-trip |
| M14 | `recompute` keeps a returning dish's row beside its stall swap; the same in device `local-week.ts` | take red lentil for moong dal → block parippu → unblock → the row is back as swapped; `take` is not `stock_invalid` |
| M15 | `TICK_PATTERN`: look-behind adds `star\|lone star\|from a\|after a`, look-ahead adds `hiking\|camping\|from`; the tick test is skipped on `isHealthText` sentences | "I got alpha-gal from a lone star tick" and "got ticks hiking" → no `write.not_done` |
| M16 | `MEAL_CLAIM` gains the core diet cues | "LOW FODMAP SOUP", "HALAL CHICKEN CURRY", "DOCTOR APPROVED STEW", "keto bread" → no meal card |
| dup ask | `rule.ask_what_else` once on an AI health turn with a check-off card | eval case C01, plus a turn test |
| M3 data | `neutral_oil`: a rapeseed/canola → mustard-family edge and the sunflower edges, flagged for review the graph's usual way | under a mustard rule, the canola-oil swap is ⛔ or ❓, never ✅ |
| Ruling 18 | `checks.ts` gains `modelCalled` (from the runner's model-call counter) | `checks.test.ts`: V05 with a model call recorded fails; V01 without one fails |
| P15 | `bench/run.ts --selftest` runs the whole bench loop against fake engines and an in-test stub API HTTP+WS server (no network, no import from `apps/api`) | `apps/voice/test/bench-selftest.test.ts`: one utterance end to end yields a `BenchRun` that `parseBenchRun` accepts |

- [ ] **7.1 Write the failing tests** in the right-hand column. Then change `eval-gate.test.ts`:
  - the case count is derived: it asserts `results.length === CASES.length × REPS` and that every `CASES` id is present, with no literal count (B7);
  - `EVAL_FILES` equals the recomputed closure, which now includes core `voice/*`, `apps/api/src/voice/registry.ts` and `apps/api/src/voice/recent-replies.ts`;
  - it asserts that `apps/api/src/voice/routes.ts` is **not** in the closure (P3).
- [ ] **7.2 Run** `npm test -w @kitchenquest/core`, `npm test -w @kitchenquest/api -- mentor progress week eval checks`, `npm test -w @kitchenquest/game -- week content`, `npm test -w @kitchenquest/voice -- bench-selftest` → FAIL on the new tests.
- [ ] **7.3 Implement** each fix. Recompute `EVAL_FILES` with `test/helpers/import-closure.ts`, and update `hash.ts`'s list and comment.
- [ ] **7.4 Run** every suite except the gate → PASS: `npm run typecheck`, `npm run lint`, `npm test` (only `eval-gate.test.ts` fails), `npm run build -w @kitchenquest/game`.
- [ ] **7.5 Eval: one run, by the implementer.** `OPENROUTER_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1 npm run eval:mentor -w @kitchenquest/api` (synthetic data only). The bar is 0 hard fails and ≥ 95% of tool cases; V05 is a hard (safety) case. Commit `last-pass.json`. On a failure, report **BLOCKED** with the per-case results: no prompt tuning, no re-run.
- [ ] **7.6 Run** `npm test` in every workspace, gate included → PASS. Only now do Steps 1–7 get their one PR, with the D5 sections.
- [ ] **7.7 Commit** as two commits:
  - `fix(m6-carries): batched eval-gated Minors`, for the carry rows;
  - `chore(eval): record the M7 eval pass (transcript cases V01–V05, C01)`, for `hash.ts`, the checks, the gate test and `last-pass.json`.
