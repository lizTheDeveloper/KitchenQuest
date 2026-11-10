# Step 2 — Content: new Pan lines, consent and disclosure forms, rule terms

Code may only emit triggers that exist. This step adds the written lines that the server and the scripted engine use for read-backs, refusals and fallbacks. It also adds the Bureau forms for the consent and disclosure cards and the small rule-terms table that core's `buildRuleCard` reads. Every new safety trigger is `ai: never`. Voice guide §0 applies to every line: plain inside safety content, jokes only around it.

**Files:**
- Modify: `content/dialogue/pan.yaml` (new triggers below), `content/bureau/forms.yaml` (forms `consent_health`, `consent_ai`, and disclaimer `ai_characters`), `content/README.md` (document the new triggers and `data/rule-terms.json`)
- Create: `data/rule-terms.json`
- Modify: `apps/game/src/content/required.ts` (add every new trigger to `REQUIRED_PAN_TRIGGERS`, plus `rule.readback`, `rule.readback.no_spelling`, `rule.severity_unclear`, `rule.stamped`, `rule.not_quite`, `rule.voided`, `rule.void_confirm`, `rule.emergency`, `rule.medical_deflect`, `log.confirm_readback`, `log.logged`, `pantry.added`, `pantry.removed`, `schedule.set`, `schedule.bad_time`, `undo`, `undo.nothing`, `didnt_understand`, `rate_limited`, `intake.*`; and `'ai_characters'` to `REQUIRED_DISCLAIMERS`), `apps/game/build/content-plugin.ts` (compile `data/rule-terms.json`, validated with core `validateRuleTerms`, build fails naming the file), `apps/game/src/content/types.ts` (`ruleTerms: RuleTerm[]` on the compiled content)
- Test: `apps/game/build/content-plugin.test.ts` (extend), `apps/game/src/content/required.test.ts` (new: the `ai: never` list below)

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
| `allowance.explain` | Any question about plans, prices or keeping on talking | — | Honest about the daily cap. Never names the Guild, a price or a tier. Says scripted help, recipes, rules and logging are always free: "I've a daily allowance of chat, and I'll tell you when it runs out. Recipes, cooking, allergy checks, logging and the market always work, every day, for nothing." |
| `log.needs_account` | A meal log for a signed-out player | — | "I can keep a food log once you're signed in. Settings has the sign-in. Everything else works on this device as it is." |
| `profile.readback` | Read-back of a profile or schedule card | `summary` | Like `log.confirm_readback`: "{summary}. Shall I ink it?" |
| `pantry.readback` | Read-back of a pantry card | `summary` | "{summary}. Shall I update the pantry?" |
| `ai.try_again` | The AI failed; the message is kept for "Try again" | — | "I've kept what you said. Tap 'Try again' in a moment, or use the buttons below." |
| `forget.done` | The player cleared their conversations | — | "Forgotten. The conversation's gone from the Bureau's files. Your saved rules, meals and pantry are where you left them." |

- `content/bureau/forms.yaml`:
  - `consent_health`:
    - `number: "3-C/HEALTH"`, `title: "Permission to Keep Health Details"`, `safety: true`
    - `fields: [{ key: notice, label: "What this covers" }]`. The value is the API's notice text, shown verbatim.
    - `buttons: { confirm: "I agree", decline: "Not now" }`, `stamp: confirmed_by_apprentice`
    - one footnote, outside the notice: `"*Saying no costs nothing. You can play every part of the game without it."`
  - `consent_ai`: the same shape, with `number: "3-C/AI"`, `title: "Permission for the AI to See Your Rules and Meals"`, and the same buttons and footnote.
  - `disclaimers.ai_characters`, verbatim (C-16): `"The Pan and the cooks are AI characters. Don't rely on them for medical advice."`
- `data/rule-terms.json`. Each entry follows `RuleTerm`, and only ids that exist in `data/ingredients.json` are allowed:
  - `vegetarian`: phrases `["vegetarian", "veggie"]`, ids `["meat", "fish", "shellfish"]`, severity `"preference"`, form `rule_diet`
  - `vegan`: phrases `["vegan", "plant-based", "plant based"]`, ids `["meat", "fish", "shellfish", "milk", "egg"]`, severity `"preference"`, form `rule_diet`
  - `pescatarian`: phrases `["pescatarian", "pescetarian"]`, ids `["meat"]`, severity `"preference"`, form `rule_diet`
  - `coeliac`: phrases `["coeliac", "celiac", "gluten free", "gluten-free"]`, ids `["gluten"]`, severity `null` (asked), form `rule_allergen`
  - `no pork`: phrases `["no pork", "halal"]`, ids `["pork"]`, severity `"preference"`, form `rule_diet`, with `// REVIEW:` in `content/README.md`: halal and kosher need more than one target and a reviewer; M4 maps "halal" to pork only and the card says exactly that in "This covers"

  Kosher and Jain are deliberately absent. They resolve to `ambiguous` or `unknown_term`, never to a narrower rule.

- [ ] **2.1 Tests:**
  - `required.test.ts`: every trigger in the table above and every `rule.*`, `log.confirm_readback`, `log.low_intake_checkin`, `rule.emergency`, `rule.medical_deflect`, `child.grownup` and `allowance.explain` is `ai: never` in the compiled bank.
  - No line in `allowance.explain`, `rate_limited` or `ai_unavailable` matches `/\b(guild|upgrade|subscri\w*|premium|plan|tier)\b|\$\s?\d|£\s?\d/i` (never rule 7).
  - `rule.tap_needed`, `rule.unknown_term` and `child.grownup` contain no `I'm a pan` (plain safety content).
  - `content-plugin.test.ts`: a `rule-terms.json` naming an id missing from the graph fails the build with the file name and the term. A duplicate phrase across two terms fails too.
  - `forms.yaml` has `disclaimers.ai_characters` exactly equal to the C-16 string.
- [ ] **2.2 Run** `npm test -w @kitchenquest/game -- content build/content` → FAIL.
- [ ] **2.3 Write** the lines (voice guide §0 and §3 "Plain on safety"; 3–4 lines per trigger, except `child.grownup`, which has exactly one), the forms and `data/rule-terms.json`. Mark any uncertain fact `# REVIEW:`. Wire the plugin and the types.
- [ ] **2.4 Run** `npm test -w @kitchenquest/game` and `npm run build -w @kitchenquest/game` → PASS.
- [ ] **2.5 Commit** `content: Pan lines for proposals, refusals and fallbacks; consent and AI disclosure forms; rule terms`
