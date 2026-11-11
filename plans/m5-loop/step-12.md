# Step 12 — Weekly-loop e2e, never-rules and free-forever sweep, compliance record

Three things close the milestone:
- **The weekly-loop flow.** Spec §12 asks for "Playwright flows for … the weekly loop". This step adds one flow across the whole week with the AI on (mocked) and one with it off.
- **The promises, pinned by tests.** These are §6 "nothing earned is taken back", §16 free forever and never rules 3, 4, 5, 6, 7, 8 and 9, and the audit's guardrails, across every screen this milestone added.
- **The compliance record**, brought up to date for the new personal data.

**Pre-flight:** Steps 1–11 are merged. Step 8's eval record is in (`apps/api/eval/last-pass.json`).

**Files:**
- Create:
  - `apps/game/e2e/weekly-loop.e2e.test.ts`;
  - `apps/api/test/never-take-back.test.ts`;
  - `packages/core/src/progress/no-streak.test.ts`: an architecture grep over core `progress/`, `quests/`, `toolkit/` and `week/`;
  - a generated migration `apps/api/migrations/0016_reward_grants_append_only.sql`.
- Modify:
  - `apps/game/e2e/never-rules.e2e.test.ts` and `apps/game/e2e/screens.ts`: add `#/plan`, `#/market`, `#/frame/<id>`, `#/book`, `#/book/<slug>`, the after-cook flow, the quest runner, the apprentice card and the new slips;
  - `apps/game/e2e/free-forever.e2e.test.ts`;
  - `apps/api/test/free-forever.test.ts`;
  - `docs/compliance/ROADMAP.md`, `docs/compliance/data-inventory.md`, `docs/compliance/dpia.md`, `docs/compliance/risk-register.md`;
  - `README.md`: the weekly loop, `data/rewards.yaml`, and the new routes.
- Test: the files above.

**What the tests pin:**
- **Weekly loop e2e** (mocked `/api/**`, 400 px and 1280 px):
  1. Market day Saturday.
  2. "Plan my week: dal on Sunday, pick two more" → plan card → tap.
  3. The weekly slot offers tempering; "Not this week".
  4. `#/market` → tick three items → "That's the shop done".
  5. Leela's quest to cook mode → finish.
  6. "Just me" → "added lime" note → Log it.
  7. The book shows parippu with the note and the date; download the book.
  8. A rule for coconut is added: the plan now shows parippu ⛔ with Cook disabled. XP, level, stamps and trust in the kitchen are unchanged.
  9. Undo the meal log: XP unchanged, and no line mentions a loss.

  Run it twice: AI on (mocked turn responses) and AI off with signed-out device storage. The signed-out run skips the account-only steps, then signs in, uploads, and shows no lower value.
- **Never take back (API):** grants survive:
  - meal undo;
  - note delete;
  - `health_data` withdrawal with "delete";
  - a rule that blocks a cooked dish;
  - a `rewards.yaml` with higher thresholds loaded at a second boot;
  - a re-upload of a device log.

  Every derived value (XP, level, stamps, trust, tier) is ≥ before. No code path issues `delete` or `update` on `reward_grants`. Two checks pin this:
  - a grep over `apps/api/src`;
  - a new migration, `0016_reward_grants_append_only.sql`, which adds a trigger that raises on any UPDATE of `reward_grants`. DELETE stays possible, because the account-delete cascade needs it; the grep covers it. The test asserts both the trigger and the grep.
- **No streaks (core):** an architecture test fails if core `progress/`, `quests/`, `toolkit/` or `week/` contains a function or identifier matching `/streak|consecutive|inARow|daysInARow|combo/i`. A fast-check property in Step 1 already pins behaviour. This pins vocabulary.
- **Free forever (API):** a player with no entitlements, at the AI cap, with the AI off, can:
  - plan a week (scripted);
  - open and finish a market run;
  - cook, log, note, and record Cooked for Someone;
  - read the book's data;
  - export and delete.

  They earn exactly the grants a Guild player earns for the same events. `POST /mentor/turn` with "plan my week" at the cap returns a scripted plan card. Planning is not free-form chat, so it falls to the script, never to a paywall. No response body matches the sells pattern (M4: `/\b(guild|upgrade|subscri\w*|premium)\b|\$\s?\d/i`).
- **Never-rules scan (game):** every `[data-content]` element on every new screen is checked against:
  - the sells pattern;
  - voice §7's banned words;
  - unlock, loot, collect, acquire and discover about recipes;
  - streak, "in a row" and "missed";
  - any "n/9" or percentage across cultures;
  - "HIPAA" and "medical-grade";
  - countdown words ("only", "left", "hurry", "expires") on rescue, market and plan screens.

  Also:
  - no element has a `warning` or `danger` class on a Rusty toolkit row;
  - no screen in this milestone shows a price or the Guild;
  - the rescue appears at most once a day across reloads;
  - "Feeding yourself counts" appears for "Just me".
- **Compliance docs:**
  - `ROADMAP.md`:
    - tick N-7's remainder: "Cooked for Someone labels decided in M5: fixed sets, no names, `plans/m5-loop/step-7.md`";
    - mark C-45 `[~]` "reserved M5 (consent subject columns, `plans/m5-loop/step-7.md`); build M13";
    - add a line for this milestone like M4's;
    - add `[lawyer]` items: plans, market runs and progress slugs vs `health_data` (Ruling 18), and the health_data v3 wording.
  - `data-inventory.md`:
    - H-11, H-12, H-13 and U-5 "built M5" with real columns and retention;
    - K-4 reserved;
    - L-5 updated: device progress, plan and list are content-free or dish slugs, with no health data, since notes, cooked-for and meals are account-only;
    - §3.13 caps: note text 280, ops 12, 20 notes per recipe, 21 plan items, 100 events per request, 200 a day;
    - the §6 index (the N-8 test).
  - `dpia.md`: an N-11 re-review entry for "weekly loop (M5): margin notes as health data, Cooked for Someone as third-party data, progress as behavioural data", with mitigations (sealing, consent, no names, retention, export/delete).
  - `risk-register.md`: R-19 control updated (no names stored, fixed sets), plus a new low risk "progress slugs reveal diet" with its control (contract basis, export/delete, `[lawyer]`).

- [ ] **12.1 Write the failing tests:** `weekly-loop.e2e.test.ts`, `never-take-back.test.ts`, `no-streak.test.ts`, and the free-forever and never-rules extensions. Each new scan gets a planted fixture that must fail, so the scan is proven to bite.
- [ ] **12.2 Run** `npm test -w @kitchenquest/api -- never-take-back free-forever`, `npm test -w @kitchenquest/core -- no-streak` and `npm run test:e2e -w @kitchenquest/game -- weekly-loop never-rules free-forever` → FAIL.
- [ ] **12.3 Implement** the trigger migration, the tests and the docs. Fix any copy the scans catch in `content/`, never by weakening a pattern.
- [ ] **12.4 Run** `npm run typecheck`, `npm run lint`, `npm test` at the root (eval gate included, no skip flag) and `npm run test:e2e -w @kitchenquest/game` → PASS. Check the first-paint budget.
- [ ] **12.5 Commit** `test: weekly-loop flow, never-take-back and free-forever proofs; docs: compliance record for the loop`
