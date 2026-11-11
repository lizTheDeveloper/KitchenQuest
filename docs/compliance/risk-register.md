# Kitchen Quest: Threat Model and Risk Register

**Item:** C-33, second deliverable. Companion to `data-inventory.md` (what data, where) and `dpia.md` (the Art. 35 assessment that uses this register).
**Date:** 2026-11-09. **Status:** first version at M2 (Steps 0 to 4 built, Step 2c in progress). Finish and sign off by M12.
**Not legal advice.** Likelihood and impact are an engineer's judgment, not a legal or actuarial finding. **[verify]** marks facts to confirm.

## 1. Method

- **Scope:** the data flows in the diagram in `data-inventory.md` §2: browser and PWA, API, Postgres, object storage, AI gateway and OpenRouter, voice service, mail provider, GlitchTip and logs, Pantry, and operator and CI paths.
- **Security threats:** STRIDE per component (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege), §3.
- **Privacy harms:** LINDDUN (Linking, Identifying, Non-repudiation, Detecting, Data disclosure, Unawareness and unintervenability, Non-compliance), §4.
- **Scoring:** Likelihood L and Impact I each 1 to 5; score = L × I. Bands: **High** 15 to 25, **Medium** 8 to 14, **Low** 1 to 7.
  - **Likelihood** assumes the product launched today with only the controls that are **built** (column "Existing controls"). Controls in plans are not counted until they land.
  - **Impact** is harm to the person first (exposure of a health condition, physical harm from a wrong allergy answer, discrimination, stalking), then legal and business impact. A health-data disclosure about a condition scores 4 or 5.
  - **Residual** is the score expected after the "Planned controls" land and work as written. It is a forecast to be re-scored when each C-id is ticked in `ROADMAP.md`.
- **Order:** by current score, highest first, ties broken by impact. IDs are stable and referenced from the inventory, so they are not sequential in the table.
- **What "built" means today:** Email magic-link auth with hashed tokens, sessions, a profile, a sealed `rules` table (single key, no context binding), entitlements, content-free usage events, CI audit and Dependabot. No AI, voice, photos, tracker, Pantry or consent code exists yet, so several risks are scored on the design.

## 2. Assets and trust boundaries

| Asset | Why it matters |
|---|---|
| Sealed health rows (rules now; journeys, symptoms, meals, transcripts, photos later) | A leak reveals conditions; confidentiality loss is irreversible |
| Key ring and per-user keys | Single point that unlocks all sealed data |
| Email address and session | Identity; account takeover reaches everything above |
| Consent and audit records | The proof that processing was lawful and access was legitimate |
| Rules engine integrity | A wrong allergy result can cause physical harm |
| Pantry area and pickup data | Physical safety of neighbours |

Boundaries: device to API; API to each of OpenRouter, mail, push, GlitchTip, Merchant of Record; operator to production.

## 3. STRIDE per component

Entries cite risk ids from §5. "Gap" means no control is built yet.

| Component | S Spoofing | T Tampering | R Repudiation | I Information disclosure | D Denial of service | E Elevation of privilege |
|---|---|---|---|---|---|---|
| **Browser / PWA** | Stolen session cookie or mailbox takeover (R-06) | Malicious script or modified client (R-16, R-31) | none | Offline queue on shared device (R-12); lock-screen push (R-22) | Client abuse of API | Client cannot grant itself consent or entitlements (server decides) |
| **API (Fastify)** | Magic-link phishing or replay; IDOR across users (tests exist per Step 5/7 review focus) (R-06) | Mass-assignment into health rows; prompt-injected writes (R-15) | No audit trail yet (R-07) | Logs and errors carry URLs or bodies (R-02) | Rate-limit gaps, AI-cost abuse (R-26) | Operator script bypasses app checks (R-07) |
| **Postgres** | Service credentials leaked | Blob swap between users (R-08); direct edits | Edits unattributed (R-07) | Dump or backup theft (R-04, R-29); metadata inference (R-13) | Disk full from unbounded tables (retention, R-33) | App role able to alter audit rows (planned: no UPDATE or DELETE grants, C-5) |
| **Object storage (photos)** | Guessable keys | Replace object | none | EXIF, faces, public bucket misconfig (R-21) | Storage quota | none |
| **AI gateway / OpenRouter / model providers** | Spoofed provider endpoint (TLS pinned to host) | Injected instructions in imported recipe text (R-15) | Cannot show what was sent (by design no content logging) | Prompt retention or training (R-01); queue copy (R-14); transfers (R-11) | Provider outage (core play continues, spec §7.5); cost abuse (R-26) | Model proposes a write; server validates and the player confirms |
| **Voice service** | Unauthenticated socket | Mis-heard allergen (R-15) | none | Audio or partial transcript retained (R-20) | GPU exhaustion | none |
| **Mail provider** | Forged sender (SPF, DKIM, DMARC **[verify]**) | Link rewriting | Delivery logs are the only record | Provider reads magic links, keeps recipient logs (R-06, R-28) | Provider outage blocks sign-in | Provider staff can act as the user (R-06) |
| **GlitchTip / logs** | none | Log injection | Missing request ids | Health or email in events (R-02) | Event flood | Broad internal read access (R-07) |
| **Pantry (M11)** | Fake neighbour, stalker | Post edited after acceptance | Dispute about who posted or requested (moderation log, C-29) | Re-identification by cell plus dish (R-09) | Spam posts, rate limits | Blocked user evades (R-09) |
| **Operator, CI, repo** | Stolen GitHub or Hetzner account (C-36) | Malicious dependency or workflow (R-31) | Shared accounts | Secrets in repo or CI logs | none | Over-broad production access (R-07) |

## 4. LINDDUN summary

| Category | Where it applies in Kitchen Quest | Risks |
|---|---|---|
| **L**inking | Sealed row counts, timestamps, journey ids, bursary entitlement, IP in logs link records to a person or to each other | R-13, R-18 |
| **I**dentifying | Pantry cell plus dish plus time; handle; contributor ids; photo faces | R-09, R-19, R-21 |
| **N**on-repudiation (harmful: a person cannot deny) | Consent and audit trails are good for the company but can bind the person; keep them content-free | R-07 (as control), R-03 |
| **D**etecting | Existence of a `rules` row, a consent, or a `health_data` purpose reveals a condition without opening any blob | R-13, R-25 |
| **D**ata disclosure | AI providers, logs, mail provider, backups, push, household sharing | R-01, R-02, R-04, R-14, R-22, R-23, R-28, R-29 |
| **U**nawareness and unintervenability | Player does not know what the AI sees, or cannot withdraw or delete everywhere | R-03, R-05, R-17, R-33 |
| **N**on-compliance | Consent, notices, transfers, age, retention, claims | R-03, R-05, R-10, R-11, R-30, R-32, R-33, R-34 |

## 5. Risk register (highest first)

Columns: L and I are 1 to 5. "Planned controls" cite C-ids from `ROADMAP.md`; **new** means the risk register found a requirement that is not in the ROADMAP (§6).

| Rank | ID | Risk | Component | STRIDE | LINDDUN | L | I | Score (now) | Existing controls | Planned controls | Residual (L×I) | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **R-01** | Health data reaches an AI provider that retains, logs or trains on it | AI gateway / OpenRouter / model providers | I | Dd, Nc | 4 | 5 | 20 (High) | Prompts carry no user identifiers (spec §9); health goes to AI only after a typed `PromptContext` is built (design only, no AI code yet). | C-13 (consent-gated minimization), C-14 (ZDR and `data_collection: deny` pinned, allow-listed providers, no `:free`), C-15 (no content logging), C-22, C-16, C-34 (OpenRouter review and DPA first) | 2×5 = 10 (Medium) | A provider that logs prompts is an HBNR 'breach' and an FTC §5 problem. Upstream provider set changes with routing **[verify]**. |
| 2 | **R-03** | Health data processed without valid, separate, recorded consent | API, Browser (onboarding) | — (legal) | Nc, U | 5 | 4 | 20 (High) | `confirmed: true` read-back confirms one rule, it is not consent. Spec §7.0. | C-1 consent ledger, C-11 e2e test (`consent_required`, declining never blocks play), C-17 tap-based card before intake, C-30 separate consumer health data policy, C-31 | 2×4 = 8 (Medium) | WA MHMDA has a private right of action; GDPR Art. 9(2)(a) needs explicit consent. Scored for the design if launched without Step 2c. |
| 3 | **R-02** | Health data leaks through logs, URLs, error reports | API, GlitchTip, proxy logs | I | Dd, D | 4 | 4 | 16 (High) | 500-path logging is PII-free (commit 439f6d4). Magic-link tokens are hashed. | C-9 (route-pattern logging, pino redact, GlitchTip `before_send`, test with 'peanut'), C-15, retention for L-1 to L-3 (**new**, see §6) | 2×4 = 8 (Medium) | `GET /ingredients/search?q=` puts allergens in `req.url` today (gap G-8). |
| 4 | **R-05** | Deletion is incomplete: tokens, processors, mail provider, backups | API, Postgres, Mail, Object storage | — (legal) | Nc, U | 4 | 4 | 16 (High) | Cascade FKs from `users`; one-click `DELETE /me` is planned. `login_tokens.email` has no FK and survives. | C-8 (delete login tokens by email, keys, pseudonymize audit, processor-deletion queue), C-4 (crypto-shred backups), C-34, C-35, C-7 | 2×3 = 6 (Low) | MHMDA and GDPR expect deletion to reach processors and archives. Mail-provider logs are outside our control. |
| 5 | **R-04** | Database or key compromise exposes health data | Postgres, API host, key store | I, T | Dd | 3 | 5 | 15 (High) | AES-256-GCM on `rules.sealed`; hashed tokens and sessions; secrets in env, not in the repo. | C-2 (key ring, rotation, escrow), C-3 (AAD), C-4 (per-user keys), C-35 (backups, keys apart), C-36 (MFA), C-38 (private network, TLS), C-37, C-42 | 2×5 = 10 (Medium) | Today one `DATA_KEY` and no rotation. With per-user keys a DB dump alone is useless; ring-key plus DB together still exposes all (impact stays 5). |
| 6 | **R-10** | Under-age user, or child-directed appeal, with no valid parental basis | Browser (onboarding), API | — (legal) | Nc | 3 | 5 | 15 (High) | 16+ checkbox, `age_confirmed_at` only, no birthday; accounts 16+; family mode not built (P-9). | C-39 (neutral age screen, actual-knowledge deletion, child-directedness review), C-44, C-45, P-9 | 2×4 = 8 (Medium) | Non-neutral age screen invites false attestation **[lawyer]**. 8-bit characters raise the 'directed to children' question. |
| 7 | **R-06** | Account takeover via email compromise or magic-link interception | Mail, API, Browser | S, E | I | 3 | 4 | 12 (Medium) | Single-use token, short TTL, token and session stored as hashes, rate limit 5/h per email and 20/h per IP, cookie `HttpOnly; Secure; SameSite=Lax`, no account enumeration. | C-10b (sessions list, sign out everywhere, rotation), C-36, C-40; **new:** disable open/click tracking and link rewriting at the mail provider (see §6); passkeys later | 2×4 = 8 (Medium) | The mail provider can read the login link in transit. Anyone with mailbox access has the account. |
| 8 | **R-07** | Operator, script or insider reads decrypted data with no trail | API host, Postgres, scripts | R, E, I | Nc, D | 3 | 4 | 12 (Medium) | `scripts/grant.ts` touches the DB directly; no audit table yet. | C-5 (append-only content-free audit incl. operator and script decrypts), C-42 (least privilege, offboarding), C-36, C-2 (rotate on offboarding) | 2×3 = 6 (Low) | Also covers the inability to prove to a regulator who accessed what (repudiation). |
| 9 | **R-09** | Pantry post or request re-identifies or locates a neighbour | Pantry (API, Browser) | I, S | I, L, Dd | 3 | 4 | 12 (Medium) | Design only (spec §18): 1 km grid, exact spot after acceptance, posts expire, no free-text contact, nothing auto-posted. | C-28 (no precise coordinates, no geofencing, health facilities never anchors), C-29 (moderation data minimal), block/report, rate limits | 2×4 = 8 (Medium) | Small cells in rural areas plus a distinctive dish can identify someone. Requester status computed on their device so posters learn nothing about rules. |
| 10 | **R-11** | EU or UK users served without GDPR package; transfers to US and other providers | AI gateway, hosting, policy | — (legal) | Nc | 3 | 4 | 12 (Medium) | No region gating built. Hetzner hosting region **[verify]**. | C-44 (region gating or full EU package), C-34 (SCCs or DPF per vendor), DPIA and transfer impact assessment, Art. 27 representative | 2×3 = 6 (Low) | Qwen-family hosts may sit outside adequate countries **[verify]**. |
| 11 | **R-14** | AI retry queue holds prompts (health content) in plaintext | API, Postgres | I | Dd | 3 | 4 | 12 (Medium) | None designed. Spec §7.5 says requests are 'queued and retried'. | **New requirement:** queue holds no content, or content sealed under the user key, max 24 h, registered with C-6 (see §6) | 1×4 = 4 (Low) | Easy to miss: a job table is a second copy of the prompt. |
| 12 | **R-23** | Household Kitchen discloses one member's rules or symptoms to others | API (M9) | I | Dd, U | 3 | 4 | 12 (Medium) | Design only: shared plan, pantry and list; private rules (business doc §C). | C-25 (private by default, 'doesn't suit someone' without naming, per-member consent), per-member keys, no minors until P-9 cleared | 2×3 = 6 (Low) | Shared plan checks must not leak who or why. |
| 13 | **R-29** | Backups outlive deletion or are readable with co-located keys | Backups, Hetzner | I | Nc, Dd | 3 | 4 | 12 (Medium) | No backup process yet. | C-35 (encrypted, 30 d, keys separate, restore drill), C-4 (crypto-shred), C-38 | 1×4 = 4 (Low) | Timing rules for backups under MHMDA **[verify]**. |
| 14 | **R-30** | Breach or unauthorized disclosure not detected or notified in time | All | R, I | Nc | 3 | 4 | 12 (Medium) | Dependabot and `npm audit` in CI; GlitchTip planned; no runbook. | C-32 (runbook, HBNR 60 days, GDPR 72 h, tabletop), C-5 alerts, C-41 (owner, security.txt) | 2×3 = 6 (Low) | HBNR counts unauthorized disclosure by the company itself (GoodRx pattern), not only hacks. |
| 15 | **R-31** | Vulnerable dependency or build compromise | CI, API, Browser | T, E | — | 3 | 4 | 12 (Medium) | Dependabot, `npm audit --audit-level=high` in CI, pinned versions. | C-37 (pen test before launch, OS patching), C-40 (strict CSP limits damage), C-36 | 2×3 = 6 (Low) |  |
| 16 | **R-15** | Integrity failure leads to an unsafe allergy result (wrong target, mishearing, bad AI substitution) | Core rules engine, Mentor, Voice | T | — (safety harm) | 2 | 5 | 10 (Medium) | Deterministic `check` decides safety, AI never consulted at check time; confirmed IDs only stored; full read-back; spelled-out heard ingredient; tap on severe rules (§4.4, §7.3, §7.6); persistent disclaimer. | No C-id. M8 evals, Step 8 e2e, claims review (C-43). Residual risk is physical harm and cannot be driven to zero. | 2×5 = 10 (Medium) | Not a privacy risk, but the DPIA must weigh it: wrong health data is a harm to the person (accuracy, Art. 5(1)(d)). |
| 17 | **R-34** | HIPAA creep: an org customer sends rosters or a clinic buys dashboards | Business process, API | — (legal) | Nc | 2 | 5 | 10 (Medium) | Policy P-1, P-2, P-8; spec §16 bans insurer and employer data deals. | C-10 (no org-to-health joins, CI test), contract screening questions, C-43 | 1×5 = 5 (Low) | Becoming a business associate would change the whole programme (compliance report §1.3). |
| 18 | **R-12** | Offline queue and cache on a shared or lost device expose health logs | Browser / PWA | I | Dd | 3 | 3 | 9 (Medium) | None designed. Cookie is `HttpOnly`. | **New requirement:** minimise what is cached; clear on sign-out; consider WebCrypto with a session-derived key; 'sign out everywhere' (C-10b) | 2×2 = 4 (Low) | Spec §9 promises offline logging that syncs later. |
| 19 | **R-13** | Linking and inference from plain metadata (timestamps, row counts, usage, journey ids) | Postgres | I | L, I, D | 3 | 3 | 9 (Medium) | Health columns sealed; usage is content-free and column-tested. | C-23 (journey id counts as sensitive), C-3/C-4, keep analytics aggregate-only (P-10), minimise plain timestamps | 2×3 = 6 (Low) | Existence of a `rules` row or a `health_data` consent hints at a condition. |
| 20 | **R-17** | Free text and unsealed names carry special-category data (religion, disability, third parties) | Postgres, API | I | Dd, U | 3 | 3 | 9 (Medium) | `rules.note` is inside the sealed blob. `profiles.meal_windows` names are plaintext. | C-1 consent copy names religion explicitly, C-19, seal or drop free text in profile (**new** decision), field length limits | 2×2 = 4 (Low) | 'Ramadan suhoor' as a meal-window name is plaintext religious data. |
| 21 | **R-22** | Notifications reveal health content on a lock screen or in push services | Push services, Browser | I | Dd | 3 | 3 | 9 (Medium) | Not built. | C-24 (generic text only, tested) | 1×3 = 3 (Low) |  |
| 22 | **R-26** | Denial of service or AI-cost abuse blocks safety checks or exhausts budget | API, AI gateway | D | — | 3 | 3 | 9 (Medium) | Auth rate limits, per-user usage metering, core play and rule checks independent of AI (§7.5). | Daily AI limits (§7.3), CSP/WAF at deploy (C-38) | 2×2 = 4 (Low) |  |
| 23 | **R-28** | Other processor (mail, GlitchTip if SaaS, push, Merchant of Record) breaches or retains data | Third parties | I | Dd, Nc | 3 | 3 | 9 (Medium) | No processor chosen except named ones; no contracts. | C-34 and P-11 (no data to a processor before review and DPA), `processors.json` feeds export (C-7) | 2×3 = 6 (Low) |  |
| 24 | **R-08** | Sealed blob copied to another user's row or table decrypts cleanly | Postgres, API | T | — | 2 | 4 | 8 (Medium) | GCM tag and key-id header only; no binding to owner or row (gap G-6). Uncommitted `seal.ts` work is adding context. | C-3 (AAD = header + table + user + row) | 1×4 = 4 (Low) | Cheap now, a data migration later. |
| 25 | **R-16** | Third-party script or tracker added to the client | Browser / PWA | I, T | D, Nc | 2 | 4 | 8 (Medium) | Policy only: 'no third-party ad trackers' (spec §9). | C-40 (strict CSP, Playwright test for unlisted origins), C-43 | 1×4 = 4 (Low) | 'No trackers' becomes an enforced fact. |
| 26 | **R-20** | Voice audio retained, transcripts leaked, or voiceprint inferred | Voice service | I, R | Dd, I | 2 | 4 | 8 (Medium) | Design only: audio in memory, no speaker ID (§7.7, P-7). | C-18 (FS and log grep test, separate `voice` consent, TLS, session auth), C-34 if GPU host is not Hetzner | 1×4 = 4 (Low) | Avoids BIPA and CUBI by never deriving voiceprints. |
| 27 | **R-21** | Photo leaks location, faces or is guessable in storage | Object storage, API | I | Dd, I | 2 | 4 | 8 (Medium) | Design only: EXIF and GPS stripped, private by default (§9). | C-20 (strip before storage and AI, random keys, sealed, deletion queue), C-8 | 1×4 = 4 (Low) | Faces: see F-4 for family mode. |
| 28 | **R-24** | Clinician share link guessed, forwarded or left live | Share feature (M9+) | I, S | Dd | 2 | 4 | 8 (Medium) | Design only. | C-26 (expiring 7 d, revocable, unguessable, every access logged), P-8 | 1×4 = 4 (Low) | After handoff the clinician's own duties apply. |
| 29 | **R-25** | Low-intake check-in is stored as a label or sent to the AI | API (M9) | I | L, I | 2 | 4 | 8 (Medium) | Design only: 'computed on the fly'. | C-27 (no label persisted, not in prompts), spec §5 safeguards | 1×4 = 4 (Low) | A persisted label is a disordered-eating inference. |
| 30 | **R-27** | SSRF through recipe URL ingestion | API (M8) | E, I | — | 2 | 4 | 8 (Medium) | Design only. | C-21 (block private ranges, metadata endpoints, no cookies or identifiers sent) | 1×4 = 4 (Low) |  |
| 31 | **R-32** | Deceptive or over-claimed privacy statements | Marketing, policies | — (legal) | Nc, U | 2 | 4 | 8 (Medium) | Standing rule: never claim 'HIPAA compliant'. Spec §20. | C-43 (claims review, every claim maps to a tested control), C-30 | 1×4 = 4 (Low) | FTC §5 (GoodRx 2023). |
| 32 | **R-33** | Inactive accounts keep health data indefinitely | Postgres | — (legal) | Nc, U | 4 | 2 | 8 (Medium) | Account lifetime only. | **New requirement:** inactivity policy (e.g. notify, then delete after 24 months, **[lawyer]** and product call) registered with C-6 | 1×2 = 2 (Low) | Storage limitation, Vitagene-style unfairness. |
| 33 | **R-19** | Data about other people: neighbours, people fed, recipe contributors, non-users who typed an email | Postgres, repo | I | I, U | 2 | 3 | 6 (Low) | Contributor ids are public handles; `login_tokens` purged at 24 h after C-6. | C-6, C-29; **new:** contributor notice and removal path. **Built M5 (Step 7, Ruling 10):** 'Cooked for Someone' (`shared_table`, H-13) stores fixed choices only, a count and optionally one fixed relationship word, sealed per row; the API's strict shape refuses any name, free text or other key (400, nothing stored, the value never echoed or logged), and core `parseCookedFor` drops names from a typed answer before anything is built. No health fact about another person can be stored | 2×2 = 4 (Low) |  |
| 34 | **R-18** | Entitlement kind (bursary, founding) reveals financial hardship | Postgres | I | L, I | 2 | 2 | 4 (Low) | Kept out of health tables; no proof required for bursary. | Keep out of analytics and AI prompts; export covers it (C-7) | 1×2 = 2 (Low) | Low, but listed so it is not repurposed. |

### 5.1 Reading the top of the list

1. **R-01, R-03, R-02, R-05, R-04** are all about health data leaving the sealed store or being processed without a recorded basis. They are the launch blockers in the compliance report §9.1. None of the planned controls can be demonstrated yet; each needs a test before its C-id is ticked.
2. **R-10 and R-15** keep a residual that stays at or near Medium: age attestation cannot be made certain, and a safety system cannot reach zero harm. They are accepted only with the disclaimers, the read-back flow and a lawyer-reviewed age screen.
3. **Residual High:** none forecast. If any planned control slips past M12, re-score and block launch on any residual of 10 or more.

## 6. New requirements found while building this register

These are not in `ROADMAP.md` today. Proposed ids are placeholders for the roadmap owner; each is cheap now and expensive later.

| Proposed | Requirement | Risk | Where |
|---|---|---|---|
| N-1 | **Mail provider hygiene:** magic links are credentials in a third party's hands. Turn off open and click tracking and link rewriting, send only the token link and no health content, set short provider log retention, SPF, DKIM and DMARC, and a suppression-list deletion call in C-8. | R-06, R-28 | M2 (mailer), M12 |
| N-2 | **Log, proxy and rate-limit retention:** IP addresses and user agents sit in access logs and rate-limit state. Define retention (proposed 14 to 30 days), where rate-limit counters live, and cover them in the privacy notice. Register with C-6. | R-02 | M2 / M12 |
| N-3 | **Offline store hygiene:** the PWA queue and cache hold health logs on the device. Cache the minimum, clear on sign-out and "sign out everywhere", consider WebCrypto, test it. | R-12 | M4 / M9 |
| N-4 | **AI retry queue holds no content**, or holds it sealed under the user key, with a 24 h cap, registered with C-6. | R-14 | M3 |
| N-5 | **Inactive-account policy:** notify then delete after a fixed period (proposed 24 months; product call and **[lawyer]**). | R-33 | M2 (register) / M12 |
| N-6 | **Contributor data:** contributor ids are personal data. Add a notice, a consent or contributor agreement clause, and a removal or pseudonymize path. Not in the player export, but in a contributor request process. | R-19 | M2 Step 6 / M10 |
| N-7 | **Free-text and special categories:** consent copy for `health_data` names religious dietary rules explicitly (GDPR Art. 9); decide whether `profiles.meal_windows` names and "Cooked for Someone" labels are sealed, validated or dropped; cap free-text lengths. | R-17, R-19 | M2 / M5 |
| N-8 | **Inventory-schema check in CI:** a test that fails when a column in `schema.ts` is missing from `data-inventory.md`, so the Art. 30 record cannot drift. | all | M2 |
| N-9 | **Processor register as code:** `processors.json` is validated in CI (required fields, `dpa_status` enum) and a rule that no outbound-request code path for a processor is merged while its `dpa_status` is `unknown` or `needed` (enforces P-11). | R-28 | M3 / M12 |
| N-10 | **Child-directedness and neutral age screen review** also covers the *marketing site and store listings*, not only the app. | R-10 | M12 |
| N-11 | **DPIA review triggers:** a new processor, AI feature, region, consent purpose, or any Pantry or family-mode build re-opens the DPIA and this register before merge. | all | process |

## 7. Maintenance

- Re-score a risk whenever its C-id is ticked or a built control is changed.
- Quarterly review (compliance report §5.1 risk management): re-check provider lists (C-14), processor terms (C-34) and the top ten.
- After any incident, add the cause as a risk or raise its likelihood.
- Owner: the named security and privacy owner (C-41). **[to be named]**
