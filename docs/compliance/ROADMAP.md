# Compliance & security roadmap

Kitchen Quest is a **consumer** app for individuals, not a clinical tool. It stays **outside HIPAA by design** (product rules P-1–P-14 in `2026-11-09-health-data-compliance.md`). The regimes that apply are the FTC Act §5, the FTC Health Breach Notification Rule, Washington MHMDA, Nevada SB 370, Connecticut consumer health data rules, GDPR Art. 9 (if EU users), and COPPA risk (family mode). We never market the app as "HIPAA compliant".

Standing instruction from the founder (2026-11-09): anything a health-data or privacy law calls for is done without asking, and added here.

Milestone numbering follows spec §13: M3 = game shell, **M4 = mentor/AI** (the compliance report's "M3 mentor" items land in M4).

Tick each item when it lands. Full requirement text is in `2026-11-09-health-data-compliance.md` §6, matched by id.

- [x] **C-1** Consent ledger — *M2* — `plans/m2-api/step-2c.md` (new); README Global Constraints
- [x] **C-2** Key ring and rotation — *M2* — `plans/m2-api/step-2c.md`; `apps/api/src/config.ts`; `.env.example`
- [x] **C-3** Bind ciphertext to context — *M2* — `plans/m2-api/step-2c.md`; amend Step 5 storage line
- [x] **C-4** Per-user data keys (crypto-shredding) — *M2 recommended; at the latest before M12 launch, while no real data exists* — `plans/m2-api/step-2c.md`
- [x] **C-5** Content-free access and security audit log — *M2* — `plans/m2-api/step-2c.md`; amend Step 3 (sign-in events), Step 7 (export and delete events)
- [x] **C-6** Retention job — *M2 (framework); each later milestone registers* — `plans/m2-api/step-2c.md`
- [x] **C-7** Complete export — *M2* — amend `plans/m2-api/step-7.md`
  - Landed in M2 Step 7 (`GET /me/export`). **Open: confirm with counsel** that usage exported as per-feature totals (events, units, cost, first and last time), rather than one row per `usage_events` event, satisfies GDPR Art. 15 and MHMDA access.
- [ ] **C-8** Complete delete — *M2* — amend `plans/m2-api/step-7.md`
  - Done in M2 Step 7 (`DELETE /me`): user delete with cascade (sessions revoked, `user_keys` crypto-shredded), `login_tokens` by email, `audit_events` pseudonymized, one transaction.
  - **Remaining, so not ticked:** the processor-deletion queue. Mail-provider suppression-list and recipient deletion (A-10 in `data-inventory.md`) when the provider is chosen (*M12*); object-storage photo deletion (C-20) in *M8*.
- [x] **C-9** Log and error redaction — *M2* — `plans/m2-api/step-2c.md`; amend Step 5 (test)
- [x] **C-10** Org/health separation constraint — *M2 (constraint); M12 or the org plan (tables)* — `plans/m2-api/README.md` Global Constraints
- [ ] **C-10b** Session hygiene — *M2 (Step 3) or M12* — amend `plans/m2-api/step-3.md`
- [ ] **C-11** E2E consent and free-forever test — *M2* — amend `plans/m2-api/step-8.md`, Step 5, README error codes
- [x] **M4 mentor** — *M4* — `plans/m4-mentor/README.md`. Step 12 ticked what landed: C-12–C-17 and N-4, N-9; C-34 and C-39 are `[~]` (the DPA, and the M12 parts, stay open).
- [x] **M5 weekly loop** — *M5* — `plans/m5-loop/README.md`. Step 12 ticked what landed: N-7's remainder (Cooked for Someone labels), the M5 ledgers below (U-5, H-11, H-12, H-13, L-5), the DPIA re-review (N-11, `dpia.md` §6.1) and R-35; C-45 is `[~]` (reserved in M5, built in M13). `reward_grants` is append-only by a database trigger (risk-register N-12). Open: the M5 `[lawyer]` items below.
- [x] **C-12** Conversation storage — *M4* — `plans/m4-mentor/step-6.md`: `messages` sealed per user and row, stored only with `health_data` consent (memory-only otherwise), 30-day retention job, "forget this conversation" (`DELETE /mentor/conversations`), in export and delete; never used for training
- [x] **C-13** AI gateway minimization and consent — *M4* — `plans/m4-mentor/step-7.md`: typed `PromptContext`, health fields and the pantry only with `ai_health`, no identifiers or dates, health turns never reach the model without `ai_health`; prompt tests assert it
- [x] **C-14** OpenRouter data policy pinned in code — *M4* — `plans/m4-mentor/step-4.md`; `apps/api/src/ai/openrouter.ts`: every body carries `data_collection: "deny"`, `zdr: true` and the allow-list; never a `:free` model; config refuses to boot without it. Code part only: the parameter-name check and the account-level settings are in `vendors/openrouter.md` as founder actions
- [x] **C-15** No AI content logging — *M4* — `plans/m4-mentor/step-4.md`, `step-7.md`, `step-8.md`: only `usage_events` (counts, cost); the provider logs failure kind and status only; log-capture tests across the mentor suites. The eval (`npm run eval:mentor`) uses synthetic players in a throwaway database
- [x] **C-16** AI disclosure — *M4* — `plans/m4-mentor/step-11.md`: the verbatim line on first open (pinned in the conversation) and in Settings
- [x] **C-17** Consent before the intake interview collects health data — *M4* — `plans/m4-mentor/step-11.md`: a tap consent card (Form 3-C) before Form 1-A asks about allergies; skippable; the read-back stays
- [ ] **C-18** Voice privacy — *M7* — `plans/m7-voice/README.md`
- [ ] **C-19** Voice accessibility flag is sensitive — *M2 (if added to profile in Step 4) / M7* — amend `plans/m2-api/step-4.md` if adopted there
- [ ] **C-20** Photos — *M8* — `plans/m8-ai-features/README.md`
- [ ] **C-21** Ingestion fetch hardening — *M8* — `plans/m8-ai-features/README.md`
- [ ] **C-22** Rule expansion minimization — *M8* — `plans/m8-ai-features/README.md`
- [ ] **C-23** Tracker tables sealed — *M9* — `plans/m9-tracker/README.md`
- [ ] **C-24** Notifications carry no health content — *M9* — `plans/m9-tracker/README.md`
- [ ] **C-25** Household Kitchen privacy — *M9* — `plans/m9-tracker/README.md`
- [ ] **C-26** Player-initiated clinician share — *M9 or later* — `plans/m9-tracker/README.md`
- [ ] **C-27** Low-intake check-in stores no label — *M9* — `plans/m9-tracker/README.md`
- [ ] **C-28** Pantry location and geofencing — *M11* — `plans/m11-neighborhood-pantry/README.md`
- [ ] **C-29** Pantry moderation data — *M11* — `plans/m11-neighborhood-pantry/README.md`
- [ ] **C-30** Policies — *M12* — `plans/m12-launch/README.md`
- [ ] **C-31** Data-rights workflow — *M12* — `plans/m12-launch/README.md`
- [ ] **C-32** Breach and incident runbook — *M12* — `plans/m12-launch/README.md`; `docs/compliance/incident-runbook.md` (to write)
- [~] **C-33** Risk assessment and DPIA — *Start M2 (data inventory); finish M12* — `docs/compliance/` (inventory, risk register and DPIA skeleton started)
- [~] **C-34** Vendor reviews and DPAs — *M4 (OpenRouter), M12 (all)* — `plans/m4-mentor/step-4.md`, `step-12.md`; `vendors/openrouter.md`; `plans/m12-launch/README.md`. The code gate is in (production refuses AI until `processors.json` says signed) and the review checklist is written; **open: the OpenRouter DPA is not yet signed** (founder action), and every other processor is M12
- [ ] **C-35** Backups — *M12* — `plans/m12-launch/README.md`
- [ ] **C-36** Operator MFA — *Now (accounts); M12 (audit)* — `plans/m12-launch/README.md`
- [~] **C-37** (CI part done: Dependabot + `npm audit --audit-level=high`; pen test pending) Vulnerability management — *Now (CI); M12 (pen test)* — `.github/workflows/ci.yml` (later); `plans/m12-launch/README.md`
- [ ] **C-38** Network and transport — *M12 (deploy)* — `plans/m12-launch/README.md`
- [~] **C-39** Age and children — *M4 (onboarding, chat guard) / M12* — `plans/m4-mentor/step-3.md`, `step-7.md`, `step-10.md`; `plans/m12-launch/README.md`. Neutral age screen (birth year used once, never sent), the chat child guard (`child.grownup`, nothing kept) and Family Table scripted-only are in; **open (M12): the actual-knowledge procedure and the child-directedness review**
- [ ] **C-40** Strict Content-Security-Policy — *M4 game shell / M12* — `plans/m12-launch/README.md` (and the M4 plan when written)
- [ ] **C-41** Ownership and contact — *Now* — `plans/m12-launch/README.md`
- [ ] **C-42** Workforce access — *M12* — `plans/m12-launch/README.md`
- [ ] **C-43** Claims review — *M12* — `plans/m12-launch/README.md`
- [~] **C-45** Family mode data (§19) — *M5 (reserve) / M13* — reserved M5 (consent subject columns, `plans/m5-loop/step-7.md`); build M13 (`plans/m13-family/README.md`). **M5 reserve done (Step 7, Ruling 19):** `consents.subject_kind` (`'user'` only, by a check) and a null `consents.subject_id`; no child table or child data (P-9); `data-inventory.md` K-4. Family Table keeps nothing from the loop (Ruling 25, C31). M13 builds the rest
- [ ] **C-46** Security headers from the server/host (renumbered from a second C-45 in the M5 final review, m13): CSP with `frame-ancestors 'none'`, HSTS, `X-Content-Type-Options`, `Referrer-Policy` (the game's meta CSP can't carry frame-ancestors) — *M12 (deploy)*
- [x] **N-3 (partial)** Game store: CSP meta, "delete data on this device", rescue copies capped — *M3 Task 3*
- [ ] **C-44** Region gating — *M12* — `plans/m12-launch/README.md`

## Additional requirements from the risk register (N-1–N-11, `risk-register.md` §6)

- [x] **N-1 (M2 part)** Mailer sends one plain-text part, exactly one URL (the verify link) and no health content, tested; provider settings (tracking and link rewriting off, log retention, SPF/DKIM/DMARC) written down in `mail-provider.md` — *M2 Step 9*
- [ ] **N-1 (remainder)** Choose the provider and apply `mail-provider.md` there (tracking and rewriting off, retention, DNS records for SPF/DKIM/DMARC), suppression-list deletion call in the C-8 processor-deletion queue — *M12*
- [x] **N-2 (M2 part)** Rate-limit state is in memory, IP/email/user-id keyed and swept within 1 h 1 min (timer sweep, tested); API request log is route patterns only (C-9); access-log retention (14 d, max 30) registered in `data-inventory.md` §3.14 — *M2 Step 9*
- [ ] **N-2 (remainder)** Configure the reverse proxy's access log (no query strings, 14 d retention) and the log host's retention; state the periods in the privacy notice — *M12 (C-38, C-30)*
- [ ] **Deploy (from Step 9)** Ship `docs/compliance/` (`notices/`, `processors.json`) in the API image: the API reads both at boot and will not start without them — *M12 (deploy)*
- [ ] **N-3** Offline PWA store hygiene: cache the minimum, clear on sign-out — *M3 game shell / M9*
- [x] **N-4** The AI retry queue holds no content, or holds it sealed with a 24 h cap — *M4* — `plans/m4-mentor/step-10.md`: there is no content queue; the client holds unsent text in memory only (one retry, then "Try again")
- [ ] **N-5** Inactive-account policy: notify, then delete after about 24 months **[lawyer]** — *M12*
- [ ] **N-6** Contributor ids are personal data: notice, contributor agreement, removal path — *M2 Step 6 / M10*
- [x] **N-7** Consent copy names religious dietary rules; meal-window names become a fixed set (breakfast/lunch/dinner/snack/other), not free text; free-text caps — *M2 Step 9* (notice `notices/health_data-v1.md`, grants under older versions no longer count; caps in `data-inventory.md` §3.13. "Cooked for Someone" labels decided in M5: fixed sets, no names, `plans/m5-loop/step-7.md` (Ruling 10): fixed choices only, a count (`just_me`, `one`, `two_to_three`, `four_plus`) and optionally one fixed word, no names or free text; `data-inventory.md` H-13, R-19)
- [x] **N-8** CI check that every `schema.ts` column appears in `data-inventory.md` — *M2 Step 9* (`apps/api/test/inventory.test.ts`)
- [x] **N-9** `processors.json` validated in CI; no processor call merged while its DPA is unknown — *M4* — `plans/m4-mentor/step-4.md`, `step-12.md`: `test/processors.test.ts` validates the register and maps every outbound host (`https://` and `http://` literals; no `new URL(` from a variable) to a processor; the OpenRouter client is merged fail-closed: production won't boot with AI on until its `dpa_status` is `signed`
- [ ] **N-10** Child-directedness review also covers the marketing site and store listings — *M12*
- [ ] **N-11** DPIA re-review triggered by any new processor, AI feature, region, consent purpose, Pantry or family build — *process* (re-reviewed for the M4 mentor and the M5 weekly loop: `dpia.md` §6.1)

## Raised during implementation

- [ ] **C-42** Separate DB roles: the app connects as a non-owner role with no UPDATE/DELETE on `audit_events`; migrations and SECURITY DEFINER maintenance run as owner — *M12 (deploy)*
- [ ] **C-43** Backup-restore replays `account.delete` audit events so deleted users' wrapped keys aren't resurrected — *M2 Step 7 (write event) / M12 (restore runbook)*
- [ ] **C-44** GlitchTip SDK added with `before_send` scrubbing (C-9 completion) — *M12*
- [x] **M5 progress ledgers (U-5)** — *M5 Step 5* — `progress_events` and `reward_grants` in `data-inventory.md` U-5 and §6 (N-8), in the export (`progress.events`, `progress.grants` with their day, `progress.view`, GDPR Art. 15/20, MHMDA access) and removed by account delete (cascade, Art. 17). GDPR Art. 9/17 and MHMDA for the one health-revealing kind (fix round 1): a `meal_logged` event is accepted only while `health_data` is granted and only for one of the player's own meal logs (`progress_events.meal_log_id`, one event per log); deleting the meal log (undo) cascades to its event in the same transaction, server-side, and a `health_data` withdraw-with-delete erases them all (no row or content kept). Grants are kept so nothing earned is taken back (spec §6), and hold no time finer than the day and no client-chosen text (client ids must be UUIDs). Abuse limits: 60 requests a minute, the M4 daily write cap, dates from 2026-01-01. Content-free by construction: strict event shapes, every id checked against the catalogue, counts-only audit (`progress.record`), nothing in a URL or a log (C-9). Never read by entitlement code (never rule 3).
- [x] **M5 plans and market runs (H-11)** — *M5 Step 6* — `meal_plans` and `market_runs`, sealed S-U per row, in `data-inventory.md` H-11, §3.13 and §6 (N-8); in the export decrypted (`plans`, `marketRuns` with the pantry row each tick added; GDPR Art. 15/20, MHMDA access); removed by account delete (cascade, Art. 17), by `DELETE /plans/:weekStart`, and **8 weeks after the plan week ends** (C-6 job, `PLAN_RETENTION_WEEKS`; minimisation, Art. 5(1)(c)/(e)). Treated as **health data** (conservative, Art. 9 and MHMDA: dishes and listed swaps can reveal a diet, religion, allergy or condition): every write needs `health_data` (403 otherwise), and they are in `HEALTH_TABLES`, so a withdraw-with-delete erases them. Pantry rows gain an optional purchase date and source (`addedOn` within [today − 60, today + 1]); the pantry stays contract basis. Content-free audit, nothing about food in a URL or a log (C-9, P-5).
- [ ] **[lawyer] M5 plans and market runs** — confirm that weekly plans and market lists are consumer health data (built as `health_data`, the conservative choice); if counsel rules them contract like the pantry, drop them from `HEALTH_TABLES` and the write gate (no data change). Also: a tick moves an item into the contract-basis pantry, where it stays after a health_data delete (food names only, no rule-derived swap label) — *M5 / before M12 launch*
- [x] **M5 margin notes and Cooked for Someone (H-12, H-13)** — *M5 Step 7* — `margin_notes` and `shared_table`, sealed S-U per row with AAD, in `data-inventory.md` H-12, H-13, §3.13 and §6 (N-8); in the export decrypted (`marginNotes`, `sharedTable`; GDPR Art. 15/20, MHMDA access); removed by account delete (cascade, Art. 17) and by `DELETE /notes/:id`, `DELETE /shared-table/:id`. **Margin notes are health data** (Ruling 9, Art. 9 and MHMDA): every write needs `health_data` (403 otherwise), they are in `HEALTH_TABLES` (a withdraw-with-delete erases them), and the `health_data` notice moves to **v3**, naming them (and plans and market lists); v2 grants no longer count, so the player is asked again. Every field is sealed, the recipe slug included (no plain column). At most 20 notes per recipe, none on a sacred dish; `GET /notes` takes no query, so no recipe slug is in a URL (P-5, C32). **Cooked for Someone holds no names** (Ruling 10, R-19): fixed values only, contract basis, counts-only tally (C21). Neither feeds a reward, trust or a gate (M-9; an architecture test keeps `book/` and `progress/` apart). Content-free audit, nothing in a log (C-9). Family Table writes are skipped by the game (C31, Step 11): the server cannot tell a Family Table session.
- [ ] **[lawyer] M5 margin notes** — confirm the `health_data` notice v3 wording (`notices/health_data-v3.md`). (The recipe slug question is closed: Step 7 fix round 1 seals it inside the note, with no plain column or keyed hash.) — *M5 / before M12 launch*
- [ ] **[lawyer] M5 progress** — confirm (1) that keeping grants (kind, amount, day) after a `health_data` delete is acceptable, and the content-free `progress.record` / `meals.create` audit rows keeping the post's time for 24 months, (2) whether dish slugs in `progress_events` (what was cooked) and `meal_logged` dates (when they ate) need `health_data` consent rather than contract, as asked for the pantry (H-11) — *M5 / before M12 launch*
- [ ] **[lawyer] M5 device wait of a meal log** — a signed-in `meal_logged` event (its local day and minute, and the meal log's random id) is kept in that account's device partition until the server accepts or rejects it, including after a whole-request failure that is not a 429 (it is retried); it is removed on undo and on `unknown_meal_log` (Step 11 fix round 1, Ruling I2; `data-inventory.md` L-5). Confirm this unsealed device copy of when someone ate is acceptable under `health_data`, or whether it needs WebCrypto (R-12) — *M5 / before M12 launch*
- [ ] **[lawyer] M5 swap names in the pantry** — ticking a market-list row the rules engine swapped (e.g. oat milk for milk) writes the swap's ingredient name into the contract-basis pantry (H-11), where it stays after a `health_data` delete. The name alone can hint at the rule behind it. Confirm the pantry's contract basis covers it, or drop swapped rows' names on a `health_data` delete — *M5 / before M12 launch*
- [ ] **[lawyer] M5 device week without consent** — signed out, the week's plan and market list (dish slugs, list rows, swaps, ❓ marks) are kept on the device under contract, although the same data is health data on the server (H-11, `HEALTH_TABLES`). They leave the device 8 weeks after their week ends (pruned on load, sign-in, sign-out and each save; M5 final review I3), never reach a prompt (C-13), and reach the account only on the player's move tap under `health_data`. Confirm this device-only storage without `health_data` consent is acceptable, alongside the device-rules note, or whether it needs WebCrypto (R-12) — *M5 / before M12 launch*
- [ ] **[lawyer] M5 summary for counsel** — one place for the M5 questions: (1) grants (kind, amount, day) kept after a `health_data` delete; (2) the content-free audit rows (`progress.record`, `meals.create`, `notes.create`, `plan.save`, `market_run.*`) keeping the post's time for 24 months; (3) the `health_data` notice v3 wording; (4) the 13-month `usage_events` retention vs the export's recipients (below); (5) the device wait of a meal log's day and minute, with its retry; (6) swap names written to the pantry; (7) whether dish slugs (progress, plans) and meal dates need `health_data` consent rather than contract; (8) plans and market runs as health data; (9) the signed-out device plan and list kept without `health_data` consent. We never claim HIPAA compliance — *M5 / before M12 launch*

- [ ] **[lawyer]** Export recipients vs usage retention: the export lists the AI processors from the player's `usage_events` (a "sent" row before each model call, M4 Step 12), which the retention job deletes after 13 months. Decide whether Art. 15(1)(c) needs a longer look-back (e.g. a content-free "ever sent" marker kept for the account's life) — *M12 (C-31)*

## Founder / operator actions (not code)

- [ ] C-36 Turn on MFA or passkeys for GitHub, Hetzner, DNS registrar, mail, OpenRouter, payments and GlitchTip.
- [ ] Book a scoping call with privacy counsel: the lawyer list in the compliance report, plus family mode's 11 questions.
- [ ] Review OpenRouter's data-retention and no-training settings at account level, check the C-14 parameter names, and sign the DPA (C-14, C-34; checklist in `vendors/openrouter.md`).
- [ ] Deploy the API with `NODE_ENV=production`: the DPA gate (P-11) keys on it (README "Deploying the API").
- [ ] Decide launch regions: US-only first, or EU/UK fully covered (DPIA, EU representative).
