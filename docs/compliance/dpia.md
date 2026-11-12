# Kitchen Quest: Data Protection Impact Assessment (skeleton)

**Format:** GDPR Art. 35(7) (systematic description, necessity and proportionality, risks to individuals, measures). Also serves as the CPRA risk assessment and the MHMDA documentation (§9).
**Item:** C-33, third deliverable. Facts come from `data-inventory.md` and `risk-register.md`; ids like H-1 and R-01 refer to them.
**Version:** 0.1, 2026-11-09. **Status:** DRAFT SKELETON, filled in as far as the facts allow. Finish and sign off by M12, before launch and before any EU or UK user is admitted (P-13, C-44).
**Not legal advice.** This is an engineer's draft to make counsel's time cheaper. **[verify]** marks a fact to confirm. **[lawyer]** marks a question or sign-off for counsel or a DPO. **[TBD]** marks a decision not yet made.

---

## 0. Document control

| Field | Value |
|---|---|
| Controller | Multiverse Games / The Multiverse School **[lawyer: confirm legal entity, address, jurisdiction]** |
| Product | Kitchen Quest (consumer cooking RPG and food tracker, PWA) |
| Assessment owner | **[TBD: named security and privacy owner, C-41]** |
| DPO | **[lawyer: is a DPO mandatory (Art. 37: large-scale special-category processing as a core activity)? If yes, name; if no, document the decision]** |
| EU/UK representative (Art. 27) | **[lawyer: needed if EU or UK users are admitted without an EU establishment]** |
| Contributors | Engineering (this draft); counsel **[lawyer]** |
| Next review | Annually, and on the triggers in risk-register N-11 |
| Prior consultation (Art. 36) | **[lawyer: needed only if residual risk stays High after measures; none forecast]** |

## 1. Why a DPIA is needed

Art. 35(3)(b) (large-scale special-category data) is the likely trigger **[lawyer: "large scale" depends on user numbers]**. Other criteria from the EDPB guidelines that apply: sensitive data; innovative technology (generative AI, voice); possibly vulnerable subjects (16 to 17-year-olds, people managing allergies or gut conditions; later children via family mode); possible disorder-related inferences. Doing a DPIA before launch is the safe course whatever the numbers.

## 2. Description of the processing

### 2.1 Nature and context

- **What the product is:** a cooking game and food log for individuals (spec §1, §20). It is not a medical device and not a clinical tool. Positioned as general wellness. Journeys are "tools to use with a clinician" (spec §4.5).
- **Who the data subjects are:** adults and 16 to 17-year-old account holders; later parent-managed child profiles (M13, blocked by P-9); neighbours in the Pantry (M11); recipe contributors; non-users whose email someone types.
- **Not HIPAA:** direct-to-consumer, player-entered data, no covered-entity customers (compliance report §1). Product rules P-1 to P-14 keep it that way. **[lawyer: confirm]**
- **Scale:** **[TBD: launch-year user estimate]**. No data subjects exist yet; the product is at M2.

### 2.2 Purposes

| Purpose | Data (inventory ids) | Basis (GDPR) | Consent purpose (C-1) |
|---|---|---|---|
| Provide an account and sign-in | A-1 to A-11 | Art. 6(1)(b) contract | none |
| Personalise to schedule and region | P-1 to P-4 | 6(1)(b) | none |
| Allergy and diet safety checks | H-1, H-2 | 6(1)(b) and **9(2)(a) explicit consent** | `health_data` |
| Journeys, symptoms, meal logs, weekly view | H-5 to H-8, H-11 to H-15 | 6(1)(b) and 9(2)(a) | `health_data` |
| Mentor and NPC conversation | I-1, I-4, I-6 | 6(1)(b) and 9(2)(a) | `health_data`, `ai_health` |
| Send health fields to the AI | I-2 | 9(2)(a) | `ai_health` |
| Voice conversation | V-1 to V-3 | 6(1)(b), 9(2)(a) | `voice` (notice v1, M7 Step 4) |
| Voice accessibility need (unmetered voice) | P-5 | 6(1)(b) and 9(2)(a) **[lawyer: or "necessary for the service"]** | `health_data` (declining it means the free voice allowance) |
| Voice allowance (content-free usage) | V-4 | 6(1)(b) | none |
| Photo reaction and Recipe Book | F-1 to F-3 | 6(1)(b), 9(2)(a) | `health_data` (+ `ai_health` for the reaction) |
| Neighborhood Pantry | N-1 to N-9 | 6(1)(b) | `pantry_location` |
| Allowances and unit economics | U-1, U-2 | 6(1)(b) | none |
| Security, abuse prevention, audit | J-4, L-1 to L-3, A-8 | 6(1)(f) legitimate interest **[lawyer: balancing test]** | none |
| Legal evidence of consent | J-1 | 6(1)(c)/(f) | none |
| Research use of data | none | not planned | `research` (reserved, never default, P-10) |

Religion: religious diet rules (halal, kosher, Jain, fasting) reveal religious belief and are Art. 9 data in their own right (compliance report §2.7). The `health_data` consent text must name this (risk-register N-7).

### 2.3 Data and flows

The full inventory is `data-inventory.md` §3; the data-flow diagram is §2 there. In summary:

- **Stored in our systems (Hetzner):** email and sessions; profile; sealed health rows; consents, keys and audit; usage events; entitlements. Health columns are AES-256-GCM sealed (today one key; per-user keys, AAD binding and rotation from Step 2c).
- **Sent to processors:** AI requests to OpenRouter and the model providers behind it; magic-link emails to the mail provider; errors to GlitchTip; push to FCM, Apple and Mozilla; billing at the Merchant of Record. Full list: `processors.json`.
- **Not collected:** birthday, name, precise location, voiceprints, advertising identifiers, body metrics (v1), child intake or photos of children.
- **Retention (C-6):** login tokens 24 h after expiry or use; sessions at expiry; usage events 13 months; audit events 24 months (pseudonymized on delete); conversations 30 days by default; Pantry posts after the pickup window; moderation 12 months; backups 30 days; photos until deleted. Logs and inactive accounts have **no policy yet** (risk-register N-2, N-5).

### 2.4 Technology and novelty

- Generative AI (Qwen via OpenRouter) with a tool-using agent; writes need an explicit read-back yes; deterministic rules engine decides safety (spec §4.4, §7). The AI is not used for decisions that produce legal or similarly significant effects (Art. 22: none **[lawyer: confirm]**).
- Streaming voice (self-hosted STT and TTS; audio in memory only).
- Offline-capable PWA with a local queue.

### 2.5 Recipients and transfers

- Recipients: processors only. No sale or sharing with advertisers, insurers, employers or data brokers (spec §16, P-10).
- Transfers: OpenRouter is US-based **[verify]**; upstream hosts may be elsewhere, possibly outside adequate countries **[verify]**. Mechanism per vendor: **[verify: SCCs or EU-US DPF]**, with a transfer impact assessment **[lawyer]**. Alternative: launch US-only and gate the EU and UK (C-44).

## 3. Consultation

| Who | Status |
|---|---|
| Data subjects or representatives | **[TBD: user research on consent wording and the privacy dashboard before launch; playtest batch in M12]** |
| DPO or privacy counsel | **[lawyer]** |
| Processors (security input) | **[TBD]** collected in the C-34 vendor reviews |
| Supervisory authority | **[lawyer: only if Art. 36 is triggered]** |

## 4. Necessity and proportionality

| Question | Assessment |
|---|---|
| Lawful basis | Contract for account and service; **explicit consent** for health, religion, AI transfer and voice, kept in the consent ledger with notice version and hash (C-1). Consent is separate from the terms (P-4), tap-based (C-17), withdrawable as easily as given, and declining never blocks play (C-11). **[lawyer: whether any health processing can rely on 9(2)(a) alone or needs an Art. 9 condition for the safety check]** |
| Purpose limitation | Health data used only for safety, logging and journeys. Never for ads, training, resale or insurer or employer use (P-10, spec §16). Research is a separate opt-in. |
| Data minimisation | No birthday or name; country only; coarse location only in Pantry (1 km cell, snapped on device); AI gets only what the task needs and only with `ai_health` (C-13, C-22); no identifiers in prompts; low-intake inference computed, never stored (C-27). |
| Accuracy | Player-entered and confirmed; editable; the rules engine is deterministic; AI output is validated and re-checked (R-15). |
| Storage limitation | Retention registry (C-6) plus proposed log and inactivity policies (N-2, N-5). |
| Integrity and confidentiality | Application-layer encryption, per-user keys, AAD, audit log, MFA, private network, backups (C-2 to C-5, C-35, C-36, C-38). |
| Transparency | Privacy policy and a separate consumer health data privacy policy (C-30), AI disclosure (C-16), notice at collection, processor list in the export (C-7). |
| Data-subject rights | Export and delete in-app (Steps 7 and 8, C-7, C-8); consent withdrawal (C-1); privacy mailbox, 45-day tracker and appeals (C-31); rectification via editable rules and logs. Art. 15 recipients list from `processors.json`. Art. 22: not applicable **[lawyer]**. |
| Processors | DPAs and reviews before any data flows (P-11, C-34). Status today: none signed. |
| International transfers | Open, see §2.5. |
| Children | 16+ accounts only (neutral age screen planned, C-39); child profiles gated behind M13 and counsel (P-9, C-45). **[lawyer: also UK Age Appropriate Design Code for 16 to 17-year-olds if the UK is admitted]** |
| Alternatives considered | (1) No AI for health data: possible and supported (works blind; rules engine filters output). (2) Self-hosted model: costlier, still an option for health content **[TBD]**. (3) Device-only storage: breaks multi-device sync and export. (4) A HIPAA track: deferred (compliance report §1.4). |
| Proportionality verdict | **[TBD at sign-off]**. Draft view: proportionate if C-1, C-13/14/15, C-4, C-8, C-9 are in place before health data is collected. |

## 5. Risks to individuals

The scored register is `risk-register.md` §5. The harms that matter most to the person, with their register entries:

| Harm | Risk ids | Current | Residual (forecast) |
|---|---|---|---|
| Exposure of a condition, allergy or religion through an AI provider | R-01, R-14 | High | Medium |
| Processing without valid consent, or no way to withdraw | R-03, R-05 | High | Medium |
| Exposure through logs, backups or a breach of the database or keys | R-02, R-04, R-29 | High | Medium |
| Account takeover revealing everything | R-06 | Medium | Medium |
| Children or under-age users' data | R-10 | High | Medium |
| Physical harm from a wrong allergy answer | R-15 | Medium | Medium (floor) |
| Stalking or re-identification of a neighbour | R-09 | Medium | Medium |
| Disclosure inside a household | R-23 | Medium | Low |
| Inference of disordered eating or hardship | R-25, R-18 | Low to Medium | Low |
| Unauthorized transfers or EU non-compliance | R-11 | Medium | Low |

Further risk categories required by Art. 35(7)(c): loss of control over personal data (R-05, R-33), discrimination or financial loss (R-01, R-18), reputational damage (R-02, R-09), loss of confidentiality of special-category data (all of the above).

## 6. Measures to address the risks

Map of measures to ROADMAP ids, with their state on 2026-11-09. "Built" means in the repo and tested; the other states come from the plans.

| Measure | C-id | State |
|---|---|---|
| Application-layer encryption of rules | seal.ts | Built (single key); context binding in progress |
| Consent ledger and e2e tests | C-1, C-11, C-17 | Planned M2 / M3 |
| Key ring, AAD, per-user keys | C-2, C-3, C-4 | Planned M2 (Step 2c) |
| Audit log (content-free), retention job | C-5, C-6 | Planned M2 |
| Log and error redaction | C-9, C-15 | Planned M2 / M3 |
| Complete export and delete | C-7, C-8 | Planned M2 |
| Org and health separation | C-10 | Planned M2 (constraint) |
| AI gateway minimisation, OpenRouter pinned, disclosure | C-13, C-14, C-16, C-22 | Built M4 (C-13, C-14 code part, C-16; see §6.1); C-22 planned M8 |
| Voice privacy | C-18, C-19 | M7. Step 4: the `voice` notice v1; the accessibility need sealed under `health_data` (`voice_settings`, fixed sealed length, kept as a sealed `false`, exported and erased; the plain entitlement kind retired); voice usage content-free (seconds and cost). The rest of C-18 (memory-only audio, no voiceprints, the route) in Steps 2, 3 and 5. Step 5: the API voice socket (session, Origin, `voice` consent, the per-user child and Family Table block, the allowance re-checked before each utterance), memory-only audio and transcripts with a leaking positive control, server-rendered speech (Ruling 15). Gap recorded (Ruling 17): a Family Table device that is wrong and never reports blocks nothing on the server until it does; the device rule stays primary |
| Photos, ingestion hardening | C-20, C-21 | Planned M8 |
| Tracker sealed; notifications generic; household privacy; share links; low-intake | C-23 to C-27 | Planned M9 |
| Pantry location and moderation | C-28, C-29 | Planned M11 |
| Policies, rights workflow, incident runbook | C-30, C-31, C-32 | Planned M12 |
| Vendor reviews and DPAs | C-34 | OpenRouter: code gate built M4, review checklist `vendors/openrouter.md`, DPA not signed; others M12 (`processors.json`) |
| Backups, MFA, vulnerability management, network, CSP | C-35, C-36, C-37, C-38, C-40 | Planned M12; Dependabot and `npm audit` built |
| Age and children, region gating, family data | C-39, C-44, C-45 | Planned M3 / M12 / M13 |
| Ownership, workforce, claims | C-41, C-42, C-43 | Now / M12 |
| New items found by this assessment | risk-register N-1 to N-11 | Proposed (not yet in ROADMAP) |

**Residual risk and sign-off**

| Field | Value |
|---|---|
| Residual risk after measures | Forecast Medium at worst (R-01, R-04, R-15 at 10). No High forecast. **Re-score when the C-ids land.** |
| Measures approved by | **[TBD: owner]** |
| Residual risk accepted by | **[TBD: owner]** |
| DPO / counsel advice | **[lawyer]** |
| Advice accepted or overruled, with reasons | **[lawyer / owner]** |
| Supervisory authority consulted | **[lawyer: only if High residual]** |

### 6.1 Re-reviews (risk-register N-11)

#### 2026-11-11: mentor AI with tools (M4)

| Field | Value |
|---|---|
| Trigger | A new AI feature (N-11): the Pan, the mentor, talks to a model through OpenRouter (a processor whose DPA is not signed) and proposes writes to health tables with tools |
| What is processed | The player's typed turn; with `ai_health` only, their rules, today's meal slots, the pantry, open cards and recent history (C-13); without it, health turns never reach the model. Transcripts (`messages`) are stored sealed only with `health_data` (C-12), 30 days. Proposal cards (`mentor_proposals`) sealed, 30 min open, 24 h after a decision |
| What the model can do | Propose only (`propose_rule`, `propose_meal_log`, `propose_profile`, `propose_pantry_change`); it has no write tool (README Ruling 1). Every write needs a tap, or a typed yes on a non-severe card, through the server's guard (§7.6b.1). Its free text is never shown or stored (Ruling R9); the player sees cards and written lines |
| New risks | R-01 (an AI provider sees health data): limited by `ai_health`, minimised context, ZDR and `data_collection: "deny"` pinned in code (C-14), and the production DPA gate (P-11). R-15 (a wrong allergy answer): the model never says a dish is safe or spells an allergen; code spells, reads back and checks (§7.6b.2), and a term the ledger can't resolve is never filed (§2.2). R-10 (children): a child guard answers with a fixed line and keeps nothing; Family Table is scripted only (§19). Prompt injection (S16–S20): taps never arrive as text, pasted rules are dropped (pre-flight C4), and nothing writes without a tap |
| Evidence | `apps/api/test/mentor-*.test.ts`, `e2e.safety.test.ts`, `free-forever.test.ts`; the eval (`npm run eval:mentor`: the spike's 41 cases, 3 runs each, 0 hard safety fails required; its record `apps/api/eval/last-pass.json` is checked in CI by `test/eval-gate.test.ts`); the game's never-rules and free-forever e2e scans |
| Still open | The OpenRouter DPA and the C-14 parameter-name and account-level checks (`vendors/openrouter.md`, founder actions); C-39's actual-knowledge procedure and child-directedness review (M12); counsel on Art. 22 and EU AI Act Art. 50 transparency for the Pan (§7 item 9) |
| Residual risk | Unchanged forecast (Medium at worst) **provided** production keeps AI off until the DPA is signed, which the code enforces. **[owner sign-off]** |

#### 2026-11-11: weekly loop (M5)

| Field | Value |
|---|---|
| Trigger | A new consent-purpose scope and new personal data (N-11): the M5 weekly loop adds the progress ledgers, weekly plans and market runs, margin notes, Cooked for Someone (the Shared Table) and per-account device partitions. The `health_data` notice moves to v3 to name notes, plans and market lists. No new processor and no new AI feature beyond the plan card (the model proposes dish *names*; code matches and checks them, Ruling 14) |
| What is processed | **Progress** (`progress_events`, `reward_grants`, U-5, behavioural data): content-free facts of play (a recipe, quest, technique or frame id; a local date; for a meal log the local minute and the log's random id, no content) and what each earned. **Plans and market runs** (`meal_plans`, `market_runs`, H-11, health data by the Step 6 ruling): dish slugs per weekday, the hard-week flag, the shopping list with its rules-engine swaps and ❓ marks. **Margin notes** (`margin_notes`, H-12, health data, Ruling 9): ingredient ops and up to 280 characters of the player's own words. **Cooked for Someone** (`shared_table`, H-13, third-party data, contract): a fixed count and optionally one fixed relationship word, never a name. **Device partitions** (L-5): signed out, the device keeps the guest's progress, plan and list (content-free or dish slugs); signed in, each account has its own partition keyed by a SHA-256 of its email, read only while that account is signed in |
| New risks | R-19 (data about people the player fed): fixed sets only, no names, a strict server shape. R-35 (progress slugs reveal diet): a list of dishes cooked can hint at a diet or religion. R-12 (a shared device): a signed-in account's events stay on the device only until synced; a signed-in `meal_logged` waits on the device (its day and minute) until the server answers. R-13 (inference from metadata): plan `week_start` and Shared Table `cooked_on` are plain dates. Review Focus 2 (something earned taken back): a grant could be lowered by an undo, a delete or a retune |
| Mitigations | **Sealing:** every new table's content is sealed S-U per row with AAD (plans, runs, notes, the Shared Table); the recipe slug of a note is inside its seal. **Consent:** notes, plans, market runs and `meal_logged` events need `health_data` (403 otherwise; `HEALTH_TABLES`, so a withdraw-with-delete erases them); the v3 notice names them; consent is free, so nothing is gated by payment. **No names:** Cooked for Someone takes enums only, and core drops a typed name before anything is built (Ruling 10). **Retention:** plans and runs 8 weeks after their week ends (C-6); progress for the account's life; on the device, synced events are deleted on sign-out and a guest's progress moves to an account only on a tap (C1 ruling). **Export and delete:** every new table is in `GET /me/export` decrypted (`progress`, `plans`, `marketRuns`, `marginNotes`, `sharedTable`) and erased by `DELETE /me` (cascade); notes, entries and plans also have their own delete. **Nothing taken back:** `reward_grants` is append-only, a database trigger refuses any UPDATE (Step 12 migration), and only the account-delete cascade removes a grant. **Family Table** keeps nothing from the loop (Ruling 25, C31). **Minimisation:** no recipe slug or note in a URL (P-5, C32), nothing about food in a log (C-9), counts-only audit rows, grants hold no time finer than the day |
| Evidence | `apps/api/test/progress.test.ts`, `week.test.ts`, `book.test.ts`, `never-take-back.test.ts`, `free-forever.test.ts`, `account.test.ts`, `inventory.test.ts`; `packages/core/src/progress/never-rules.test.ts`, `no-streak.test.ts`; the game's `weekly-loop`, `never-rules`, `free-forever`, `book` and `cook-log` e2e |
| Still open | **[lawyer]** items in `ROADMAP.md` (M5 section): grants kept after a `health_data` delete; audit-row timing; the v3 notice wording; the 13-month usage retention; pending `meal_logged` events on the device; swap names written to the pantry; whether dish slugs and meal dates need `health_data`; plans and runs as health data |
| Residual risk | Low for the new data, **provided** counsel confirms the bases above. **[owner sign-off]** |

#### 2026-11-12: gamified market (M6)

| Field | Value |
|---|---|
| Trigger | A new consent-purpose use and new personal data (N-11): the M6 market adds stall rounds (practice minigames at four stalls), the Protein Counter (Big Bram's stall for players whose rules exclude meat), a progress snapshot cache, list amounts and stall swaps on the market run, a check-off of the market list from the conversation, and a curated seasonal table read with the player's region. **No new processor. No new AI feature** beyond the check-off tool (`propose_check_off`), which runs under the same C-14 policy (ZDR, `data_collection: "deny"`, the allow-list, the DPA gate) and the M4 eval gate (one recorded pass, Step 8). Stall keepers have no AI: their lines and FAQ answers are written. The one new consent-purpose use is `health_data` for sealed Protein Counter rounds |
| What is processed | **Stall rounds** (`progress_events` kind `stall_round`, U-5): the stall and each answered question id with its pick, **sealed per row for every round** (answered ids can imply a rule over time); the server decides correctness from the stall files and the player's rules (§2.1), and stores no list of the questions shown. **Protein Counter rounds** reveal a meat-excluding rule (diet, religion or condition: GDPR Art. 9, WA MHMDA): accepted only with `health_data`. **The snapshot** (`progress_snapshots`, U-6): a sealed cache of the U-5 fold, dropped by a database trigger whenever any event is erased. **The market check-off** (H-11, I-4): a closed grammar ("got the moong dal") ticks rows at once, with an Undo; a model-proposed card ticks only on a tap; both need `health_data` for the write; with no consent the card waits sealed behind the consent card (30 minutes). **Amounts and stall swaps** inside the sealed `market_runs` row, every swap re-derived by the server. **Region** (P-1): resolved for seasonality by code only, `null` on no match or ambiguity; never added to a prompt by M6 (M4's `profile.region` is unchanged, C32), never in a URL |
| New risks | R-36 (a hidden question answered through a forged event: an answer to a question the player's rules hide would be stored and earn XP, and a stored id could reveal a rule). R-37 (a stale snapshot outliving an erased event, or lowering a value). R-38 (region misattribution: another country's calendar, or a default hemisphere, shown as the player's). R-35 widens: answered stall question ids can hint at a diet, as dish slugs do. R-12: signed-out stall rounds, Protein Counter ones included, sit unsealed on the device. Review Focus 4: a write the player did not ask for (a model-proposed check-off ticking without a tap) |
| Mitigations | **Core validation (R-36):** `grantsFor` and the server re-check every answered question with the player's rules on the round's date (no substitutions); a hidden, unknown or forged question makes the event `bad_event`, nothing stored. **The trigger (R-37):** `progress_events_drop_snapshot` deletes the snapshot in the same transaction as any event delete; a property test pins view(snapshot + tail) = view(full); grants are append-only. **Null on ambiguity (R-38):** `seasonRegionFor` needs the player's own country and region to match one table entry; no match or several gives `null`, and the player is told "no calendar yet" (`market.no_calendar`); no fallback to another country's data. **Sealing and consent:** every round sealed S-U with AAD; Protein Counter rounds gated on `health_data`; a withdraw-with-delete erases every round, with grants kept (spec §6). **Writes:** model-proposed check-offs wait for a tap (Ruling 14); the grammar runs only on a whole safe message (C30); Family Table records nothing. **Free forever:** no market path reads an entitlement; a capped player with the AI off plays every stall and checks off by the grammar (`free-forever.test.ts`). **Minimisation:** no stall id, question id, pick or region in a URL or a log; nothing region-derived in a prompt |
| Evidence | `apps/api/test/market.test.ts`, `progress.test.ts`, `snapshot.test.ts`, `mentor-check-off.test.ts`, `consent.test.ts`, `account.test.ts`, `never-take-back.test.ts` (stall-round grants survive), `free-forever.test.ts` (the M6 market); `packages/core/test/no-pressure.test.ts`, `no-streak.test.ts`, `market-content.test.ts`, `season-source.test.ts`; the game's `market`, `market-day`, `market-week`, `never-rules`, `a11y` and `free-forever` e2e; the eval record `apps/api/eval/last-pass.json` |
| Still open | **[lawyer]** items in `ROADMAP.md` (M6 section): whether the v3 notice must name stall rounds (and the re-consent cost of a v4); Protein Counter rounds as health data and their grants kept after a delete; the snapshot as a derived cache; device stall rounds without consent; the pending check-off card stored without `health_data`; the region field |
| Residual risk | Low for the new data, **provided** counsel confirms the bases above. We never claim HIPAA compliance. **[owner sign-off]** |

## 7. Open questions for counsel

1. Is a DPO mandatory, and is an Art. 27 representative needed at launch? **[lawyer]**
2. Does any health processing fall under "necessary to provide the requested service" for WA, NV and CT, or is consent needed for all of it? **[lawyer]**
3. Valid Art. 9 route for the allergy safety check if the user declines `health_data` (the product still works blind). **[lawyer]**
4. Transfers to OpenRouter and its upstream providers: mechanism, transfer impact assessment, and whether to restrict health prompts to EU or US providers. **[lawyer]**
5. Audit-log retention against the deletion right (pseudonymized subject) **[lawyer]**.
6. Neutral age screen, COPPA mixed-audience analysis, UK children's code for 16 to 17-year-olds. **[lawyer]**
7. California CMIA §56.06 status of diet journeys with symptoms. **[lawyer]**
8. Whether the mail provider and GlitchTip are processors or joint controllers. **[lawyer]**
9. Art. 22 and EU AI Act Art. 50 transparency for the Pan. **[lawyer]**
10. The M5 weekly loop: whether dish slugs in progress and meal-log dates need `health_data`; plans and market runs as consumer health data; grants kept after a `health_data` delete; the device-side wait of a signed-in meal log's day and minute (`ROADMAP.md`, M5 `[lawyer]` items). **[lawyer]**
11. The M6 market: whether the `health_data` notice v3 must name stall rounds (a v4 means every player consents again); sealed Protein Counter rounds as health data, and their grants kept after a `health_data` delete; the progress snapshot as a derived cache under U-5's basis; signed-out device stall rounds kept without consent; the pending check-off card stored without `health_data`; the region field as coarse location (`ROADMAP.md`, M6 `[lawyer]` items). **[lawyer]**
12. The M7 voice accessibility need: explicit consent (`health_data`) or "necessary for the service" as its basis, so that declining consent does not cost a disabled player unmetered voice; a self-declared need with no proof; the abuse ceiling applying to accessibility players too; the `voice` notice v1 wording (`ROADMAP.md`, M7 `[lawyer]` items). **[lawyer]**

## 8. Review plan

- Complete the **[TBD]** and **[verify]** items as milestones land (each C-id's PR updates this file).
- Annual review; re-open on any trigger in risk-register N-11.
- Keep the version history in git. Each sign-off records the commit hash.

## 9. This document as the CPRA risk assessment and the MHMDA documentation

**One document, three uses.** The structure (processing described, benefits weighed against risks, safeguards, sign-off) is meant to satisfy all three. It has not been checked against any of them **[lawyer]**.

**CPRA / CCPA risk assessment** (CPPA regulations on risk assessments for processing sensitive personal information; effective 1 January 2026, phase-in dates **[verify]**):

- Kitchen Quest is probably below the CCPA thresholds at launch (compliance report §2.6), so this is **voluntary readiness** unless thresholds are met. Monitor the 100,000-consumer and revenue thresholds.
- Mapping: categories of sensitive personal information (health) = inventory §3.3 and §3.4; purposes = §2.2; operational elements (collection, use, retention, disclosure, processors) = inventory and `processors.json`; benefits vs. risks = §4 and §5; safeguards = §6; whether risks outweigh benefits and who decided = §6 sign-off.
- Any automated decision-making technology (ADMT) rules **[verify]**: the rules engine and mentor are advisory and the player confirms writes.

**Washington MHMDA documentation** (RCW 19.373) and Nevada SB 370:

- The Act does not require a DPIA, but this file supports: the consumer health data categories and purposes (inventory, §2.2), the list of processors and third parties for access requests (`processors.json`, C-7), the consent records (J-1), the access-limits and security evidence (§6), and the rule that nothing is sold (P-10).
- The separate **Consumer Health Data Privacy Policy** (C-30) must match §2.2 and §2.5 exactly. Each sentence in it should map to a row here or a control.
- Geofencing: none (P-6, C-28); Pantry cells are 1 km and health-care facilities are never anchors.

**Maryland, Connecticut, Colorado and other state data-protection assessments:** the same content can be used as the "data protection assessment" required for sensitive data processing where those laws apply **[lawyer: which apply and when]**.
