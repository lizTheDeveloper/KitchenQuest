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
| Voice conversation | V-1 to V-3 | 6(1)(b), 9(2)(a) | `voice` |
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
| AI gateway minimisation, OpenRouter pinned, disclosure | C-13, C-14, C-16, C-22 | Planned M3 / M8 |
| Voice privacy | C-18, C-19 | Planned M7 |
| Photos, ingestion hardening | C-20, C-21 | Planned M8 |
| Tracker sealed; notifications generic; household privacy; share links; low-intake | C-23 to C-27 | Planned M9 |
| Pantry location and moderation | C-28, C-29 | Planned M11 |
| Policies, rights workflow, incident runbook | C-30, C-31, C-32 | Planned M12 |
| Vendor reviews and DPAs | C-34 | Planned M3 / M12 (register started: `processors.json`) |
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
