# `health_data` consent notice, v2

- Purpose: `health_data` (C-1)
- Version: `v2`
- SHA-256 of the notice text: `edbb7e2f31ddde8f1bcbbc2db84f19682e64a5bfc81ef309dd9cef728ad23143`
- Status: DRAFT wording, pending lawyer review (C-30). In force from M4 Step 6.
- Replaces: `health_data-v1.md`. Grants under v1 no longer count (`ACCEPTED_VERSIONS.health_data` is `['v2']`): the player is asked again. There were no real users when it changed.

The API serves the paragraph between the two markers below (without the blank lines around it), byte for byte, as the `health_data` notice (`apps/api/src/consent/notices.ts` reads this file at boot). Each grant records this version and the SHA-256 of that text in `consents.notice_version` and `consents.notice_sha256`, so the ledger shows exactly which words the player agreed to.

**Never edit the text of this file.** A change of even one character changes the hash and breaks the record. Write `health_data-v3.md` with a new version instead, and set `ACCEPTED_VERSIONS.health_data` in `apps/api/src/consent/notices.ts` to the versions that still count. `apps/api/test/consent.test.ts` fails if the text and the declared hash disagree.

## What changed from v1

v1 said meal logs would come "later". From M4 the game keeps the meals the player logs (data inventory H-7) and, only with this consent, the player's conversations with the Pan, sealed, for 30 days unless cleared sooner (I-1, C-12). Without this consent a conversation is held in memory only and never stored. The words now say both, so the consent names what is actually kept.

## Why it names religious and cultural diets

As in v1: GDPR Art. 9 covers data revealing religious or philosophical beliefs as well as health data. A halal, kosher or Jain rule, or a fasting window, can reveal a religion, so explicit consent must name it (risk register R-17, N-7). Washington's My Health My Data Act and the FTC Health Breach Notification Rule cover the same data as consumer health data.

## Notice text

<!-- notice-text:start -->

Kitchen Quest can store your allergies, intolerances and diet rules, so it can check recipes for you. This covers rules you keep for religious or cultural reasons, such as halal, kosher, Jain, vegetarian or fasting rules, as well as rules for your health. It also keeps the meals you log, and your conversations with the Pan for 30 days unless you clear them sooner. Later it can also store your food journeys and symptoms. This is health information, and a religious or cultural diet can also show your beliefs. We encrypt it, never sell it, never use it for ads, and never share it with an employer, school or insurer. You can withdraw this at any time, and you can play without it.

<!-- notice-text:end -->
