# `voice` consent notice, v1

- Purpose: `voice` (C-1, C-18)
- Version: `v1`
- SHA-256 of the notice text: `9e9b330fe375fda0565d1486326f7984d7019a02ba71308abfada9be3f96e42d`
- Status: DRAFT wording, pending lawyer review (C-30). In force from M7 Step 4.
- Replaces: the inline notice of version `2026-11-09`, which said neither that no voiceprint is made, that what is said is kept as conversation text only, that text always works, nor that children never use the microphone. Grants under it no longer count (`ACCEPTED_VERSIONS.voice` is `['v1']`): the player is asked again on first microphone use.

The API serves the paragraph between the two markers below (without the blank lines around it), byte for byte, as the `voice` notice (`apps/api/src/consent/notices.ts` reads this file at boot). Each grant records this version and the SHA-256 of that text in `consents.notice_version` and `consents.notice_sha256`.

**Never edit the text of this file.** A change of even one character changes the hash and breaks the record. Write `voice-v2.md` with a new version instead, and set `ACCEPTED_VERSIONS.voice` in `apps/api/src/consent/notices.ts` to the versions that still count. `apps/api/test/consent.test.ts` fails if the text and the declared hash disagree.

## What it covers

C-18 asks for a separate `voice` consent on first microphone use. With it, the game may capture the player's speech (hold-to-talk; hands-free only in cook mode, once the browser echo checklist has passed, README Ruling 7) and stream it to the self-hosted speech service (`apps/voice`, on Hetzner in the EU), which turns it into text in memory and never writes audio or partial transcripts to disk or logs (spec §7.7, C-18). The service gets no user id. No speaker identification or voiceprint is ever made (P-7). The final transcript is treated as typed text: it reaches the Pan, and is kept as conversation text, only as a typed turn would be (C-12, C-13). Text input never disappears (§7.7). In Family Table mode, and once any child flag is set, the microphone is never opened (§19, README Rulings 9 and 17).

This consent is about the microphone only. The self-declared accessibility need that makes voice unmetered is health data and needs `health_data`, not this consent (C-19, README Ruling 6).

## Notice text

<!-- notice-text:start -->

Use your microphone to talk to the Pan and the cooks instead of typing. Only while you are speaking, the sound goes to our own speech servers in the EU (Hetzner), which turn it into text in memory: the audio is never stored, and no voiceprint is made, so nothing recognises you by your voice. What you say is kept only as the text of your conversation, exactly as if you had typed it, under the same rules. Typing always works, and you can turn the microphone off at any time. Children never use the microphone: in Family Table mode it stays off.

<!-- notice-text:end -->

## `[lawyer]` flags (M7 Step 11; outside the served text, which is unchanged)

- `[lawyer]` **"the audio is never stored"**: true as built. Audio lives in memory on the device (frames handed to the socket), in the API (forwarded, then zeroed) and in the speech service (no disk, no swap-backed buffers, `LimitCORE=0`, no logging); memory-only tests with positive controls in `apps/voice`, `apps/api` and the game e2e (`voice.e2e.test.ts`: no transcript or audio in any browser store). Confirm the claim may be made in these words, and whether in-memory processing of speech (and the STT vocabulary hint drawn from the player's rules and pantry) is biometric or health processing that needs more than this consent (ROADMAP `[lawyer] M7 in-memory audio and hints`).
- `[lawyer]` **"no voiceprint is made"**: no speaker identification, diarisation or voice embedding exists anywhere (P-7). Confirm the wording.
- `[lawyer]` **"our own speech servers in the EU (Hetzner)"**: Hetzner is a processor (`processors.json`, `hetzner`), not "our own" hardware. Confirm "our own speech servers" is accurate enough for a rented, self-administered server, or reword in v2.
- `[lawyer]` **"Children never use the microphone"**: the device never opens it in Family Table mode or once a child flag is set, and the API refuses a voice socket while either is reported (README Rulings 9 and 17; per device for Family Table). The gap recorded in `dpia.md` §6.1 (a Family Table device that is wrong *and* never reported) remains. Confirm the sentence is not an over-claim.
- `[lawyer]` The notice does not mention the accessibility need, the free allowance or the abuse ceiling; those are under `health_data` and Settings copy (C-19, C4). Confirm no voice-notice change is needed for them.
