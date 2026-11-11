# Task 12b report (M4 Step 12, game-side carries)

Branch claude/m4-step12-game. All gates green: typecheck, lint (0 errors, existing warnings only; arch + knip clean), core 1610, game 670, e2e 188, build.

## 1. Bundle
- Lazy screens (new `shell/lazy.ts` `lazyScreen`): settings, recipes, recipe, cook, map, visit, rules (kitchen stays eager as the landing screen). AI backend loads on first AI reply (`lazyBackend` in mentor/index.ts).
- Market stalls (137 KB of the 290 KB content blob) have no runtime consumer; `kq-content` still validates them but leaves them out of the module (`ClientContent` type).
- Budget: `checkFirstPaintBudget` measures entry + all static imports (transitive), still bans Phaser statically; plugin logs the total. Tests added for transitive total, dynamic imports excluded, shared chunk counted once.
- First paint JS: before ~456 KB (index 397.4 + store 58.2 + runtime 0.6; entry alone was 397 of 400), after 284.3 KB in 8 chunks. Entry chunk itself is 13.7 KB.
- PWA precache is built from the whole bundle, so lazy chunks are precached; pwa e2e green.

## 2. panel.destroy
`destroyed` flag: render() drops late replies (scripted or AI), pending consent card never sets aiHealthOffered. Unit test.

## 3. Axe
`.bubbles` is tabindex=0 with aria-label "Conversation with the Pan". e2e: 14-turn text-only conversation, scrolls, axe clean. Existing tab-order e2e updated (Close -> list -> Undo -> Edit).

## 4. Raise trail + undo
`CardWriter.raiseRule` (writer.ts): tap write, trail entry (own id), undo restores the account rule (PUT original), 404 = nothing to restore, once-only, Family Table refused. Rules screen shows a trail entry with Undo in the status area (the copy section redraws after the write). Unit tests + e2e (raise then Undo sends the original severity).

## 5. Copy
- New trigger `rule.voided.tap` (tap 'Undo' wording) used by the rules-screen removal; `rule.voided` untouched (still core `undoneLine`; packages/core not changed).
- ~45 `ui.rules.*` / `ui.settings.*` single-line triggers in content/dialogue/pan.yaml, read through `content/copy.ts`; all in REQUIRED_PAN_TRIGGERS so the build validates them. Moved: rules screen, rule form, Settings > The Pan sentence-level copy. Not moved: button labels, headings and modal titles, and Pan-panel constants (panel.ts NOT_SAVED_TEXT etc., consent-card).

## 6. Scans
- Pre-stamp no-write-claim test now covers rule.readback, rule.readback.no_spelling, profile.readback, pantry.readback, log.confirm_readback, every intake.*.ask, plus phrasings (it's filed, saved it, on file, noted/written down, filed away), with a self-test of the regex.
- Findings: rule.unknown_term line 4 said "you'd like on file" -> reworded to "you'd like me to check for instead". write.not_done line 3 "Only a card you've stamped is on file" is accurate (explains the stamp), so the test exempts that exact phrase rather than editing the line.
- Compile-time {var} check now covers cook and stall files (declared vars only in triggers; stray {var} elsewhere fails; ai: never must use what it declares). No existing cook/stall line failed.

## Not run
apps/api tests need TEST_DATABASE_URL (no DB here); only content/dialogue/pan.yaml changed on that side (additions plus one reworded line).

## Fix round 1
- C1: `lazyBackend` moved to `mentor/lazy-backend.ts`; when the AI chunk fails to load the turn is answered by the scripted engine, led by `mentor.ai_unavailable` (emergency and rule paths intact); load retried next turn. Tests in `lazy-backend.test.ts`.
- I1/I2: `raiseRule` reads the account rule from the server (`listRules`) before writing, takes `before` from that read, and refuses (closed, `rule.raise_not_stricter`, no PUT) unless the card is strictly stricter for the same type and target. Undo re-reads and only writes `before` back if the rule still equals what the raise wrote; otherwise nothing changes (`undo.rule_changed`); never lowers. Tests: stale screen, stale before, change after raise, removed rule, failed undo keeps entry.
- M1: the "on file" exemption is now one exact id+line. M2: claim regex adds "'s/has been filed", bare "Noted."/"Saved.", "in the ledger", with self-tests.
- M3: "If you leave this...", "Chosen:", "Stamped:" moved to `ui.rules.*` triggers.
- M4: undo failure/404 paths tested; misleading test replaced.
- M5: `shell/titles.ts` is the single source of lazy titles, with a test that each module agrees; `lazyScreen` tests (failed load rejects so the shell shows its error screen).
- Gates: typecheck, lint (0 errors), core 1610, game 683, build (first paint 286.2 KB), e2e 188 all green.

## Fix round 2
- N1: `scriptedWhenUnavailable` moved to `mentor/outage.ts` and tested directly (engine reply kept, cards present); `lazy-backend.test.ts` now uses the shipped functions.
- N2: new `withNotice`: an emergency, medical or child line always leads, the "answering from the script"/rate-limit notice follows it. Used by the lazy fallback and by ai-backend (`prefixed`, so the :146 and :207 paths). Per-path tests: lazy fallback, server `ai_unavailable` notice, unreachable server; the test that pinned the wrong order was replaced.
- N3: emergency, medical and child text is answered from the script before the AI chunk is awaited (`localSafetyReply`); the load also times out after 8 s (script answers; the same load is awaited next turn). Note: for signed-in AI players these three turn types are now answered locally with the same fixed lines the server uses, not sent to the server.
- N5: new `rule.raise_gone` for a rule gone or replaced on the server; `rule.raise_not_stricter` only for a same-or-lower level.
- N6: tests for the raise's and undo's same-rule checks (different target, different type, gone).
- N7: a raise keeps the account rule's `note`; undo restores the whole earlier rule (tested).
- N4 left alone as instructed (needs a server conditional write).
- Gates: typecheck, lint (0 errors), core 1610, game 695, build (first paint 287.2 KB), e2e 188.

## Fix round 3
- F1: `createLocalSafety` (mentor/outage.ts) keeps a sticky child flag per AI conversation: once a child turn is seen, every later text turn is answered locally with `child.grownup` and never reaches the AI backend; an emergency in a child conversation gets the emergency line with no rule ask. The flag resets with a new AI backend and on `clearConversation()`.
- F2: every locally answered turn is also posted to `/mentor/turn` in the background (serial queue, reply ignored except the conversation id, failures swallowed). The AI backend now shares the conversation id (`conversation` dep), so the server's child flag and turn counter advance in the same conversation.
- F3: the local emergency answer matches turn.ts: emergency line, then `emergencyRuleAsk` when the message states a rule (no card), no ask once a child spoke; an emergency does not set the child flag. Medical gets the deflect line.
- F4: tests: outage.test.ts (all of the above, failing background post), lazy-backend.test.ts, and mount-safety.test.ts through the real `mountMentor` wiring (S23 then "I'm allergic to eggs": no consents call, no card, both turns posted in one conversation). Mutations checked: removing `local:` from index.ts and removing the sticky flag each fail tests.
- Note: a signed-in AI player's emergency/medical/child text is posted to the server only in the background; the visible answer is local.
- Gates: typecheck, lint (0 errors), core 1610, game 703, build (first paint 288.2 KB); e2e see below.
- e2e: 187/188 in two full runs with the world-map pin-size test failing (320 and 400 widths, a layout measurement; the other tree was running e2e on the same machine). e2e/world alone: 19/19. Not touched by this change.

## Fix round 4
Controller ruling applied: the round-3 background post queue is gone. Locally answered safety turns now go to the server only through the loaded AI backend's own queue.
- `createLocalSafety` (outage.ts) sends nothing. It takes only `dialogue` and `graph`, and returns `{ reply, deliver }`. `deliver` is true only when the turn's own intent is emergency, medical or child. A turn answered with `child.grownup` only because of the sticky flag is `deliver: false` and is never sent anywhere (G2).
- `lazyBackend` still returns the local reply before loading or awaiting anything (emergency line first; child before AI). When `deliver` is true and the AI backend is already loaded (and not disposed), it calls `real.deliver(input, ctx)`. If the chunk is not loaded, nothing is delivered and nothing is queued for later.
- `createAiBackend` puts every text turn, the one retry and every delivered turn on one serial queue (`serial`), entered in arrival order. Each step reads the conversation id the step before it set (G3).
  - `deliver` applies the same consent gate as a normal turn (`isHealthTurn`, then `hasAiHealth`), so health text without `ai_health` stays on the device (G1).
  - The server's reply to a delivered turn is never shown. Only its conversation id is kept.
- G4: `ConversationRef` gained `gen`. `newConversation(ref)` nulls the id and bumps `gen`, and a reply already in flight no longer writes its old id back. `clearConversation()` → `resetChild` now resets the child flag and calls `newConversation`.
- G5: a queued delivery, or a queued text turn, is dropped once the backend is disposed. A dropped text turn is answered by the script. A delivery that waited on the consent check re-checks after it.
- G6, tests:
  - `mount-safety.test.ts` runs through the real `mountMentor`, with a fresh module per test, and covers the review's probes:
    - no chunk: S23 and the egg turn are local and nothing is posted;
    - no consents: neither the emergency nor the medical turn is posted;
    - "im 8" then "what should I cook tonight": the second turn is never sent;
    - an emergency, a medical turn and "hello" sent 5 ms apart reach the server in order, under one new id, with the server replies not shown;
    - a "yes" after an emergency is sent after it;
    - turning the AI off drops a queued delivery;
    - `clearConversation` gives the next turn no id and is not on the grown-up line.
  - `ai-backend.test.ts` covers the deliver gate and hidden reply, a clear while a reply is in flight, a dispose while turns are queued, and the retry waiting its turn. `outage.test.ts` covers the `deliver` flag and `newConversation`.
- Mutations, each killed (game `src`, 604 tests): `conversation` not passed to `createAiBackend`; `onClear` not called; `safety = mine` removed; `newConversation` on clear removed; `reply` not queued; the deliver consent gate removed; the deliver dispose check removed; the `gen` guard removed; the retry not queued; the disposed text-turn check removed; `deliver` ignored in lazy; the `real.deliver` call removed; `deliver` always true; the sticky flag removed.
- Also: knip flagged `LOAD_TIMEOUT_MS` as an unused export. The flag was already present at 29b3429. The lazy-backend test now uses the constant.
- Gates:
  - typecheck and lint pass (0 errors).
  - Tests: core 1610, game 713, API 892.
  - Build passes (first paint 287.9 KB).
  - e2e: two full runs were each 187/188. The first failed "severe coconut … pin stays on the map" and the second failed the known "pins are at least 44px" at width 320. The machine was loaded (load average about 6) and the other tree was using port 4173. `e2e/world` alone passed 19/19 twice. The mentor e2e passed in both full runs.
- N4 not touched.

## Fix round 5
Controller rulings H1–H3 applied (review-task12b-fix4.md).
- H1 (a): `createApiClient` gives `mentorTurn` and `consents` a client timeout (`AbortSignal.timeout`, 20 s, `timeoutMs` option for tests). This covers both the headers and the body. A timed-out call settles as `status 0` with code `timeout`, which the AI backend treats as an outage. So a hung delivery always settles and the queue moves on. Other calls are not timed.
- H1 (b): `dispose()` settles a `gone` promise. Every server call inside a queue step races it (`unlessGone`: `mentorTurn`, `consents`, and `refreshAccount` on a 401). A hung step lets go at once, and every step behind it is answered by the script (`answer` checks `isDisposed` first), so nothing is sent after AI off.
- H1 (c): the panel's submit takes an emergency, medical or child text (core `classifyTurn` on the stripped text) even while a turn is pending, and it is answered at once on the device. Any other text stays in the box while a turn waits.
  - Send is no longer disabled while pending, so a click can always send an emergency.
  - `aria-busy` and the "thinking" status are unchanged.
  - Pending is a count, so an answered emergency does not clear another turn's pending state.
- H2:
  - The panel keeps a clear epoch. A turn reply, a card write, a turn-down or an undo that started before `clearConversation()` is dropped when it lands.
  - A server-card tap now names the current conversation. Core `ConfirmRequest.conversationId`, the client's `confirmProposal(id, edits, conversationId)`, and the writer's `conversationId` dep (wired in index.ts to the shared ref) carry it.
  - `confirmProposalIn` (API) closes a proposal from any other conversation, or from none, with 409 `proposal_closed`, and writes nothing. A tap that names no conversation is unchanged.
  - After a clear the ref is null, so any older card is refused.
- H3: `scheduleRetry` captures `gen` when it schedules. `retry` drops itself if the conversation was cleared before it runs, and when its reply lands after a clear it shows nothing and keeps no id.
- Tests:
  - mount-safety.test.ts runs the reviewer's probe through the real `mountMentor` and the real API client over a fake fetch:
    - a hung delivery, then a normal turn (pending), then "he's not breathing": the emergency line shows at once;
    - after the client timeout the queue settles, the waiting turn is sent and answered, and pending clears;
    - with a hung delivery, turning the AI off answers the waiting turn and the panel works again;
    - the tap carries the shared conversation id.
  - client.test.ts: the timeout for headers and for the body; `conversationId` in the confirm body.
  - ai-backend.test.ts: dispose releases a hung turn, a hung consents read and a hung account refresh; a retry is dropped after a clear, before it runs and while it is on its way.
  - panel.test.ts: a safety text while pending; an ordinary text waits; replies, writes, turn-downs and undos after a clear are not drawn.
  - writer.test.ts: the current id is passed.
  - API mentor-confirm: other conversation, null and none give 409; the same conversation and no field give 200.
  - The e2e tap-body expectation now includes `conversationId`.
- Mutations, each killed: either timeout removed; the signal removed; `release()` removed; `unlessGone` removed from `send`, `consents` or `refreshAccount`; either `gen` check in retry removed; the panel's safety bypass removed or the pending gate dropped; the panel's epoch check or bump removed; the confirm, reject or undo after-clear checks removed; the writer or index.ts conversation wiring removed; the server conversation check removed (API).
- Two guards were removed as redundant, because their mutations survived: the serial chain's own race on `gone` (every call in a step already races it), and the retry's fire-time `gen` check (`retry` checks first thing).
- Gates:
  - typecheck and lint pass (0 errors).
  - Tests: core 1610, game 729, API 893.
  - Build passes (first paint 288.3 KB).
  - e2e 188/188.
- N4 not touched.
