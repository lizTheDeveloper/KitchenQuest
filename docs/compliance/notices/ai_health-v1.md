# `ai_health` consent notice, v1

- Purpose: `ai_health` (C-1, C-13)
- Version: `v1`
- SHA-256 of the notice text: `16776b9bc7820788da5e58b2a2462fcbabcbcd08c386165a1ff7fe6fe8d37d31`
- Status: DRAFT wording, pending lawyer review (C-30). In force from M4 Step 6.
- Replaces: the inline notice of version `2026-11-09`, which named neither the Pan nor meals. Grants under it no longer count (`ACCEPTED_VERSIONS.ai_health` is `['v1']`): the player is asked again.

The API serves the paragraph between the two markers below (without the blank lines around it), byte for byte, as the `ai_health` notice (`apps/api/src/consent/notices.ts` reads this file at boot). Each grant records this version and the SHA-256 of that text in `consents.notice_version` and `consents.notice_sha256`.

**Never edit the text of this file.** A change of even one character changes the hash and breaks the record. Write `ai_health-v2.md` with a new version instead, and set `ACCEPTED_VERSIONS.ai_health` in `apps/api/src/consent/notices.ts` to the versions that still count. `apps/api/test/consent.test.ts` fails if the text and the declared hash disagree.

## What it covers

The consent form is `consent_ai`, "Permission for the AI to See Your Rules and Meals" (`content/bureau/forms.yaml`). With this consent the Pan's AI turns may carry the player's rules and severities and what they say about their meals, minimised and without identifiers (C-13, P-3), to the pinned no-retention providers (C-14). Without it, health turns never reach the model: the scripted path handles them (README Ruling 3), and every suggestion is still checked by the rules engine (§2.1).

## Notice text

<!-- notice-text:start -->

Let the Pan and the cooks, who are AI characters, see your allergies, diet rules and what you tell them about your meals, so their help fits you. Only what a reply needs is sent, without your email or name, to an AI provider that may not keep it or train on it. Without this, the Pan still works: allergies and meals are handled by the Bureau's written script, and every suggestion is still checked against your rules on our side.

<!-- notice-text:end -->
