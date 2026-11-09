# `health_data` consent notice, v1

- Purpose: `health_data` (C-1)
- Version: `v1`
- SHA-256 of the notice text: `7320fd578ec315b852065cb31622479596f1662ede92e07539c0952f33a6f00a`
- Status: DRAFT wording, pending lawyer review (C-30). In force from M2 Step 9 (N-7).
- Replaces: the inline notice of version `2026-11-09`, which did not name religious or cultural diets.

The API serves the paragraph between the two markers below (without the blank lines around it), byte for byte, as the `health_data` notice (`apps/api/src/consent/notices.ts` reads this file at boot). Each grant records this version and the SHA-256 of that text in `consents.notice_version` and `consents.notice_sha256`, so the ledger shows exactly which words the player agreed to.

**Never edit the text of this file.** A change of even one character changes the hash and breaks the record. Write `health_data-v2.md` with a new version instead, and set `ACCEPTED_VERSIONS.health_data` in `apps/api/src/consent/notices.ts` to the versions that still count: a grant under any other version stops counting (403 `consent_required` on health writes, `needsReconsent` in `GET /me/consents`), the player is asked again, and the new grant ends the old one as `superseded`. `apps/api/test/consent.test.ts` fails if the text and the declared hash disagree.

## Why it names religious and cultural diets

GDPR Art. 9 covers data revealing religious or philosophical beliefs as well as health data. A halal, kosher or Jain rule, or a fasting window, can reveal a religion, so explicit consent must name it, not only "allergies and diets" (risk register R-17, N-7). Washington's My Health My Data Act and the FTC Health Breach Notification Rule cover the same data as consumer health data.

## Notice text

<!-- notice-text:start -->

Kitchen Quest can store your allergies, intolerances and diet rules, so it can check recipes for you. This covers rules you keep for religious or cultural reasons, such as halal, kosher, Jain, vegetarian or fasting rules, as well as rules for your health. Later it can also store your food journeys, symptoms and meal logs. This is health information, and a religious or cultural diet can also show your beliefs. We encrypt it, never sell it, never use it for ads, and never share it with an employer, school or insurer. You can withdraw this at any time, and you can play without it.

<!-- notice-text:end -->
