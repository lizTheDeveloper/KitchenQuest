# Step 11 — Market e2e, never-rules and free-forever sweep, compliance record

Three things close the milestone, as in M5 Step 12:
- **The market flow end to end.** Spec §12 asks for Playwright flows and an accessibility check on all HTML panels.
- **The promises, pinned by tests.** These are:
  - §3.5 "never gate the shopping list", "never a penalty", "blocked items never appear as correct answers";
  - §6 "nothing earned is taken back";
  - §16 free forever and never rules 4, 5, 7 and 8;
  - the milestone's no-pressure, prices and regional-honesty rules, across every screen this milestone added, in standard and Family Table mode.
- **The compliance record and the founder review list**, brought up to date.

**Pre-flight:** Steps 1–10 are merged. Step 8's eval record is in (`apps/api/eval/last-pass.json`). This step must not modify any `EVAL_FILES` path (Ruling 22). It adds tests and docs only. A fix to decision code found here goes back to its step with one eval run.

**Files:**
- Create: `apps/game/e2e/market-week.e2e.test.ts`; `packages/core/test/no-pressure.test.ts` (it reads source with `node:fs`, so it lives in `test/` beside `no-streak.test.ts`; core `src/` is type-checked without Node's types).
- Modify:
  - `apps/game/e2e/never-rules.e2e.test.ts`, `apps/game/e2e/screens.ts`: add `#/stalls`, `#/stall/<each>` (base and Protein Counter), a round mid-question and after an answer, the chalkboard, `#/market` with amounts, season notes and an open stock control, the check-off card and the errand question, each in standard and Family Table mode;
  - `apps/game/e2e/free-forever.e2e.test.ts`, `apps/game/e2e/a11y.e2e.test.ts`;
  - `apps/api/test/free-forever.test.ts`;
  - `docs/compliance/ROADMAP.md`, `docs/compliance/data-inventory.md`, `docs/compliance/dpia.md` (§6.1 re-review for M6, N-11), `docs/compliance/risk-register.md`;
  - `content/README.md`: "Content review for the founder: everything M6 flagged, in one place";
  - `README.md`: the market, `data/seasonality.yaml`, the new routes and the snapshot.

**What the tests pin:**
- **Market week e2e** (mocked `/api/**`, 400 px and 1280 px, canvas on and off):
  1. The profile is United States / Washington, and today is a Saturday in November. The plan holds parippu on Sunday.
  2. `#/stalls` → Wen → the seasonal round appears ("Seasonal or well-travelled?"). One right and one wrong answer, then leave: one `stall_round` posted, XP once, and the stamp line once.
  3. The same round again: no new XP and no second stamp that ISO week, and no line mentions a loss.
  4. `#/market` → amounts shown → "Out of stock?" on shallots → take onion → tick two rows → "That's the shop done".
  5. "got the moong dal" said to the Pan → the card is already ticked with an Undo (no tap, C31); "no fennel" → the health ask and nothing ticked (C30); a model-proposed check-off card ticks only after the tap.
  6. Cook parippu: the label "swapped at the market: onion for shallot".
  7. A coconut rule is added: parippu ⛔ in the plan and cook mode, Cook disabled, and its unticked list rows are gone (M5 C20). XP, level and stamps are unchanged. A soy rule then removes every tofu question at Okafor-Sato's.
  8. The profile region changes to "Kerala, India" (no table): no seasonal round, `market.no_calendar` once, and **no** Pacific Northwest note anywhere.
  9. A vegetarian rule: Bram is the Protein Counter, and no meat question or tip appears.

  Run it twice: AI off and signed out on the device (step 5 by the scripted grammar), then AI on and signed in with mocked turns.
- **No pressure (core + game):**
  - `no-pressure.test.ts` greps the non-test source of core `market/` for identifiers matching `/streak|consecutive|inARow|combo|multiplier|countdown|timeLeft|lives|deadline/i` (comments and strings stripped, as M5 C28);
  - the never-rules e2e asserts that no market screen has an element with a `role="timer"`, a `<progress>`, a `<meter>`, a "x/y" or "x of y" text, or a countdown pattern (`/\b\d+\s*(s|sec|seconds|min)\s*(left|remaining)\b/i`), in any mode.
- **Gating (game e2e):** with every stall unvisited, the list ticks, finishes and lists everything. An errand completes after a wrong answer. Cook is enabled with the drill-first hint shown.
- **Prices and selling:** no market screen matches the sells pattern (`/\b(guild|upgrade|subscri\w*|premium)\b|\$\s?\d/i`) or any currency symbol (`[$£€¥₹₩₦₱¢]`), and no keeper line says "buy" as an offer. An offer is the keeper selling their own goods in the app ("buy from me", "buy it here", "on sale", "special price", "add to basket"). Shopping advice for the player's own shop ("buy whole, buy small", "buy from a busy shop") is the skill §3.5 teaches and is not an offer, so the test matches offer phrasings, not the bare word. In-app, nothing is for sale. The chalkboard footnote is present wherever a chalkboard is.
- **Regional honesty:** for profiles {none, "UK", "Kerala, India", "Oaxaca, Mexico", "Lagos, Nigeria", "Melbourne, Australia", "Washington, USA"}, only the last gets any seasonal content. US-scoped label questions appear only for the US profile.
- **Voice (game):** every `[data-content]` element on every new screen passes the M5 scan plus Step 5's stall patterns ("smuggled", currency), the allowlist matched by location (M5 Ruling 24).
- **Free forever (API):** a player with no entitlements, at the AI cap and with the AI off, can play every stall, earn the same grants as a Guild player for the same rounds, check off by the scripted grammar, take a stall swap, and export and delete. No response body matches the sells pattern.
- **Never take back (API):** grants survive a `health_data` delete that erases Protein Counter rounds, a snapshot rebuild, a `rewards.yaml` retune of `market_game` (lower amounts at a second boot) and a rules change that hides answered questions. Every derived value is ≥ before.

**Compliance record:**
- `data-inventory.md`:
  - U-5: the stall round, its sealed variant, the health gate and the erase;
  - U-6: the progress snapshot;
  - H-11: market rows with amounts and stock swaps;
  - L-5: device stall rounds, with Protein Counter rounds noted as health data on the device;
  - P-1: the region now resolved for seasonality by code, never added to a prompt (M4's `profile.region` is the only region a prompt carries, and is unchanged; M6 adds nothing region-derived, C32);
  - §6 columns;
  - the lock order.
- `ROADMAP.md`: a ticked **M6 gamified market** line, plus open `[lawyer]` items for:
  - sealed Protein Counter rounds as health data, and their grants kept after a `health_data` delete (as M5's question 1);
  - the snapshot as a derived cache under the same basis as U-5;
  - device stall rounds without consent signed out (alongside the M5 device-week item).

  We never claim HIPAA compliance.
- `dpia.md` §6.1: the M6 re-review (N-11). M6 adds no new processor and no new AI feature beyond the check-off tool, which runs under the same C-14 policy. The new consent-purpose use is `health_data` for sealed rounds.
- `risk-register.md`: new risks:
  - a hidden question answered through a forged event (closed by core validation);
  - stale snapshots (closed by the trigger);
  - region misattribution (closed by `null` on ambiguity).
- `content/README.md`: the founder review list for M6:
  - every new Pan trigger, `ai: never` first;
  - the reworded stall lines;
  - every `# REVIEW:` the steps added: the graph nodes, `pnw-usa` months, swaps, `countries` scopes, `asafoetida` → wheat, and `leek` → allium;
  - the open **[founder]** rulings.

- [ ] **11.1 Write the failing tests** above.
- [ ] **11.2 Run** `npm run test:e2e -w @kitchenquest/game -- market-week never-rules free-forever a11y`, `npm test -w @kitchenquest/core -- no-pressure`, `npm test -w @kitchenquest/api -- free-forever never-take-back` → FAIL where not yet covered.
- [ ] **11.3 Fix copy, never weaken a pattern** (M5 Ruling 24). Write the compliance record and the founder list.
- [ ] **11.4 Run** everything: `npm run typecheck`, `npm run lint`, `npm test` in every workspace, and `npm run test:e2e -w @kitchenquest/game` → PASS. Record the gate counts, first paint and the market chunk size in the report. `git diff --stat` since Step 8 shows no `EVAL_FILES` path.
- [ ] **11.5 Commit** `test(m6): the market sweep — no pressure, no prices, honest seasons, nothing taken back; compliance record`
