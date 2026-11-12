# Kitchen Quest: Health-Data Compliance Plan

**Date:** 2026-11-09
**For:** Liz Howard (Multiverse Games / The Multiverse School)
**Status:** Draft engineering and compliance analysis. Nothing in the repo has been changed apart from adding this file.
**Inputs:** the founder's HIPAA checklist (a local copy of `github.com/capetron/hipaa-compliance-checklist`, CC BY-SA 4.0, written by a security vendor); spec `docs/superpowers/specs/2026-11-09-kitchenquest-design.md`; `docs/business/2026-11-09-value-chain-monetization.md`; `docs/business/2026-11-09-family-mode.md` (§19, read after the spec added it); `apps/api` at commit `adf1cdd` plus uncommitted Step 3 auth work; `plans/m2-api/`.

> **This is not legal advice.** It is an engineer's reading of the regimes, written to scope the work and to make the lawyer's time cheaper. Where I am unsure of a fact, a date or how a law applies, I mark it **[unsure]** or **[verify]**. My knowledge of law and of vendor terms runs to about mid-2026, and any later rulemaking, enforcement or vendor-policy changes are not reflected here. §9 lists what a lawyer has to confirm.

---

## 0. Bottom line

1. **HIPAA almost certainly does not apply to Kitchen Quest as designed** (direct-to-consumer, user-entered data, no clinical customers). Kitchen Quest is not a covered entity and not a business associate.
2. **Recommendation: (a) stay outside HIPAA by design.** Write explicit product rules (§8) that keep it there. Treat (b), a separate HIPAA-ready B2B track, as a costed option you only open once a paying covered-entity customer has signed a letter of intent. Estimated cost: one-time **$60k–$200k** plus **$40k–$120k a year** (§1.4).
3. **The regimes that do apply now are consumer health-privacy laws, and they are stricter on consent than HIPAA is:**
   - the FTC Health Breach Notification Rule (likely applies)
   - FTC Act §5 (applies)
   - Washington's My Health My Data Act, which has a private right of action (applies)
   - Nevada SB 370 (applies)
   - Connecticut's consumer-health-data provisions (likely apply)
   - California's CMIA (possibly applies) **[unsure]**
   - CCPA/CPRA (probably not yet, below thresholds)
   - GDPR Art. 9 (applies the moment EU users are allowed)
4. **Do not market Kitchen Quest as "HIPAA compliant."** The FTC has treated HIPAA badges on non-HIPAA health apps as deceptive (GoodRx, 2023). The right claim is a precise description of what you actually do.
5. **Use the founder's checklist as a security baseline anyway.** The Security Rule safeguards are good practice and line up with the "reasonable security" duty in the laws that do apply. §5 grades every item.
6. **Ten engineering items must land in M2, before Step 5 starts writing health data:**
   - consent ledger
   - key ring and rotation
   - binding ciphertext to its user and row
   - access audit log
   - retention job
   - log redaction
   - complete deletion
   - export of consents and processors
   - an org/health join ban
   - an e2e consent test

   The full list is in §6.

---

## 1. HIPAA applicability

### 1.1 Who HIPAA covers

HIPAA's Privacy, Security and Breach Notification Rules bind only two kinds of entity:

- **Covered entities:**
  - health plans
  - health-care clearinghouses
  - health-care providers who conduct HIPAA standard transactions electronically (in practice, providers who bill insurers electronically)
- **Business associates (BAs):** anyone who creates, receives, maintains or transmits protected health information (PHI) *on behalf of* a covered entity, and their subcontractors.

Health information becomes PHI because of **who holds it and for whom**, not because of what it says. An allergy list a consumer types into a consumer app is not PHI. The same list typed into a clinic's patient portal is.

### 1.2 Why Kitchen Quest direct-to-consumer is neither

| Test | Kitchen Quest today | Result |
|---|---|---|
| Health plan? | No. Monetization is a Guild membership, School courses and seat licences. Spec §16 bans data deals with insurers. | Not a CE |
| Clearinghouse? | No claims processing | Not a CE |
| Provider conducting standard transactions? | It gives no treatment and does no billing. It is positioned as "a cooking game and food log, not a medical device" (spec §9), and journeys are "tools to use with a clinician" (§4.5). | Not a CE |
| Acting on behalf of a CE? | Players choose the app themselves. Every piece of health data is entered by the player (§3.2 onboarding, §4.4 rules, §4.5 check-ins, §5 logs). No clinic sends data in, and none receives data out. | Not a BA |

This matches HHS's own guidance on health-app scenarios (OCR, "Health App Use Scenarios & HIPAA", 2016, and the later API/app FAQs **[verify current URL]**). A consumer who downloads an app and enters their own data is outside HIPAA. So is a consumer who tells their provider to send records to an app of their choosing. An app becomes a BA only when a covered entity contracts for it to handle PHI on the CE's behalf.

Two consequences:

- The planned "share with my dietitian" report (business doc §A row 5b, §D.8) is **outside HIPAA** if the player creates it and sends it themselves. Once the report reaches a dietitian who is a covered entity, it becomes PHI *in the dietitian's hands*, and that is the dietitian's obligation, not Kitchen Quest's. Kitchen Quest must not then receive anything back from the dietitian on the dietitian's behalf (see 1.3).
- Many cash-pay dietitians are not covered entities at all, because they never bill electronically. Do not rely on that, though. Design as if every clinician is one.

### 1.3 Activities that would trigger HIPAA

Each of these would make Kitchen Quest a **business associate** (or a subcontractor BA). The first two are the most likely ways it could happen by accident.

| # | Trigger | Where it could come from in current plans |
|---|---|---|
| H-1 | **A covered entity pays for seats and gives Kitchen Quest a patient roster** (names or emails of its patients), or Kitchen Quest invites "patients of Clinic X." A provider's patient list is PHI on its own. | Community-org seat licences (spec §16; business doc §A row 11). **FQHCs, community health centers, hospital "food-as-medicine" programmes, WIC clinics run by health departments and university health services are often covered entities.** A food bank or newcomer programme usually is not. |
| H-2 | **A clinician dashboard or report flowing to a CE under contract**: the clinic licenses Kitchen Quest so its dietitians can see patients' logs, symptoms or journey adherence. | B2B2C dietitians and clinics (business doc §A 5b, "defer to year 2+"); octalysis audit CD5 "class dashboard" if sold to a clinic |
| H-3 | **Receiving data from a provider or EHR on the provider's behalf**, such as importing a clinic's allergy list over FHIR under a clinic contract. (A patient pulling their *own* record through a patient-access API at their own direction does not make you a BA. Wearables and health-platform integrations are out of v1 scope anyway, §14.) | Not planned; would arrive with any clinical integration |
| H-4 | **Health-plan or employer wellness programme delivered through a group health plan.** | Already banned in spec §16 ("never data deals with insurers or employers"). Employer seats with zero data back are still allowed; keep it that way. |
| H-5 | **Subcontracting for another BA**, such as white-labelling the rules engine *hosted by Kitchen Quest* for a digital-health company that serves CEs. Licensing the engine as self-hosted software, with no Kitchen Quest access to data, does not trigger HIPAA. | Business doc §3 Wardley ("could later be licensed B2B as software, without user data") |
| H-6 | **"Food is medicine" or produce-prescription programmes funded by Medicaid or a health plan** that enrol participants through a clinic. | Grant and community channel (business doc §E row 9) |

### 1.4 Options: (a) stay out by design or (b) build a HIPAA track

**Recommendation: (a) now; keep (b) as a deferred, separately built track.**

**Why (a):**
- The product works without clinical customers.
- Every v1 revenue line is consumer or non-clinical.
- The business doc already scores clinician B2B as a "Question Mark, year 2+" (BCG) with RICE 0.15.
- The rules in §8 cost almost nothing to follow, and they also reduce exposure under My Health My Data and GDPR.

**What (a) requires (product rules, §8):**
- Never accept PHI from a covered entity, and never act on a CE's behalf.
- No rosters: orgs distribute anonymous seat codes, and players sign up themselves.
- Orgs see seat counts only.
- Clinician sharing happens only by the player, through an expiring link or PDF.
- A contract checklist screens every org customer: "Are you a HIPAA covered entity? Will you send us patient information?" If yes to either, stop.

**What (b) would require.** Build it as a **separate deployment** (its own database, keys, hosting account and AI path) so the consumer product stays outside HIPAA. All figures are rough estimates. Get quotes before you rely on them.

| Item | What it involves | Rough cost (estimate) |
|---|---|---|
| BAAs | Template BAA for customers; downstream BAAs with every vendor that touches ePHI | Lawyer: $5k–$20k |
| BAA-signing hosting | Hetzner: **unknown, and I believe it does not offer a HIPAA BAA [verify]**. Likely move the track to AWS, GCP or Azure, which sign BAAs for eligible services | +$500–$3k a month infra, plus migration engineering |
| BAA-signing AI path | OpenRouter: **unknown [verify]**; I am not aware of a BAA offering. The upstream providers serving `qwen/qwen3.8-27b` change with routing: **unknown**. Many inference resellers do not sign BAAs. Alternatives: self-host Qwen on BAA-covered GPU, or a hyperscaler model service that is BAA-eligible (whether Qwen models are on one is **[verify]**). This breaks the "OpenRouter only" decision for the track | Self-hosted GPU: ~$1k–$5k a month; engineering 2–6 weeks |
| Voice stack | The self-hosted Whisper/TTS software needs no BAA (you run it), but the **host** does (Hetzner: unknown/likely no). GPU provider, if not Hetzner: unknown | Included above |
| Other vendors | **Unknown for all:** SMTP or email provider (patient email = PHI), GlitchTip (if hosted SaaS; self-hosted inherits the host), object storage, backups, CDN/DNS if any, Merchant of Record (payment processing is partly exempt under HIPAA §1179 **[verify]**) | Varies |
| Risk analysis | Formal, documented Security Rule risk analysis (45 CFR 164.308(a)(1)), repeated annually | $10k–$40k outsourced, or ~3–4 weeks internal |
| Policies and procedures | Privacy, security, breach, sanctions and contingency policies; retain 6 years | $5k–$25k |
| Audit logging | Immutable access logs on every ePHI read, regularly reviewed; SIEM or log retention | Engineering 2–4 weeks; $100–$1k a month |
| Workforce training | Documented HIPAA training at hire and annually, with sanctions | Low ($0–$2k a year), but must be documented |
| Security testing | Annual pen test, vulnerability scans (the 2024–25 Security Rule NPRM would mandate both **[status of final rule: verify]**) | $10k–$30k a year |
| Buyer demands | Health systems usually want SOC 2 Type II or HITRUST and security questionnaires | SOC 2: $20k–$60k first year |
| Insurance | Cyber/E&O cover with HIPAA limits | Rises with the track |

**When to open (b):** a signed LOI from a covered entity that covers at least the first-year cost, plus a lawyer's sign-off on the track's structure. Until then, answer clinic interest with the player-initiated share report.

### 1.5 Vendor BAA status

| Vendor / component | Role | BAA for track (b) | DPA for consumer track (needed now) |
|---|---|---|---|
| OpenRouter | AI router (all AI, §7) | **Unknown**; not known to offer one **[verify]** | **Unknown**: check ToS, privacy policy, any DPA, and the data-retention/ZDR options |
| Upstream model providers behind `qwen/qwen3.8-27b` | Inference | **Unknown**; varies per provider; many won't sign | Covered only through OpenRouter's terms; pin providers (C-14) |
| Hetzner (compute, Postgres host, Object Storage, GPU for voice) | Hosting | **Unknown / likely no [verify]** | Hetzner offers a GDPR Art. 28 DPA **[verify current]** |
| Self-hosted Whisper STT / open-source TTS | Voice | No BAA needed for the software; the host must sign | n/a (in-house) |
| Email / SMTP provider for magic links | Mail | **Unknown** (provider not chosen) | Needed |
| GlitchTip | Error reporting | Self-hosted: none needed. Hosted SaaS: **unknown** | Needed if SaaS |
| Web Push services (Google FCM, Apple, Mozilla) | Push delivery | Payloads are end-to-end encrypted (RFC 8291), but keep health data out regardless (C-24) | Platform terms |
| Merchant of Record / payments | Billing | Partly exempt **[verify]** | Needed |
| PixelLab | Art generation | n/a (no user data) | n/a |

---

## 2. Regimes that likely apply now

The table below sorts the regimes by how sure I am that they apply. In this section, "health data" means all of the following:
- allergy and diet rules (§4.4), including severity
- diet journeys, especially low-FODMAP, which strongly implies IBS (§4.5)
- symptom check-ins (§4.5)
- meal logs and nutrition (§5)
- the low-intake check-in (§5)
- mentor conversation transcripts that contain any of the above (§7.0, §7.7)
- food photos (§7.2)
- Neighborhood Pantry posts that carry allergen tags and a location (§18)

| Regime | Applies? | Confidence |
|---|---|---|
| FTC Act §5 (deception/unfairness) | **Yes** | High |
| FTC Health Breach Notification Rule (16 CFR 318) | **Likely yes** | Medium-high |
| Washington My Health My Data Act (RCW 19.373) | **Yes** for WA residents or data collected in WA | High |
| Nevada SB 370 (consumer health data) | **Yes** for NV consumers | Medium-high |
| Connecticut CTDPA consumer-health-data provisions | **Likely yes**; some provisions apply regardless of thresholds | Medium **[unsure]** |
| California CMIA (Civ. Code §56.06/56.10) | **Possibly**: diet journeys used to manage a condition | **[unsure], lawyer** |
| CCPA/CPRA | **Probably not yet** (thresholds); design for it | Medium |
| Other state comprehensive laws (CO, VA, TX, OR, MD, etc.) | Mostly threshold-gated; Maryland is strict on sensitive data | Medium **[unsure]** |
| GDPR (and UK GDPR) Art. 9 | **Yes**, the moment EU or UK users are allowed | High |
| COPPA | Not while accounts are 16+, **unless** the service is found "directed to children" or family mode admits under-13s | **[unsure], lawyer** |
| BIPA / Texas CUBI (biometrics) | Not if no voiceprints or face geometry are ever derived | High, if rule P-7 holds |
| HIPAA | No (§1) | High |

### 2.1 FTC Health Breach Notification Rule (HBNR), as amended in 2024

- **Scope.** The rule covers vendors of **personal health records (PHRs)** and PHR-related entities that HIPAA does not cover. The 2024 amendments (final rule April 2024, effective 29 July 2024) did three things:
  - They clarified that health apps are covered. A "health care provider" now includes anyone who "furnishes health care services or supplies", which the FTC reads to include app developers.
  - They defined "PHR identifiable health information" broadly.
  - They said a PHR is an electronic record that **"has the technical capacity to draw information from multiple sources"** and is managed or shared by or for the individual.
- **Does Kitchen Quest fit?** Probably yes. Kitchen Quest draws health information from:
  - user input
  - AI estimates from photos and text
  - the USDA nutrition database (recipe-derived nutrition)
  - (later) household members

  The FTC's commentary treats an app that combines user input with data from another source (even non-health data such as an API or calendar) as drawing from multiple sources. **[lawyer to confirm]**
- **What counts as a breach.** "Breach of security" includes **any unauthorized acquisition, including an unauthorized *disclosure* by the company itself**, not just hacks. The GoodRx (2023) and Easy Healthcare/Premom (2023) actions were brought under the HBNR for sharing data with ad and analytics SDKs. For Kitchen Quest the realistic triggers are:
  - an AI provider that logs or trains on prompts the user didn't authorize
  - health data in error reports or logs sent to a third party
  - a database or backup leak
- **Notification.**
  - **Individuals:** without unreasonable delay, no later than **60 calendar days** after discovery. Email is allowed, with the content the amended rule requires (what happened, what data, the third party involved, steps to take, how to reach you).
  - **FTC, 500 or more people:** notify at the same time as individuals, no later than 60 days.
  - **FTC, fewer than 500:** report in an annual log within 60 days of the end of the calendar year.
  - **Media:** if 500 or more residents of one state are affected.
- **Penalties.** Civil penalties per violation, about $53k in 2025 **[verify the current inflation adjustment]**.

### 2.2 FTC Act §5

This applies to every consumer product. The relevant enforcement pattern for health apps:
- Flo Health (2021)
- GoodRx (2023): HIPAA seal, sharing with ad platforms
- BetterHelp (2023, $7.8M): sharing health questionnaire data for ads
- Premom (2023)
- Vitagene/1Health (2023): retention and deletion promises
- Cerebral and Monument (2024): tracking pixels

Implications for Kitchen Quest:

- **Every privacy promise in the spec becomes a binding representation once published:**
  - "no third-party ad trackers"
  - "AI requests send only what the task needs, with no user identifiers"
  - "audio never stored"
  - "deleted when the account is deleted"

  Each needs a test or a control (§6) before it goes into the policy.
- **Do not say "HIPAA compliant," "HIPAA-secure" or show a HIPAA badge.** (This is directly relevant to the founder's request.) Say what you actually do: "encrypted health data, never sold, never shared with advertisers, deletable in one click."
- Health claims about journeys must stay "general wellness" (business doc PESTEL). That is FDA and FTC substantiation territory, not privacy, but it belongs in the same lawyer session.
- Unfairness also covers weak security, such as data that can't be deleted or retained indefinitely without need (Vitagene).

### 2.3 Washington My Health My Data Act (MHMDA, RCW 19.373)

- **In force:** 31 March 2024; small entities 30 June 2024. There is **no revenue or volume threshold**.
- **Who it covers:** any entity that does business in WA or targets WA consumers, for WA residents and for anyone whose data is collected in WA.
- **"Consumer health data" is very broad.** It includes:
  - health conditions
  - symptoms
  - bodily functions
  - **data inferred or derived from non-health data**, such as meal logs or a low-FODMAP journey implying IBS

  Allergies, diet journeys, symptom check-ins and probably meal logs and transcripts are all in scope.
- **Consent:**
  - **Separate, specific consent to collect** consumer health data, except "to the extent necessary to provide a product or service the consumer requested". The allergy checker may fit that exception; analytics, AI enrichment and Pantry sharing do not. **[lawyer: how far the exception reaches]**
  - **Separate consent to share** it with any third party, except processors under contract.
  - **Signed authorization to sell** (Kitchen Quest never sells).
  - Consent cannot be bundled into the terms of service, and cannot come from hovering, closing a box or "dark patterns".
- **A separate "Consumer Health Data Privacy Policy"**, linked prominently from the homepage.
- **Rights, answered within 45 days:**
  - confirm and access, including **a list of all third parties and affiliates the data was shared with, and their contact details**
  - delete, including passing the deletion on to processors and third parties, and archives and backups **[verify the backup timing rules]**
  - withdraw consent
- **Internal access:** limited to staff and processors who need it.
- **Processors:** must be bound by contract.
- **Security:** reasonable security practices.
- **Geofencing ban:** no virtual boundary within **2,000 feet** of an in-person health-care facility used to identify, track, collect data or send notifications. This is relevant to Neighborhood Pantry's map and any location-triggered feature (§18).
- **Enforcement:** **private right of action** through the WA Consumer Protection Act, plus the Attorney General. Class actions under MHMDA began in 2025 **[verify]**.

### 2.4 Nevada SB 370

- **In force:** 31 March 2024.
- **What it requires:** a similar consumer-health-data framework:
  - consent to collect and share, beyond what's necessary
  - a consumer health data privacy policy
  - access and deletion rights
  - limits on access
  - a geofencing ban within **1,750 feet** of in-person health-care providers
- **Enforcement:** the Attorney General; **no private right of action** **[verify]**.
- In practice, a programme that meets MHMDA also meets SB 370.

### 2.5 Connecticut and other states

- **Connecticut** (CTDPA as amended by SB 3, 2023):
  - "consumer health data" is sensitive data that requires consent
  - certain provisions apply to "any person", not only entities over the thresholds: consent to sell consumer health data, confidentiality duties for staff, and a geofencing ban within 1,750 feet of mental-health and reproductive or sexual-health facilities **[unsure which provisions are threshold-free; lawyer]**
  - 2025 amendments (SB 1295) broaden applicability to controllers processing sensitive data, from 1 July 2026 **[verify]**
- **Maryland Online Data Privacy Act** (in force October 2025; applies to processing from April 2026; threshold 35,000 consumers):
  - bans the **sale** of sensitive data outright
  - allows collecting sensitive data only where **"strictly necessary"** for the requested service

  This fits Kitchen Quest's minimization principle. Watch it as you grow.
- **New York Health Information Privacy Act** (S929): passed the legislature in January 2025. **Whether it was signed or vetoed, and its effective date: unknown [verify].** If it is in force, it is MHMDA-like and stricter on "necessary".
- **Other comprehensive state laws** (Colorado, Virginia, Texas, Oregon, Montana, Delaware, New Jersey, Minnesota and others) treat health data as sensitive and require **opt-in consent**. Most apply only above thresholds (typically 100,000 consumers). Texas has no revenue threshold, but exempts SBA-defined small businesses except that they still need consent before selling sensitive data. **Design to the strictest common denominator now:** opt-in consent, no sale, data-protection assessment.
- **Minors.** Several states have added duties for users known to be under 18, such as no profiling and heightened-risk assessments: Connecticut, Colorado (2025), and Maryland's Kids Code. Kitchen Quest allows 16–17-year-olds. **[unsure; lawyer]**

### 2.6 CCPA/CPRA (California)

- **Thresholds:** CCPA applies to for-profits doing business in California with gross revenue over $25M (inflation-adjusted, about $26.6M), or that buy, sell or share the personal information of 100,000+ consumers, or that earn 50%+ of revenue from selling or sharing. **Multiverse Games is probably below all three at launch [verify].**
- **When it applies:** health data is **sensitive personal information**. If you use it only to provide the requested service, you don't need a "Limit the use of my sensitive personal information" link. You still need notice at collection, rights handling and contracts with service providers. The CPPA's 2025 regulations (effective 1 January 2026) add **risk assessments for processing sensitive PI** and cybersecurity audits above thresholds **[verify phase-in dates]**.
- **California CMIA** may apply regardless of size. §56.06 treats a business offering software "designed to maintain medical information … in order to make the information available to an individual … for the diagnosis, treatment, or management of a medical condition" as a health-care provider for CMIA purposes. Low-FODMAP journeys with symptom check-ins, framed "to use with a clinician", come close to that line. CMIA has a private right of action with statutory damages. **[lawyer: highest-priority California question]**

### 2.7 GDPR Art. 9 (EU), and UK GDPR

This applies as soon as you offer the service to people in the EU or UK. Spec §1.1 says "public"; the regions are not decided.

- **What's special-category data:**
  - allergies and intolerances, symptom check-ins, low-FODMAP journeys and meal logs used to infer health: **health data**
  - **religious diet rules (halal, kosher, Jain, fasting) reveal religious belief**, which is also Art. 9 data. This is easy to miss: the rules engine accepts "arbitrary restrictions", so any rule's `note` can contain anything.
  - CJEU case law reads "data concerning health" broadly and includes inferences (C-184/20 *OT*, 2022; C-21/23 *Lindenapotheke*, 2024)
- **Requirements:**
  - **Art. 9(2)(a) explicit consent** for health and religion data (contract is the Art. 6 basis for the rest)
  - consent withdrawable as easily as it was given
  - **DPIA (Art. 35)**, very likely mandatory (large-scale special-category data plus new technology such as AI and voice)
  - **Art. 27 EU representative** if you have no EU establishment
  - **Art. 28 DPAs** with every processor
  - **Chapter V transfers**: OpenRouter is US-based, and upstream providers may sit in the US or elsewhere, including possibly China for Qwen-family hosts **[verify routing]**. You need SCCs or the EU-US Data Privacy Framework (check whether each vendor is certified), plus a transfer impact assessment.
  - breach notice to the supervisory authority within **72 hours**
  - records of processing (Art. 30)
- **Children:** the digital-consent age is 13–16 depending on the member state, so 16+ is safe everywhere.
- **EU AI Act:** Art. 50 transparency (tell people they are talking to an AI) applies from August 2026 **[verify timing]**. The Pan is clearly fictional, but give an explicit disclosure anyway.
- **Practical recommendation:** **geo-restrict to the US at launch**, or launch in the EU only after the DPIA, an Art. 27 representative, DPAs and a transfer mechanism are in place. Hetzner's EU hosting helps, but the AI path is the transfer problem.

### 2.8 Children: COPPA and family mode

- **COPPA** applies to services **directed to children under 13**, or with actual knowledge that a user is under 13.
- **Risk 1: the art and characters.** An 8-bit cartoon game with a talking pan and comedy NPCs has the features the FTC weighs when deciding whether a service is "directed to children" (animated characters, game format), even with a 16+ gate. A lawyer should assess whether it is general-audience or mixed-audience. The amended COPPA Rule (published 2025; compliance date 22 April 2026 **[verify]**) adds:
  - a written security programme
  - a data-retention policy
  - separate parental consent for disclosures to third parties
- **Risk 2: the age screen.** The "I'm 16+" checkbox (M2 Global Constraints) is a **non-neutral** age screen, which FTC guidance discourages because it invites lying. A neutral screen asks for a birth year or date without hinting at the cutoff, then discards it, keeping only `age_confirmed_at`. That keeps data minimal and is more defensible. **[lawyer]**
- **Family mode (spec §19, added 2026-11-09; full analysis in `docs/business/2026-11-09-family-mode.md`).** The design already minimizes well:
  - children have only parent-managed child profiles (nickname, age band, avatar, skill progress, and allergy rules the parent enters, sealed)
  - no child accounts, email, birthday, voice, photos, intake tracking or location
  - children never talk to the AI
  - the build is M13, after launch

  The open legal questions are in that doc's §B.7, and I agree with them. From the health-privacy side, three things to add:
  - **A child's allergy rules are a child's consumer health data** (MHMDA: the consumer is the child; GDPR Art. 8 and Art. 9). Record the parent's explicit consent *per child*. **Use the same consent ledger as C-1** (add `subject_kind` and `subject_id` to it) rather than a second, parallel `parental_consents` table, so export, withdrawal and audit stay in one place (C-45).
  - **Key child data per child profile** (C-4 pattern), so that deleting one child profile crypto-shreds that child's data in backups too.
  - **The UK Children's Code applies to 16–17-year-old account holders already**, if UK users are allowed (family-mode doc §B). That is another reason for P-13 region gating.

  **Until M13 ships with counsel sign-off, no child data is collected** (product rule P-9).
- **Household Kitchen (M9)** must keep each member's health data private to that member (business doc §C already says "separate private health data per person").

### 2.9 Not privacy, but in the same lawyer session

- **FDA general-wellness boundary** for journeys (business doc §PESTEL).
- **Food-sharing liability** for Neighborhood Pantry (§18 already calls for a legal check per launch region). **[unsure]** whether the US Food Donation Improvement Act (2023) or state Good Samaritan laws protect person-to-person sharing.
- **AI chatbot disclosure laws:** for example California's 2025 "companion chatbot" law (SB 243) and Utah's AI disclosure law. The Pan probably isn't a "companion chatbot", but check. **[unsure]**

---

## 3. Gap analysis against the current design and code

### 3.1 What is already good (keep it, and say so in the policy)

| Already in spec or code | Where | Regimes it helps with |
|---|---|---|
| Health fields encrypted in the application with AES-256-GCM, key id in the ciphertext header | `apps/api/src/crypto/seal.ts`; spec §9; M2 Global Constraints | HBNR (encrypted data that is breached may not count as "unsecured" **[verify for HBNR]**), MHMDA security, GDPR Art. 32 |
| Test that no plaintext ingredient ids sit in the `rules` table | M2 Review Focus 3, Step 5 | Same |
| Minimization: no birthday, no name, country only, email the only identifier | spec §9; M2 Global Constraints | MHMDA, MD "strictly necessary", GDPR Art. 5(1)(c) |
| One-click export and delete, free forever, tested | spec §9, §16; M2 Steps 7 and 8 | MHMDA/CCPA/GDPR access and deletion; FTC (Vitagene) |
| No ads, no selling, no third-party trackers, no insurer or employer data deals | spec §9, §16; business doc §D.8 | Removes most HBNR and §5 exposure (GoodRx, BetterHelp pattern) |
| AI prompts carry no user identifiers | spec §9 | GDPR minimization |
| Usage metering stores no content (tested column list) | `usage_events`; Step 2b | Minimization |
| Explicit "yes" before any health write | spec §7.0; `confirmed: true` | A good basis for consent UX, but **it is confirmation, not consent** (see G-1) |
| Magic-link tokens and sessions stored only as hashes, single use, short TTL | `auth/tokens.ts`; Step 3 | Security Rule 164.312(d) analogue |
| EXIF and GPS stripped from photos; audio never stored | spec §9, §7.7 | Minimization; BIPA avoidance |
| Pantry location at roughly 1 km grid, exact spot only after acceptance, posts expire | spec §18 | Geolocation minimization; MHMDA geofencing |
| Free-forever safety; no paywall on safety | spec §16 | Ethics; reduces "unfair" practice risk |

### 3.2 What is missing

Each gap maps to C-ids in §6.

| Gap | Detail | Fix |
|---|---|---|
| **G-1 No separate, explicit consent for health data** | `confirmed: true` confirms *one rule's content*. It is not a recorded, versioned consent to process health data at all (MHMDA, NV, CT, GDPR Art. 9). Nothing stores which notice version the player agreed to. The onboarding interview (§3.2) collects allergies by voice before any consent screen. | C-1, C-17, C-11 |
| **G-2 No consumer health data privacy policy** | Spec §9 says "Terms and privacy policy are drafted before public launch". MHMDA and NV require a **separate** consumer health data privacy policy linked from the homepage. | C-30 |
| **G-3 No breach detection or notification runbook** | Nothing on detecting incidents, the HBNR's 60-day clock, GDPR's 72 hours, or state-law mapping. | C-32, C-5 |
| **G-4 No access logging** | Nothing records who decrypted whose health data, operator access, admin scripts (`apps/api/scripts/grant.ts` touches the DB directly), exports or deletions. | C-5 |
| **G-5 Key management is a single env key; rotation is impossible in practice** | `config.ts` loads exactly one `DATA_KEY`. `open()` accepts a key map, but nothing ever supplies old keys, so rotating `DATA_KEY_ID` would make every existing rule unreadable. There is no re-seal job, no key backup or escrow procedure, and no envelope or per-user key. | C-2, C-4 |
| **G-6 Ciphertext isn't bound to its owner or row** | AAD covers only the key-id header. Someone with write access to the database could move one user's sealed rule blob into another user's row, and it would decrypt cleanly. That is an integrity gap (Security Rule 164.312(c) analogue). It is cheap to fix now and expensive once data exists. | C-3 |
| **G-7 Deletion is incomplete** | `login_tokens` stores `email` with no foreign key to `users`, so emails survive account deletion. Step 7's "user's email appears in no table" test will catch this, but there is no fix designed. Deletion doesn't reach processors (OpenRouter, object storage, mail provider logs, GlitchTip) or backups. | C-8, C-4, C-34 |
| **G-8 Logs can leak health data** | Fastify's request logger (`server.ts`, level `info`) logs `req.url`, including query strings. `GET /ingredients/search?q=peanut` (Step 5) would write the player's allergen searches to logs. `req.log.error(err)` can include request bodies. Errors go to GlitchTip. | C-9 |
| **G-9 No retention schedule** | Login tokens, sessions, conversation transcripts ("same retention rules as other conversation data", §7.7, but none are defined), usage events, logs, backups, Pantry moderation records and inactive accounts all lack retention periods. | C-6, C-12, C-35 |
| **G-10 Health data goes to the AI without consent, and minimization isn't specified** | Prompts are de-identified (§9), but the *content* is health data: rules for grounding (§7.3), symptoms, meal text, photos, voice transcripts. Nothing requires opt-in. Nothing pins OpenRouter to providers that don't retain or train on data. The business doc already warns about free Qwen variants' logging. | C-13, C-14, C-15 |
| **G-11 No DPAs or vendor reviews** | OpenRouter's retention and training terms, upstream providers, Hetzner, mail and GlitchTip are not reviewed or under contract. | C-34 |
| **G-12 Conversation transcripts aren't in the encrypted set** | Spec §9 encrypts "rules, journeys, symptoms, meal logs". Mentor and voice transcripts contain the same facts in free text. | C-12 |
| **G-13 Age and children** | Non-neutral age checkbox; possible child-directed appeal; the household and 16–17 member rules in Household Kitchen; family mode (§19, M13) needs consent per child and per-child keys. | C-39, C-45, P-9 |
| **G-14 No incident response plan or security ownership** | No named security or privacy owner, no on-call, no contact for reports (`security.txt`). | C-32, C-41 |
| **G-15 No risk analysis or DPIA** | Required by GDPR and the CPRA regulations (when applicable). It's also the most common HIPAA finding, and good practice regardless. | C-33 |
| **G-16 Export lacks consent history and the processor list** | MHMDA access includes the list of third parties; GDPR Art. 15 includes recipients. | C-7 |
| **G-17 Plan numbering mismatch** | `plans/m2-api/README.md` says deployment is "milestone 11". Spec §13 numbers Neighborhood Pantry as 11 and launch hardening as 12. The business doc says "org tables in the M11 launch plan". Align these so compliance items land in the right plan. | Plan edit (not done here) |
| **G-18 Health inferences stored implicitly** | The low-intake check-in (§5) creates a disordered-eating inference. Don't persist it as a label. | C-27 |
| **G-19 No technical guard against third-party scripts** | "No third-party ad trackers" is a policy promise with no control. A strict Content-Security-Policy makes it enforceable and testable. | C-40 |

---

## 4. The founder's HIPAA checklist: provenance and accuracy notes

I treated the checklist as reference data. Before reusing it:

- **Provenance.** The file is said to come from `capetron/hipaa-compliance-checklist`, but its badges point to `PetronellaTech/hipaa-compliance-checklist`, and it lists two different phone numbers. It is vendor marketing for Petronella Technology Group. Ignore the sales sections. CC BY-SA 4.0 means any derivative you *publish* must carry attribution and the same licence. This internal analysis paraphrases it and does not republish it.
- **Statements I could not match to my understanding of the 2024–25 Security Rule NPRM [verify against the Federal Register]:**
  - The checklist says "72-hour notification to covered entity from business associates after a breach". As I understand it, the NPRM proposed that business associates notify CEs within **24 hours of activating a contingency plan**, and that systems be restored within **72 hours**. Breach notification timing stays under the Breach Notification Rule.
  - "12-month maximum for PHI data retention review cycles" and a "24-hour update mandate" for asset inventory: I can't confirm either.
  - **Whether the NPRM became a final rule, and its compliance dates: unknown to me.**
- **Penalty figures** ("2026" inflation-adjusted tiers): not verified.
- None of this changes the conclusions below. It only matters if you build the B2B track.

---

## 5. The checklist as a security baseline

Each item is graded:
- **Now:** do it in M2 or straight away
- **Launch:** before public launch (M12)
- **B2B:** only for the HIPAA track
- **N/A:** not applicable

"Adopt" means adopt the *practice*, scaled to a small team, not the HIPAA paperwork.

### 5.1 Administrative safeguards (164.308)

| Checklist item | Grade | Kitchen Quest form | C-id |
|---|---|---|---|
| Risk analysis | **Now** (lightweight threat model) → **Launch** (documented) | A threat model of the data flows in §2 now; a documented risk assessment and DPIA before launch | C-33 |
| Risk management programme | **Launch** | Risk register in `docs/compliance/`, reviewed quarterly | C-33 |
| Sanction policy | **Launch** (one clause) / **B2B** (formal) | A confidentiality and acceptable-use clause in contractor agreements | C-42 |
| Information system activity review | **Launch** | Weekly review of the access log and auth anomalies; alerts on admin decrypts | C-5, C-32 |
| Assigned security officer | **Now** | Name one person (Liz, or the lead engineer) as security and privacy owner; publish a privacy contact | C-41 |
| Workforce authorization and supervision | **Launch** | Production access list; least privilege; no shared accounts | C-42 |
| Role-appropriate access | **Launch** | Roles: app (runtime), operator (break-glass), analyst (aggregates only, never decrypts) | C-42 |
| Terminating access | **Launch** | Offboarding checklist: revoke SSH, Hetzner, GitHub and secrets; rotate keys if a key-holder leaves | C-42, C-2 |
| Information access management (authorize, grant, modify) | **Launch** | Same, documented; production access granted only through a ticket | C-42 |
| Security reminders | **Launch** (light) / **B2B** (documented programme) | Quarterly note; phishing awareness | — |
| Malware protection | **Now** | Dependency scanning (`npm audit`/Dependabot), pinned versions, OS updates on Hetzner boxes | C-37 |
| Login monitoring | **Now** | Rate limits (Step 3 has them), failed-verify metrics, alerts | C-5 |
| Password management | **Now** | Password manager; **MFA on GitHub, Hetzner, DNS, mail, OpenRouter, payments** | C-36 |
| Incident procedures (identify, respond, mitigate, document) | **Launch** | Incident runbook with HBNR, state and GDPR clocks; incident log | C-32 |
| Data backup plan | **Launch** | Encrypted Postgres backups, 30-day retention, keys stored separately | C-35 |
| Disaster recovery plan | **Launch** | Restore runbook; RPO 24h / RTO 24h (consumer-appropriate) | C-35 |
| Emergency mode operations | **N/A** (consumer) / **B2B** | Offline play (§9) and AI fallback (§7.5) already cover continuity | — |
| Testing contingency plans | **Launch** | One restore drill before launch, then twice a year | C-35 |
| Applications and data criticality | **Launch** | Short table in the risk register | C-33 |
| Periodic evaluation | **Launch**, then annually | Annual review of this document | C-33 |
| Business associate contracts | **B2B** (BAAs) / **Launch** (DPAs, the consumer-law equivalent) | DPAs with every processor | C-34 |

### 5.2 Physical safeguards (164.310)

| Checklist item | Grade | Kitchen Quest form |
|---|---|---|
| Facility contingency operations | **N/A** | No facility; rely on the host |
| Facility security plan | **N/A** | Rely on Hetzner's datacentre controls and ISO 27001 certificate **[verify]**; keep a copy |
| Facility access control and validation | **N/A** | Same |
| Maintenance records | **N/A** | Same |
| Workstation use policy | **Launch** | One page: production data never on laptops; no health data in screenshots, tickets or chat |
| Workstation security | **Now** | Full-disk encryption, screen lock, OS updates on every machine with production or secret access |
| Disposal of media | **Launch** | Wipe or destroy drives that held secrets or dumps; Hetzner server decommission wipes **[verify]** |
| Media re-use | **Launch** | Same |
| Hardware and media accountability | **B2B** | Asset inventory (light version in C-33) |
| Backup before moving equipment | **N/A** | Cloud |

### 5.3 Technical safeguards (164.312)

| Checklist item | Grade | Kitchen Quest form | C-id |
|---|---|---|---|
| Unique user identification | **Now** (done) | UUID users; no shared operator accounts | — |
| Emergency access procedure | **Launch** (break-glass) / **B2B** (formal) | Documented break-glass DB access, logged, with a second person informed | C-5 |
| Automatic logoff | **Now** (adapted) / **B2B** (short idle timeout) | 30-day sessions suit a consumer PWA. Add "sign out everywhere", a session list, and idle expiry of 30 days since last use instead of fixed **[product call]** | C-10b |
| Encryption and decryption | **Now** (done for rules) | Extend to every health table, transcripts and photos; per-user keys | C-2, C-3, C-4, C-12, C-20, C-23 |
| Audit controls | **Now** | Content-free access log | C-5 |
| Integrity | **Now** | GCM tags (done) plus AAD binding to table, user and row | C-3 |
| Person or entity authentication | **Now** (done for players) / **Launch** (MFA or passkeys for operators) | Magic link; MFA for every admin surface | C-36 |
| Transmission security | **Now** | TLS 1.2+ everywhere, HSTS; TLS or private network between API, DB and voice service; Postgres not publicly exposed | C-38 |

### 5.4 Breach Notification Rule, Privacy Rule and NPRM items

| Checklist area | Grade | Kitchen Quest form |
|---|---|---|
| Breach risk assessment and documentation | **Launch** | Use the four-factor assessment as the triage template in the HBNR/GDPR runbook (C-32) |
| 60-day individual notice; HHS and media | **Launch** (as HBNR: FTC instead of HHS) | C-32 |
| Privacy officer | **Now** | Same person as security owner (C-41) |
| Notice of Privacy Practices | **N/A** → replaced by the consumer health data privacy policy at **Launch** | C-30 |
| Minimum necessary | **Now** | Already a principle; enforce it in the AI gateway (C-13) |
| Right of access | **Now** (export, Step 7) | C-7 |
| Right to amend | **Now** | Editable rules and logs (exists) |
| Accounting of disclosures | **Launch** (as a processor and recipient list in export) | C-7 |
| Restrictions and confidential communications | **N/A** / **B2B** | — |
| Authorization for marketing or sale | **N/A** (never sell; product rule P-10) | — |
| De-identification (Safe Harbor / Expert Determination) | **N/A** now. If you ever do research or publish aggregates, adopt Expert Determination-level rigour with separate opt-in (P-10) | — |
| NPRM: mandatory encryption | **Now** | Done/extend |
| NPRM: MFA | **Launch** (operators) | C-36 |
| NPRM: network segmentation | **Launch** | Database and voice on a private network; only the API is public | C-38 |
| NPRM: vulnerability scanning (6-monthly) and annual pen test | **Now** (dependency scanning) / **Launch** (one external test) | C-37 |
| NPRM: asset inventory | **Launch** (light) | C-33 |
| NPRM: retention review | **Launch** | C-6, C-35 |

---

## 6. Engineering requirements

**Must land in M2** marks items that need to be in before M2 Step 5 writes health data, or before the M2 data model is frozen.

- **M2:** plans exist; Steps 0–2b are done and Step 3 is in progress.
- **Later milestones:** no plan files exist yet. The paths below are the recommended plan files.

**Proposed M2 insertion:** add `plans/m2-api/step-2c.md`, "Compliance foundations (consent, key ring, AAD, access log, retention)", **between Step 3 and Step 5**. Step 3 auth is already uncommitted work, and Step 4 can run in parallel. Then amend Steps 3, 5, 7 and 8 and the README Global Constraints as noted.

| Id | Requirement | Milestone | Plan file | M2 now? |
|---|---|---|---|---|
| **C-1** | **Consent ledger.** Add table `consents(id, user_id → users cascade, purpose text, notice_version text, notice_sha256 bytea, granted_at, withdrawn_at null, method text)`. Purposes: `health_data` (collect and store allergy, diet, journey, symptom and meal data), `ai_health` (send health data to the AI), `voice`, `pantry_location`, `research` (reserved, never default). Add helpers `grantConsent`, `withdrawConsent` and `hasConsent(db, userId, purpose, now)`. Routes: `GET /me/consents`, `POST /me/consents {purpose, noticeVersion}`, `DELETE /me/consents/:purpose`. Withdrawing `health_data` gives a choice: delete health data now, or keep it read-only until deleted (**[lawyer]**: MHMDA and GDPR expect processing to stop). | M2 | `plans/m2-api/step-2c.md` (new); README Global Constraints | **Yes** |
| **C-2** | **Key ring and rotation.** Config `DATA_KEYS` (JSON or `id:base64,id:base64`) plus `DATA_KEY_ID` (active). Boot fails if the active id is missing or any key isn't 32 bytes. `open()` always gets the full ring. Add a `rekey` script that re-seals every sealed column to the active key in batches, idempotently, and reports counts. Test: seal under k1, rotate to k2, everything still opens; after rekey and removing k1, everything still opens. Document key generation, storage (not in the repo, not in the DB backup), escrow (two people or sealed offline copy) and rotation (annually and on key-holder offboarding). | M2 | `plans/m2-api/step-2c.md`; `apps/api/src/config.ts`; `.env.example` | **Yes** |
| **C-3** | **Bind ciphertext to context.** Seal with AAD = `header ∥ table ∥ user_id ∥ row_id`, with the row id generated in the application before insert. `open()` requires the same context. Test: copying a sealed blob to another user's row, or to another table, fails to open. Do this before Step 5 stores the first rule, so no migration of real data is needed. | M2 | `plans/m2-api/step-2c.md`; amend Step 5 storage line | **Yes** |
| **C-4** | **Per-user data keys (crypto-shredding).** Envelope encryption: a random data key per user, wrapped by the key ring (`user_keys(user_id pk → users cascade, key_id, wrapped bytea)`). Health columns are sealed with the user's data key. Deleting the account deletes the wrapped key, so copies in backups become unreadable. That makes "deleted from backups" (MHMDA, GDPR) true without rewriting backups. | M2 recommended; at the latest before M12 launch, while no real data exists | `plans/m2-api/step-2c.md` | **Should.** Cheap now; costs a full re-encryption later |
| **C-5** | **Content-free access and security audit log.** Table `audit_events(id bigserial, at, actor_kind ('user','system','operator','script'), actor_id, subject_user_id, action, target, request_id)`. It holds no health content. Write an event on every operator or script decrypt, export, delete, consent change, sign-in, session revoke and rekey run. Routine self-reads by the player are counted rather than logged row by row (to avoid building a behavioural log). It is append-only: no UPDATE or DELETE grants for the app role, enforced by a migration. Retention 24 months; subject rows are **pseudonymized** on account delete (subject id replaced with an HMAC) so the security trail survives without identifying the person **[lawyer: deletion vs. security-log retention]**. Admin scripts (`scripts/grant.ts`) must write an audit event. | M2 | `plans/m2-api/step-2c.md`; amend Step 3 (sign-in events), Step 7 (export and delete events) | **Yes** |
| **C-6** | **Retention job.** A `jobs/retention.ts` scheduled task, plus a registry where each table declares its policy. M2 policies:<br>• `login_tokens`: delete 24 hours after `expires_at` or use<br>• `sessions`: delete on expiry<br>• `usage_events`: 13 months<br>• `audit_events`: 24 months<br><br>Later milestones register their tables (transcripts, Pantry posts, photos). Test with the injected clock. | M2 (framework); each later milestone registers | `plans/m2-api/step-2c.md` | **Yes** |
| **C-7** | **Complete export.** Step 7's export adds:<br>• `consents` (full history)<br>• the `processors` list (name, purpose, country, contact), generated from a checked-in `docs/compliance/processors.json`<br>• `audit_events` where the user is the subject<br><br>Later tables must extend it (Step 7 already says so). | M2 | amend `plans/m2-api/step-7.md` | **Yes** |
| **C-8** | **Complete delete.** `DELETE /me` also removes `login_tokens` by email, revokes all sessions, deletes `user_keys` (C-4), pseudonymizes `audit_events` (C-5), and queues processor deletions (object storage photos from M8; mail-provider suppression). Step 7's "no table contains the id or email" test must include `login_tokens`. | M2 | amend `plans/m2-api/step-7.md` | **Yes** |
| **C-9** | **Log and error redaction.** Fastify logger serializers log route patterns, not raw URLs with query strings (`/ingredients/search?q=…` → `/ingredients/search`). No request or response bodies. pino `redact` for `req.headers.cookie`, `authorization` and `body`. `req.log.error(err)` passes through a scrubber that drops `details` and zod input values. GlitchTip `before_send` strips request data, breadcrumbs and user email. Test: a search for "peanut" and a rule POST leave no "peanut" in the captured log stream. | M2 | `plans/m2-api/step-2c.md`; amend Step 5 (test) | **Yes** |
| **C-10** | **Org/health separation constraint.** Add business doc §D.8 to M2 Global Constraints: org tables may exist later, but no endpoint or query joins org membership to health tables, and orgs see only seat counts. Add a CI grep test or an architectural test that forbids imports of health modules from `org/`. | M2 (constraint); M12 or the org plan (tables) | `plans/m2-api/README.md` Global Constraints | **Yes** (constraint text) |
| C-10b | **Session hygiene.** `GET /me/sessions`, `DELETE /me/sessions` (sign out everywhere); sliding expiry of 30 days from last use; rotate the session token on privilege-relevant actions. | M2 (Step 3) or M12 | amend `plans/m2-api/step-3.md` | Optional |
| **C-11** | **E2E consent and free-forever test.** Extend Step 8:<br>• `POST /rules` without a `health_data` consent → 403 `consent_required` and nothing stored<br>• with consent → 201<br>• withdrawing consent stops further writes<br>• **declining consent never blocks play**: canon recipes, cook mode and lessons all work; the safety check runs with no stored rules and shows the "can't check without your rules" state<br><br>Add `consent_required` to the error codes. | M2 | amend `plans/m2-api/step-8.md`, Step 5, README error codes | **Yes** |
| C-12 | **Conversation storage.** Mentor and voice transcripts are sealed per user (C-3/C-4). Default retention 30 days, user-clearable ("forget this conversation"). Never used for training. No free-form long-term memory of health facts (spec §7.0 already says this). The profile summary is rebuilt from encrypted tables. Registered with the retention job. | M3 | `plans/m3-mentor/README.md` | — |
| C-13 | **AI gateway minimization and consent.** `AiProvider` takes a typed `PromptContext`, never raw rows. Health fields (rules, severities, symptoms, journey phase, meal logs) are included only if `hasConsent('ai_health')`. Without it, the Pan works blind and the deterministic `check` filters every suggestion (spec §7.3 already re-checks). Rule expansion sends only the term typed, never the user's other rules (C-22). No email, user id, name or exact dates. A test asserts the serialized prompt for a non-consenting user contains no rule targets. | M3 | `plans/m3-mentor/README.md` | — |
| C-14 | **OpenRouter data policy pinned in code.** Every request sets provider routing to deny providers that collect or train on data and to require zero data retention, with an allow-list of vetted providers. (OpenRouter exposes `provider.data_collection: "deny"` and ZDR controls; **verify the current parameter names and the account-level setting**.) Prompt logging stays off at account level. Never use `:free` variants for any health-adjacent call. The config refuses to boot if the policy is missing, and a test asserts every outbound body carries it. Re-review provider lists quarterly. | M3 | `plans/m3-mentor/README.md`; `apps/api/src/ai/` | — |
| C-15 | **No AI content logging.** Only `usage_events` (counts and cost). Prompts and responses are never written to logs, GlitchTip or the database apart from C-12 transcripts. Eval sets (spec §12) use synthetic or contributor-consented data only. | M3 | `plans/m3-mentor/README.md` | — |
| C-16 | **AI disclosure.** First-run and settings copy: "The Pan and the cooks are AI characters. Don't rely on them for medical advice." Medical deflection already in §7.3. | M3 | `plans/m3-mentor/README.md`; `content/` | — |
| C-17 | **Consent before the intake interview collects health data.** Onboarding shows a short **tap-based** consent card (not voice only, and not bundled with the terms) before the Pan asks about allergies. Allergies can be skipped, and onboarding completes without them (spec §6 already). The read-back stays. | M3 | `plans/m3-mentor/README.md`; `content/bureau/` | — |
| C-18 | **Voice privacy.** Audio stays in memory only: no disk, no swap-backed buffers, no logging of audio or partial transcripts. A test greps the service's filesystem and logs after a session. Voice service authentication uses the session; TLS. **No speaker identification or voiceprints** (keeps BIPA and CUBI out). Separate `voice` consent on first mic use. Transcripts follow C-12. If the GPU host isn't Hetzner, add a DPA (C-34). | M7 | `plans/m7-voice/README.md` | — |
| C-19 | **Voice accessibility flag is sensitive.** `profiles.accessibility_voice` (business doc §D.9) is a disability signal, which is health data under MHMDA and GDPR. Seal it or keep it out of plain columns, include it in export, and make sure it never reaches analytics. | M2 (if added to profile in Step 4) / M7 | amend `plans/m2-api/step-4.md` if adopted there | Yes, if the flag lands in M2 |
| C-20 | **Photos.** EXIF stripped **before** storage and before any AI call. Object keys are random, not user-derived. Encrypted application-side with the user's key (or SSE with application-held keys **[verify Hetzner Object Storage SSE support]**). Sent to the AI only for the reaction, with no identifiers. Deleted on account delete through the processor-deletion queue (C-8). Retention: kept until the user deletes them (Recipe Book). | M8 | `plans/m8-ai-features/README.md` | — |
| C-21 | **Ingestion fetch hardening.** Server-side URL fetch (spec §7.1) blocks SSRF (private IP ranges, metadata endpoints) and sends no user identifiers or cookies. This is security rather than privacy. | M8 | `plans/m8-ai-features/README.md` | — |
| C-22 | **Rule expansion minimization.** Send only the term the user typed, plus the graph vocabulary. Never send severity, notes or other rules. | M8 | `plans/m8-ai-features/README.md` | — |
| C-23 | **Tracker tables sealed.** `meal_logs`, `symptom_checkins`, `journeys` and `journey_enrollments` are sealed with C-3 AAD and C-4 keys. Only non-sensitive fields needed for queries are left plain (date, maybe meal slot), and "which journey" counts as sensitive (low-FODMAP implies IBS). Covered by export and delete. Requires `health_data` consent. | M9 | `plans/m9-tracker/README.md` | — |
| C-24 | **Notifications carry no health content.** Web Push and email text is generic ("The Pan has a thought about lunch."). No allergen, symptom or journey names on lock screens. Tested. | M9 | `plans/m9-tracker/README.md` | — |
| C-25 | **Household Kitchen privacy.** Shared plan, pantry and market list only. Each member's rules, logs and symptoms stay private. A shared plan shows "doesn't suit someone in the house" without naming who or why, **unless** that member opts in to sharing their rules with the household. Each member gives their own consent. No minors' data until P-9 is cleared. | M9 | `plans/m9-tracker/README.md` | — |
| C-26 | **Player-initiated clinician share** (if built). Generates an expiring (7-day default), revocable, unguessable link or a PDF the player downloads. No clinician accounts, no clinician write-back, no org linkage. Every access is logged to C-5 and visible to the player. Positioned as the player's own record, which keeps HIPAA out (§1.2). | M9 or later | `plans/m9-tracker/README.md` | — |
| C-27 | **Low-intake check-in stores no label.** Compute it on the fly from logs. Don't persist an "at-risk" flag or send it to the AI. Only the fact that a support message was shown may be stored, and only in the user's own conversation record. | M9 | `plans/m9-tracker/README.md` | — |
| C-28 | **Pantry location and geofencing.** No geofences or location-triggered notifications anywhere. Location is user-entered or snapped client-side to a grid cell of about 1 km; the server never receives precise coordinates. Requester ✅/⛔ status is computed on the requester's device (spec §18). The community-fridge and food-bank map is static: viewing it is not logged per user. **Health-care facilities** (clinics, WIC offices) are never map entries or notification anchors. Posts and exact pickup spots are deleted after the pickup window (registered with C-6). | M11 | `plans/m11-neighborhood-pantry/README.md` | — |
| C-29 | **Pantry moderation data.** Reports and blocks are kept 12 months. Reporters are hidden from the reported user. Post contents are deleted on expiry; moderation keeps only what's needed. | M11 | `plans/m11-neighborhood-pantry/README.md` | — |
| C-30 | **Policies.** Privacy policy, a **separate consumer health data privacy policy** (MHMDA, NV) linked from the homepage footer and the app's settings, terms, and consent copy. Version them; store the version hash in C-1. | M12 | `plans/m12-launch/README.md` | — |
| C-31 | **Data-rights workflow.** In-app export, delete and consent withdrawal (exist). A privacy email address for people who can't sign in, with a verification procedure. A 45-day SLA tracker. Appeals (CT/CO-style). A request log in C-5. | M12 | `plans/m12-launch/README.md` | — |
| C-32 | **Breach and incident runbook.** Covers:<br>• detection sources (C-5 alerts, GlitchTip, host alerts, vendor notices)<br>• triage using the four-factor template<br>• decision tree for HBNR (60 days; FTC form), GDPR (72 hours), state breach laws (mapped by a lawyer) and MHMDA<br>• notice templates<br>• contact list (lawyer, insurer)<br>• an incident log<br><br>Run one tabletop exercise before launch (scenario: an OpenRouter provider found logging prompts). | M12 | `plans/m12-launch/README.md`; `docs/compliance/incident-runbook.md` (to write) | — |
| C-33 | **Risk assessment and DPIA.** Data inventory, flows, asset inventory, threat model, risk register and DPIA (GDPR Art. 35 format, which also serves CPRA risk assessments). Annual review. | Start M2 (data inventory); finish M12 | `docs/compliance/` | — |
| C-34 | **Vendor reviews and DPAs.** For each processor: DPA signed, retention, training use, sub-processors, region, breach-notice terms, deletion API. Record in `docs/compliance/processors.json` (feeds C-7). **OpenRouter review is the first and hardest.** No new processor receives user data until it's reviewed (P-11). | M3 (OpenRouter), M12 (all) | `plans/m3-mentor/README.md`; `plans/m12-launch/README.md` | — |
| C-35 | **Backups.** Encrypted, 30-day retention, keys held separately from backups, restore drill recorded. With C-4, deleted users are unrecoverable from backups. | M12 | `plans/m12-launch/README.md` | — |
| C-36 | **Operator MFA.** MFA or passkeys on GitHub, Hetzner, DNS registrar, mail, OpenRouter, payments and GlitchTip. No production database access without VPN or SSH key plus MFA. | Now (accounts); M12 (audit) | `plans/m12-launch/README.md` | — |
| C-37 | **Vulnerability management.** Dependabot or `npm audit` in CI now; OS patching; one external pen test before launch; then every 6–12 months. | Now (CI); M12 (pen test) | `.github/workflows/ci.yml` (later); `plans/m12-launch/README.md` | — |
| C-38 | **Network and transport.** Postgres and the voice/STT internals on a private network, firewall default-deny, TLS everywhere, HSTS, secure cookies (done). | M12 (deploy) | `plans/m12-launch/README.md` | — |
| C-39 | **Age and children.** Neutral age screen (birth year asked, used once, discarded; only `age_confirmed_at` kept) **[lawyer]**. A procedure for actual knowledge of an under-16 (delete the account). A child-directed-ness review of art and copy. Family mode blocked behind P-9. | M3 (onboarding) / M12 | `plans/m3-mentor/README.md`; `plans/m12-launch/README.md` | — |
| C-40 | **Strict Content-Security-Policy.** `script-src 'self'`, no third-party origins, `connect-src` limited to the API and voice. Playwright test that no request leaves to an unlisted origin. This makes "no trackers" (spec §9) an enforced fact. | M4 game shell / M12 | `plans/m12-launch/README.md` (and the M4 plan when written) | — |
| C-41 | **Ownership and contact.** A named security and privacy owner, `privacy@` and `security@` addresses, and `/.well-known/security.txt`. | Now | `plans/m12-launch/README.md` | — |
| C-42 | **Workforce access.** Production access list, least privilege, onboarding and offboarding checklist, confidentiality clause for contractors and contributors with any data access (contributors normally have none). | M12 | `plans/m12-launch/README.md` | — |
| C-43 | **Claims review.** Marketing, store and onboarding copy reviewed for privacy claims (each must map to a control) and health claims (general wellness). The phrases "HIPAA compliant", "HIPAA certified" and "medical" are banned. | M12 | `plans/m12-launch/README.md` | — |
| C-45 | **Family mode data (§19).** One consent ledger with a subject (`subject_kind ∈ user\|child_profile`, `subject_id`) for per-child parental explicit consent. `child_rules` sealed with a per-child data key (wrapped like C-4), shredded when the profile is deleted. Child data appears in the parent's export and is deletable in two taps. No child id, nickname or rule ever enters an AI prompt (test). The on-device face check stores and sends nothing (pending counsel). Reserve the schema in M5, as the family-mode doc proposes; build it in M13. | M5 (reserve) / M13 | M5 plan; `plans/m13-family/README.md` | — |
| C-44 | **Region gating.** If the EU or UK isn't ready at launch, block signup by country (the self-declared profile country plus an IP check at signup) with a friendly waitlist. If it is ready, an Art. 27 representative, DPIA and transfer documentation are in place. | M12 | `plans/m12-launch/README.md` | — |
| C-46 | **Security headers from the server or host** (renumbered from a second C-45 in the M5 final review, m13). CSP with `frame-ancestors 'none'`, HSTS, `X-Content-Type-Options` and `Referrer-Policy`, set by the API's host or reverse proxy: the game's meta CSP can't carry `frame-ancestors`. | M12 (deploy) | `plans/m12-launch/README.md` | — |
| C-47 | **Backup restore replays account deletes** (renumbered from a second C-43, M5 final review m13). A restore replays the `account.delete` audit events after the backup's time, so a deleted user's wrapped data key (and with it their sealed data) is never resurrected. | M2 Step 7 (the event) / M12 (restore runbook) | `plans/m12-launch/README.md` | — |
| C-48 | **GlitchTip SDK with scrubbing** (renumbered from a second C-44, M5 final review m13). The error tracker is added with a `before_send` hook that scrubs request bodies, query strings, cookies and headers, completing C-9. | M12 | `plans/m12-launch/README.md` | — |

### 6.1 What M2 needs, in order

Do these as part of the M2 plan before Step 5 stores the first rule:

1. **Step 2c (new):**
   - C-1 consent ledger
   - C-2 key ring and rekey
   - C-3 AAD binding
   - C-4 per-user keys (strongly recommended)
   - C-5 audit log
   - C-6 retention job
   - C-9 log redaction
2. **README Global Constraints:**
   - consent required for health writes (C-1/C-11)
   - key ring (C-2)
   - org/health separation (C-10)
   - add `consent_required` to the error codes
3. **Step 3:** audit sign-in events (C-5); optionally session hygiene (C-10b).
4. **Step 4:** if `accessibility_voice` is added, treat it as sensitive (C-19).
5. **Step 5:** consent gate (C-11); search-query redaction test (C-9); seal with AAD and user key (C-3/C-4).
6. **Step 7:** export consents, processors and audit events (C-7); delete login tokens and user keys and pseudonymize the audit log (C-8).
7. **Step 8:** consent and free-forever e2e test (C-11).
8. **Docs:** start `docs/compliance/processors.json` and the data inventory (C-33).

---

## 7. What HIPAA would add on top (track (b) only)

If (b) is ever opened, these items join the list. They are not needed for (a).
- BAAs with the customer and every downstream vendor
- Documented Security Rule risk analysis and policies, retained 6 years
- Workforce HIPAA training records and sanctions
- Accounting of disclosures
- Breach notice to the CE, plus HHS through the CE
- A minimum-necessary policy for clinician views
- Short idle logoff
- Emergency access procedure
- Annual evaluation
- A separate tenant and deployment with BAA-covered hosting and AI

---

## 8. Product rules to add to the spec

I suggest putting these in spec §9 (data and privacy) as a numbered "Privacy rules" list, binding on every milestone like §16's "Never rules". Not added here, because this task doesn't modify the spec.

- **P-1 No PHI, no acting for covered entities.** Kitchen Quest never accepts protected health information from a HIPAA covered entity or its business associate, never imports patient rosters or clinical records, and never operates the app on a covered entity's behalf, except inside a separately approved and separately deployed HIPAA track.
- **P-2 Seat licences carry no data.** Organizations get anonymous seat codes and see only seat activation counts. Players sign up themselves. No endpoint joins organizations to health data (business doc §D.8).
- **P-3 Health data goes to the AI only with opt-in, and minimized.** It is never sent without the player's `ai_health` consent; then only the fields the task needs, without identifiers, and only to providers pinned to no-retention and no-training. Without consent, the AI works blind and the deterministic rules engine filters its output.
- **P-4 Consent is separate.** Collecting health data needs a separate, tap-confirmed consent that is never bundled with the terms. Withdrawing it is as easy as giving it. Declining never blocks play.
- **P-5 Health data never leaves through a side channel.** No health data in URLs, logs, error reports, analytics, emails, push notifications or support tickets.
- **P-6 No geofencing and no precise location.** Location is never collected beyond country, plus a coarse grid cell the player chooses for Neighborhood Pantry. Notifications are never triggered by location. Health-care facilities are never map anchors.
- **P-7 No biometrics.** Voice audio is processed in memory and never stored. No voiceprints, speaker identification or face analysis, ever.
- **P-8 Sharing with clinicians is player-initiated only.** Through an expiring, revocable link or a downloaded report. There are no clinician accounts and no write-back.
- **P-9 No children's data until the design is approved.** Accounts are 16+. Children take part only as parent-managed child profiles (§19), built in M13 after counsel signs off on the family-mode questions. Children never talk to the AI, and no child data enters a prompt.
- **P-10 Never sold, never repurposed.** No sale, licensing or "anonymized/aggregate" sharing of health data. Research use only with separate, specific opt-in consent.
- **P-11 Every processor is reviewed first.** No vendor receives user data without a signed DPA and a recorded review of retention, training use, region and sub-processors.
- **P-12 Accurate claims.** Never claim "HIPAA compliant" or similar. Every privacy claim maps to a tested control. Journeys stay general wellness.
- **P-13 Region gating.** EU and UK signups open only after the GDPR package (DPIA, Art. 27 representative, transfer mechanism) is complete.
- **P-14 Deletion is total.** Deleting an account removes the player's data from the database, object storage and processors, and makes it unreadable in backups through per-user keys.

---

## 9. Launch blockers and lawyer list

### 9.1 Top launch blockers

1. **Consent and the consumer health data privacy policy** (C-1, C-11, C-17, C-30): MHMDA, NV, CT and GDPR Art. 9. Without these, every WA user's data is a private-right-of-action exposure.
2. **The AI data path** (C-13, C-14, C-15, C-34): either a reviewed OpenRouter setup pinned to no-retention and no-training with a DPA, or health data withheld from the AI. A provider logging prompts is an HBNR "breach" and a §5 problem.
3. **Breach readiness** (C-5, C-9, C-32): access logging, log redaction, and an incident runbook with the HBNR 60-day and GDPR 72-hour clocks, tested with a tabletop exercise.
4. **Key management and complete deletion** (C-2, C-3, C-4, C-8, C-35): rotation without data loss, ciphertext bound to its owner, crypto-shred for backups, deletion that reaches processors.
5. **Age, children and region posture** (C-39, C-44, P-9, P-13): a lawyer's read on child-directedness and the age screen, family mode (§19) gated to M13, and the EU and UK either geo-blocked or fully papered.

### 9.2 What a lawyer must confirm

Bring this document, the spec, the onboarding and journey copy, and business doc §D.8.

1. **HIPAA:** confirm Kitchen Quest is not a CE or BA under (a). Review the seat-licence contract template and the screening questions (H-1), especially for FQHC, hospital, WIC or Medicaid-funded customers. Structure track (b) if it is ever opened.
2. **FTC HBNR:** does Kitchen Quest meet the PHR "multiple sources" test? What counts as "unsecured"? Notice templates.
3. **WA MHMDA, NV SB 370, CT:** how far the "necessary to provide the requested service" exception reaches; consent wording and UX (tap versus voice); the consumer health data privacy policy text; deletion from backups; private-right-of-action exposure; whether audit-log retention survives deletion.
4. **California CMIA §56.06:** do diet journeys with symptom check-ins make Kitchen Quest a "provider of health care" under CMIA? Also: CCPA threshold monitoring and the CPPA risk-assessment regulations.
5. **Other states:** Maryland's "strictly necessary" standard; New York HIPA status; minors' provisions for 16–17-year-olds (CT, CO, MD); state breach-notification mapping for email-plus-health data.
6. **GDPR and UK GDPR:** launch-region decision; explicit consent wording (including **religious diet rules as Art. 9 data**); DPIA; Art. 27 representative; transfers to OpenRouter and upstream model providers; EU AI Act Art. 50 disclosure.
7. **COPPA and children:** child-directed analysis of the 8-bit art, characters and comedy; neutral age screen; the 11 family-mode questions in `docs/business/2026-11-09-family-mode.md` §B.7. From the health side, add: is a parent's consent per child enough for MHMDA and GDPR Art. 9, and does the UK Children's Code apply to v1's 16–17-year-olds?
8. **Vendor contracts:** OpenRouter terms, any DPA, ZDR commitments and provider routing; Hetzner DPA; mail provider; GlitchTip (if SaaS); Merchant of Record.
9. **Claims:** privacy and security marketing claims (FTC §5); FDA general-wellness framing for low-FODMAP journeys; AI-chatbot disclosure laws (California SB 243, Utah) **[unsure if applicable]**.
10. **Neighborhood Pantry:** liability for person-to-person food sharing per launch region; location and geofencing review.
11. **Insurance:** cyber and E&O cover that includes privacy regulatory defence.

The business doc budgets about $8–15k for a launch legal pack and a 1–2 hour consult. Given items 3, 4 and 7, plan for the larger end of that range.

---

*Sources consulted: the files listed under Inputs. External legal references are cited from memory and marked [verify] where precision matters. Checklist content is paraphrased from the founder's copy of a CC BY-SA 4.0 document.*
