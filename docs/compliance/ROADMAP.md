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
- [ ] **M4 mentor** — *M4* — `plans/m4-mentor/README.md` (Step 12 ticks the items it lands): C-12–C-17, C-34 (code gate and review checklist; the DPA is a founder action), C-39 (neutral age screen, chat child guard; the M12 parts stay open), N-4, N-9
- [ ] **C-12** Conversation storage — *M3* — `plans/m3-mentor/README.md`
- [ ] **C-13** AI gateway minimization and consent — *M3* — `plans/m3-mentor/README.md`
- [ ] **C-14** OpenRouter data policy pinned in code — *M3* — `plans/m3-mentor/README.md`; `apps/api/src/ai/`
- [ ] **C-15** No AI content logging — *M3* — `plans/m3-mentor/README.md`
- [ ] **C-16** AI disclosure — *M3* — `plans/m3-mentor/README.md`; `content/`
- [ ] **C-17** Consent before the intake interview collects health data — *M3* — `plans/m3-mentor/README.md`; `content/bureau/`
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
- [ ] **C-34** Vendor reviews and DPAs — *M3 (OpenRouter), M12 (all)* — `plans/m3-mentor/README.md`; `plans/m12-launch/README.md`
- [ ] **C-35** Backups — *M12* — `plans/m12-launch/README.md`
- [ ] **C-36** Operator MFA — *Now (accounts); M12 (audit)* — `plans/m12-launch/README.md`
- [~] **C-37** (CI part done: Dependabot + `npm audit --audit-level=high`; pen test pending) Vulnerability management — *Now (CI); M12 (pen test)* — `.github/workflows/ci.yml` (later); `plans/m12-launch/README.md`
- [ ] **C-38** Network and transport — *M12 (deploy)* — `plans/m12-launch/README.md`
- [ ] **C-39** Age and children — *M3 (onboarding) / M12* — `plans/m3-mentor/README.md`; `plans/m12-launch/README.md`
- [ ] **C-40** Strict Content-Security-Policy — *M4 game shell / M12* — `plans/m12-launch/README.md` (and the M4 plan when written)
- [ ] **C-41** Ownership and contact — *Now* — `plans/m12-launch/README.md`
- [ ] **C-42** Workforce access — *M12* — `plans/m12-launch/README.md`
- [ ] **C-43** Claims review — *M12* — `plans/m12-launch/README.md`
- [ ] **C-45** Family mode data (§19) — *M5 (reserve) / M13* — M5 plan; `plans/m13-family/README.md`
- [ ] **C-45** Security headers from the server/host: CSP with `frame-ancestors 'none'`, HSTS, `X-Content-Type-Options`, `Referrer-Policy` (the game's meta CSP can't carry frame-ancestors) — *M12 (deploy)*
- [x] **N-3 (partial)** Game store: CSP meta, "delete data on this device", rescue copies capped — *M3 Task 3*
- [ ] **C-44** Region gating — *M12* — `plans/m12-launch/README.md`

## Additional requirements from the risk register (N-1–N-11, `risk-register.md` §6)

- [x] **N-1 (M2 part)** Mailer sends one plain-text part, exactly one URL (the verify link) and no health content, tested; provider settings (tracking and link rewriting off, log retention, SPF/DKIM/DMARC) written down in `mail-provider.md` — *M2 Step 9*
- [ ] **N-1 (remainder)** Choose the provider and apply `mail-provider.md` there (tracking and rewriting off, retention, DNS records for SPF/DKIM/DMARC), suppression-list deletion call in the C-8 processor-deletion queue — *M12*
- [x] **N-2 (M2 part)** Rate-limit state is in memory, IP/email/user-id keyed and swept within 1 h 1 min (timer sweep, tested); API request log is route patterns only (C-9); access-log retention (14 d, max 30) registered in `data-inventory.md` §3.14 — *M2 Step 9*
- [ ] **N-2 (remainder)** Configure the reverse proxy's access log (no query strings, 14 d retention) and the log host's retention; state the periods in the privacy notice — *M12 (C-38, C-30)*
- [ ] **Deploy (from Step 9)** Ship `docs/compliance/` (`notices/`, `processors.json`) in the API image: the API reads both at boot and will not start without them — *M12 (deploy)*
- [ ] **N-3** Offline PWA store hygiene: cache the minimum, clear on sign-out — *M3 game shell / M9*
- [ ] **N-4** The AI retry queue holds no content, or holds it sealed with a 24 h cap — *M3 mentor*
- [ ] **N-5** Inactive-account policy: notify, then delete after about 24 months **[lawyer]** — *M12*
- [ ] **N-6** Contributor ids are personal data: notice, contributor agreement, removal path — *M2 Step 6 / M10*
- [x] **N-7** Consent copy names religious dietary rules; meal-window names become a fixed set (breakfast/lunch/dinner/snack/other), not free text; free-text caps — *M2 Step 9* (notice `notices/health_data-v1.md`, grants under older versions no longer count; caps in `data-inventory.md` §3.13. "Cooked for Someone" labels are decided with M5)
- [x] **N-8** CI check that every `schema.ts` column appears in `data-inventory.md` — *M2 Step 9* (`apps/api/test/inventory.test.ts`)
- [ ] **N-9** `processors.json` validated in CI; no processor call merged while its DPA is unknown — *M3 / M12*
- [ ] **N-10** Child-directedness review also covers the marketing site and store listings — *M12*
- [ ] **N-11** DPIA re-review triggered by any new processor, AI feature, region, consent purpose, Pantry or family build — *process*

## Raised during implementation

- [ ] **C-42** Separate DB roles: the app connects as a non-owner role with no UPDATE/DELETE on `audit_events`; migrations and SECURITY DEFINER maintenance run as owner — *M12 (deploy)*
- [ ] **C-43** Backup-restore replays `account.delete` audit events so deleted users' wrapped keys aren't resurrected — *M2 Step 7 (write event) / M12 (restore runbook)*
- [ ] **C-44** GlitchTip SDK added with `before_send` scrubbing (C-9 completion) — *M12*

## Founder / operator actions (not code)

- [ ] C-36 Turn on MFA or passkeys for GitHub, Hetzner, DNS registrar, mail, OpenRouter, payments and GlitchTip.
- [ ] Book a scoping call with privacy counsel: the lawyer list in the compliance report, plus family mode's 11 questions.
- [ ] Review OpenRouter's data-retention and no-training settings at account level (C-14, C-34).
- [ ] Decide launch regions: US-only first, or EU/UK fully covered (DPIA, EU representative).
