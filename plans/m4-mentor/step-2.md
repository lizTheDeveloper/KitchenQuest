# Step 2 — Content: new Pan lines, consent and disclosure forms, rule terms

Code may only emit triggers that exist. This step adds the written lines that the server and the scripted engine use for read-backs, refusals and fallbacks. It also adds the Bureau forms for the consent and disclosure cards, and compiles Step 1's `data/rule-terms.json` into the game. Every new safety trigger is `ai: never`. Voice guide §0 applies to every line: plain inside safety content, jokes only around it.

**Files:**
- Modify: `content/dialogue/pan.yaml` (new triggers below), `content/bureau/forms.yaml` (forms `consent_health`, `consent_ai`, and disclaimer `ai_characters`), `content/README.md` (document the new triggers and `data/rule-terms.json`, with the `# REVIEW:` notes from Step 1)
- Modify: `apps/game/src/content/required.ts` (add every new trigger to `REQUIRED_PAN_TRIGGERS`, plus `rule.readback`, `rule.readback.no_spelling`, `rule.severity_unclear`, `rule.stamped`, `rule.not_quite`, `rule.voided`, `rule.void_confirm`, `rule.emergency`, `rule.medical_deflect`, `log.confirm_readback`, `log.logged`, `pantry.added`, `pantry.removed`, `schedule.set`, `schedule.bad_time`, `undo`, `undo.nothing`, `didnt_understand`, `rate_limited`, and every intake trigger by id (`intake.open`, `intake.market_day.ask`, `intake.market_day.followup`, `intake.meals_per_week.ask`, `intake.meals_per_week.followup`, `intake.region.ask`, `intake.region.followup`, `intake.allergies.ask`, `intake.allergies.followup`, `intake.allergies.none`, `intake.pantry.ask`, `intake.pantry.followup`, `intake.skip`, `intake.complete`; the list has no globs); and `'ai_characters'` to `REQUIRED_DISCLAIMERS`), `apps/game/build/content/read.ts` (add `data/rule-terms.json` to `DATA_FILES`), `apps/game/build/content/compile.ts` (compile it, validated with core `validateRuleTerms`; the build fails naming the file and the term; `data/` is already watched, so `content-plugin.ts` is unchanged), `apps/game/src/content/types.ts` (`ruleTerms: RuleTerm[]` on the compiled content)
- Test: `apps/game/build/content/compile.test.ts` (extend), `apps/game/src/content/required.test.ts` (new: the `ai: never` list below)

**Interfaces:**
- Consumes: `RuleTerm`, `validateRuleTerms` (Step 1).
- Produces: these triggers (exact ids; Steps 7–11 emit them). Every one is `ai: never`, with 3–4 lines unless noted:

| Trigger | When | Vars | Content rule |
|---|---|---|---|
| `rule.unknown_term` | The term isn't in the Bureau's ingredient ledger | `term` | Plain. Says that the game can't check dishes for it yet and nothing was saved, then to check every recipe and label yourself. Line 1: "I can't find {term} in the Bureau's ingredient ledger yet, so I can't check dishes for it. Nothing's been saved. Please check every recipe and label yourself, and tell me if you'd like to file something close to it." |
| `rule.which_one` | Several ingredients match | `term` | "I found more than one thing that could be {term}. Tap the one you mean, so I file the right one." |
| `rule.tap_needed` | A typed "yes" for a severe card | `ingredient` | "For an allergy, I need a tap on the card itself, not just a yes. Please check {ingredient} on the card and tap 'Stamp it'." |
| `confirm.tap_card` | A typed "yes" with more than one open card | — | "There's more than one card open. Tap the one you mean, so I'm sure which." |
| `write.not_done` | The model claimed a write that didn't happen | — | "Nothing's been written down yet. If you'd like me to, tell me plainly and I'll show you the card to stamp." |
| `consent.health_first` | A rule or meal card for a player without `health_data` consent | — | "Before I can file that, the Bureau needs your say-so to keep health details. Tap the card, then tell me again." |
| `child.grownup` | A child is talking | — | One fixed line, no joke: "I'm glad you're cooking. I can only take notes from a grown-up, so please fetch the grown-up you cook with. And use the big knives only with them right beside you." |
| `allowance.explain` | Any question about plans, prices or keeping on talking | — | Honest about the daily cap. Never names the Guild, a price or a tier. Says scripted help, recipes, rules and logging are always free, and every line says help with allergy and diet rules is never limited (pre-flight C6; controller ruling, Task 2 fix round 1): "I've a daily allowance of chat, and I'll tell you when it runs out. Recipes, cooking, allergy and diet rules, logging and the market always work, every day, for nothing." |
| `log.needs_account` | A meal log for a signed-out player | — | "I can keep a food log once you're signed in. Settings has the sign-in. Everything else works on this device as it is." |
| `profile.readback` | Read-back of a profile or schedule card | `summary` | Like `log.confirm_readback`: "{summary}. Shall I ink it?" |
| `pantry.readback` | Read-back of a pantry card | `summary` | "{summary}. Shall I update the pantry?" |
| `ai.try_again` | The AI failed; the message is kept for "Try again" | — | "I've kept what you said. Tap 'Try again' in a moment, or use the buttons below." |
| `mentor.ai_unavailable` | The mentor's AI failed or is off for this turn (used instead of `ai_unavailable`, whose lines mention photos and "kept what you said") | — | Never claims anything was saved or kept. Says the written script is answering and that logging, rules, recipes and the market all work: "The line to the Bureau's gone quiet, so I'm answering from the script. Allergies, logging, recipes and the market all still work." |
| `forget.done` | The player cleared their conversations | — | "Forgotten. The conversation's gone from the Bureau's files. Your saved rules, meals and pantry are where you left them." |

- `content/bureau/forms.yaml`:
  - `consent_health`:
    - `number: "3-C/HEALTH"`, `title: "Permission to Keep Health Details"`, `safety: true`
    - `fields: [{ key: notice, label: "What this covers" }]`. The value is the API's notice text, shown verbatim.
    - `buttons: { confirm: "I agree", decline: "Not now" }`, `stamp: confirmed_by_apprentice`
    - one footnote, outside the notice: `"*Saying no costs nothing. You can play every part of the game without it."`
  - `consent_ai`: the same shape, with `number: "3-C/AI"`, `title: "Permission for the AI to See Your Rules and Meals"`, and the same buttons and footnote.
  - `profile` (pre-flight C38; profile cards need fields the `schedule` form lacks): `number: "1-A/AMEND"`, `title: "Amendment to Form 1-A"`, `safety: false`, `fields: [{ key: market_days, label: "Market day(s)" }, { key: meals_per_week, label: "Meals cooked per week" }, { key: region, label: "Country and region", hint: "For seasonal produce. No addresses." }, { key: meal_windows, label: "Meal times" }]`, `buttons: { confirm: "Ink it ✔", decline: "Leave in pencil", undo: "Undo" }`, `stamp: inked`, one footnote of the writer's choosing. A card shows only the fields its patch sets.
  - `disclaimers.ai_characters`, verbatim (C-16): `"The Pan and the cooks are AI characters. Don't rely on them for medical advice."`
- `data/rule-terms.json` itself is created in Step 1 (its table lives there). This step only wires it into the game build.

- [ ] **2.1 Tests:**
  - `required.test.ts`: every trigger in the table above and every `rule.*`, `log.confirm_readback`, `log.low_intake_checkin`, `rule.emergency`, `rule.medical_deflect`, `child.grownup` and `allowance.explain` is `ai: never` in the compiled bank.
  - No line in `allowance.explain`, `rate_limited`, `ai_unavailable` or `mentor.ai_unavailable` matches `/\b(guild|upgrade|subscri\w*|premium|plan|tier)\b|\$\s?\d|£\s?\d/i` (never rule 7).
  - `rule.tap_needed`, `rule.unknown_term` and `child.grownup` contain no `I'm a pan` (plain safety content).
  - No `mentor.ai_unavailable` line matches `/\b(saved|kept|logged|stored|photo)\b/i`.
  - `compile.test.ts`: a `rule-terms.json` naming an id missing from the graph fails the build with the file name and the term. A duplicate phrase across two terms fails too.
  - `forms.yaml` has `disclaimers.ai_characters` exactly equal to the C-16 string.
- [ ] **2.2 Run** `npm test -w @kitchenquest/game -- content build/content` → FAIL.
- [ ] **2.3 Write** the lines (voice guide §0 and §3 "Plain on safety"; 3–4 lines per trigger, except `child.grownup`, which has exactly one), and the forms. Mark any uncertain fact `# REVIEW:`. Wire the plugin and the types.
- [ ] **2.4 Run** `npm test -w @kitchenquest/game` and `npm run build -w @kitchenquest/game` → PASS.
- [ ] **2.5 Commit** `content: Pan lines for proposals, refusals and fallbacks; consent and AI disclosure forms; rule terms`
