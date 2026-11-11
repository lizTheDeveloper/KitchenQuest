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
