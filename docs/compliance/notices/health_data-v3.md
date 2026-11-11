# `health_data` consent notice, v3

- Purpose: `health_data` (C-1)
- Version: `v3`
- SHA-256 of the notice text: `4ffa27629477df162728e28f18676fa565f0193d29b100927f5a12ae0aa14507`
- Status: DRAFT wording, pending lawyer review (C-30). In force from M5 Step 7. **[lawyer]** confirm the wording.
- Replaces: `health_data-v2.md`. Grants under v2 no longer count (`ACCEPTED_VERSIONS.health_data` is `['v3']`): the player is asked again (the game shows the consent card, M4's re-consent path). There were no real users when it changed.

The API serves the paragraph between the two markers below (without the blank lines around it), byte for byte, as the `health_data` notice (`apps/api/src/consent/notices.ts` reads this file at boot). Each grant records this version and the SHA-256 of that text in `consents.notice_version` and `consents.notice_sha256`, so the ledger shows exactly which words the player agreed to.

**Never edit the text of this file.** A change of even one character changes the hash and breaks the record. Write `health_data-v4.md` with a new version instead, and set `ACCEPTED_VERSIONS.health_data` in `apps/api/src/consent/notices.ts` to the versions that still count. `apps/api/test/consent.test.ts` fails if the text and the declared hash disagree.

## What changed from v2

M5 adds two records kept only with this consent:

- **Margin notes** (data inventory H-12, Ruling 9): the player's own changes to a recipe ("no milk, used oat") and their own words about it. A note can show an allergy, a condition or a religious rule, so it is health data under GDPR Art. 9 and WA MHMDA.
- **Weekly meal plans and their market lists** (H-11, M5 Step 6 ruling): the dishes chosen and the swaps a list names can show a diet, a religion or a rule. They were made health data in Step 6; v3 is the first notice to name them.

The words now say both, so the consent names what is actually kept. Cooked for Someone (H-13) is not health data (Ruling 10: fixed choices only, no names, no health facts) and is not covered by this notice.

## Why it names religious and cultural diets

As in v1 and v2: GDPR Art. 9 covers data revealing religious or philosophical beliefs as well as health data. A halal, kosher or Jain rule, or a fasting window, can reveal a religion, so explicit consent must name it (risk register R-17, N-7). Washington's My Health My Data Act and the FTC Health Breach Notification Rule cover the same data as consumer health data.

## Notice text

<!-- notice-text:start -->

Kitchen Quest can store your allergies, intolerances and diet rules, so it can check recipes for you. This covers rules you keep for religious or cultural reasons, such as halal, kosher, Jain, vegetarian or fasting rules, as well as rules for your health. It also keeps the meals you log, your weekly meal plans and market lists, your own notes on recipes (margin notes), which can show what you can't or won't eat, and your conversations with the Pan for 30 days unless you clear them sooner. Later it can also store your food journeys and symptoms. This is health information, and a religious or cultural diet can also show your beliefs. We encrypt it, never sell it, never use it for ads, and never share it with an employer, school or insurer. You can withdraw this at any time, and you can play without it.

<!-- notice-text:end -->
