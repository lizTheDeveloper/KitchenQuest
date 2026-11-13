# Feature-to-Value-Chain Report: Kitchen Quest Monetization

**Date:** 2026-11-09
**Prepared for:** Liz Howard, Founder and CEO, Multiverse Games / The Multiverse School
**Feature under analysis:** the whole product and, specifically, its **monetization model**
**Inputs read:** design spec (`docs/superpowers/specs/2026-11-09-kitchenquest-design.md`), `prototype/BRIEF.md` and the three prototype pages, `content/README.md`, `docs/style/voice.md`, `recipes/CONTRIBUTING.md`, `plans/m1-core/README.md`, `plans/m2-api/README.md` and its step files.
**Status:** analysis and recommendation. Nothing here is decided until Liz decides it.

> **How to read the numbers.** The cost figures come from the stated OpenRouter prices ($0.40 per million input tokens, $3.00 per million output) and from explicit assumptions about usage. Every market figure (competitor prices, conversion rates, hosting and legal costs) is an **estimate** unless a source is named. Competitor prices change often and differ by region and promotion, so check them before you quote them.

---

## TL;DR

- **Recommended model: "Apprentice free, Guild by sliding scale, and the School as the engine."**
  - A generous free tier keeps safety, the open canon, logging, the full weekly loop, and at least one free path to every technique.
  - The paid tier is a **Pantry Guild membership** at three prices the player chooses: **$3, $6 or $12 a month**, or **$24, $48 or $96 a year**. A **Household** plan costs **$10 a month or $80 a year**.
  - A no-questions **Bureau Bursary** gives free Guild membership to anyone who asks, paid for by Patron-tier members.
  - Revenue also comes from **Multiverse School cooking cohorts** at **$99–$249 on a sliding scale**, and later from **community and education seat licenses**.
  - **15% of net membership revenue** goes to the contributors from each cuisine.
- **Unit economics** (baseline assumptions, §5 and Appendix C):
  - A paying member brings in about **$4.02 net a month** and costs about **$0.88 in variable costs**. After the revenue share and bursaries, the **contribution margin is about $2.45 (61%)**.
  - **The free tier decides break-even.** At $0.10 a month per free player and 5% conversion, covering about $3k a month of fixed operating costs takes **about 110k monthly active users**. If design holds free-tier AI to $0.05, it takes **about 40k MAU (about 2,000 paying)**.
  - Funding a small studio (about $18k a month) from subscriptions alone takes **about 240k MAU**. Adding **three School cohorts a month and about 1,500 licensed seats** gets there at **about 80k MAU**.
- **Subscriptions alone won't make development sustainable at indie scale.** The School tie-in is the strongest lever and the best fit with your values, so treat it as a primary revenue line, not an add-on.
- **Do not build:** affiliate links, ads, brand sponsorship, paid currency, loot boxes, or B2B data sharing with insurers or employers. Each one either breaks spec §9 or turns black-hat Octalysis drives into revenue.
- **Change the plans now:**
  - an `entitlements` table, plus a test that free-forever routes never check entitlements (M2 Step 2 and Step 8)
  - a `usage_events` cost meter (M2 Step 2 schema; M3 writes it)
  - stable contributor IDs and a contribution ledger in canon sync (M2 Step 6 and `recipes/CONTRIBUTING.md`)
  - **a license decision for `content/` and the art**, which today is unlicensed. That gap blocks any paid "pack".

---

# Feature-to-Value-Chain Report

## 1. Feature Overview

### Summary

Kitchen Quest is an 8-bit cooking RPG and food tracker, shipped as a PWA. It is set on the real Earth, and it teaches people to cook real dishes, shop for them, and feed themselves **regularly, enough, and in balance**. The "feature" under analysis is how it earns money. The model has to:

1. pay for real per-player costs: LLM calls, self-hosted voice, hosting, photos
2. pay the community contributors and reviewers whose cuisines make up the content (spec §10–11)
3. fund continued development
4. avoid extraction: no dark patterns, no selling data, no paywall on safety, no punishing poorer players
5. use Octalysis drives to push one clear behaviour: **adding one more technique to the player's toolkit**

Today the spec says "No monetization in v1. Architecture does not preclude a later subscription" (§1.2), and Q3 in §15 is still open. **This report's central finding is that the architecture, as currently planned, *does* get in the way of a later subscription in several small ways (§D).** All of them are cheap to fix now and expensive to fix later.

### Jobs To Be Done (Christensen)

| Who | Job ("When I…, I want to…, so I can…") | What they'd pay for |
|---|---|---|
| Nervous beginner cook | When I'm standing in my kitchen with ingredients, I want a patient expert talking me through it, so I can make a real meal without wasting food or feeling stupid | Hands-free voice in cook mode; more cuisines |
| Person with allergies, intolerances or a diet journey (low-FODMAP) | When I cook, I want certainty that a dish fits my body's rules, so I can eat varied food without fear | **Nothing: this job must be free** (it's safety). They may pay *out of gratitude* or for convenience |
| Under-eater, busy or low-energy person | When I forget to eat, I want something kind to remind me and make eating easy, so I can stay nourished | Nothing for the core. Voice and household features are optional extras |
| Curious "culinary tourist" or hobbyist | When I'm bored of my 6 dishes, I want to learn a new cuisine respectfully, from the people it belongs to, so I can grow and feel connected | **Cuisine packs, cohorts, cosmetics: the main willingness to pay** |
| Learner wanting credentials (Multiverse School audience) | When I want to prove or level up my skills, I want structured teaching and a recognised outcome, so I can feel accomplished or get work | **Cohort courses and certificates: high willingness to pay** |
| Clinician, dietitian, community org, school | When I support people learning to eat well, I want a tool they'll actually use, so my program works | Seat licenses (no data access) |

**Core job for monetization:** *"Help me become someone who can cook, one technique at a time, without making me feel watched, unsafe, or poor."* Revenue should grow with **techniques learned**, not with time spent, anxiety, or data harvested.

### Kano Categorization (applied to monetization elements)

| Element | Kano category | Implication |
|---|---|---|
| Allergy and diet checks, read-backs, disclaimers | **Basic (must-be)** | Paywalling it causes outrage and harm. Free forever |
| Meal logging, reminders, export and delete | **Basic** | Free forever |
| Open canon recipes plus cook mode | **Basic** (given the CC BY-SA promise) | Free forever |
| AI mentor (text) | **Performance** | Free with a fair cap; paid lifts the cap |
| Live voice, hands-free cook mode | **Performance → Delighter** | Main premium driver. **But** voice is also an *accessibility* need: exempt it (§B) |
| New cuisine packs (cooks, quests, voiced characters) | **Delighter** | Good paid content; must not be the *only* path to a technique |
| Cosmetics (pan hats, kitchen decor) | **Indifferent → Delighter** | Small revenue; Ownership drive |
| Certificates and cohorts | **Delighter** for most; **Performance** for career learners | High willingness to pay; separate product |
| "No ads, no data selling" | **Basic** for this audience (health data) | Advertise it as a trust signal |

**Kano rule for this product:** *monetize only Performance and Delighter attributes, never Basic ones.* Any "Basic" behind a paywall reads as extortion.

---

## 2. Context Mapping

### Business Model Impact (Business Model Canvas, Osterwalder)

| Block | Today (spec) | With the recommended model |
|---|---|---|
| **Customer segments** | Public players 16+ | (1) free players; (2) Guild members; (3) School learners; (4) org licensees (community kitchens, schools, food banks, dietitians); (5) philanthropic funders |
| **Value propositions** | Learn to cook, eat enough, safely, with comedy and respect | Same, plus: "**Your money pays the cooks whose food you learn**" (rev share), "**nothing that keeps you safe is ever for sale**", "pay what you can" |
| **Channels** | PWA, Multiverse Games community | PWA (no app-store 15–30% cut; a strategic advantage, so keep it), Multiverse School list, open-canon contributors as ambassadors, community orgs |
| **Customer relationships** | The Pan (automated, personal) | Plus transparent "Bureau Ledger" annual report: where the money went (contributors, servers, team) |
| **Revenue streams** | None (v1) | Membership (sliding scale), Household, School cohorts, org seat licenses, grants. Later: cuisine packs à la carte, cosmetics |
| **Key resources** | Rules engine, ingredient graph, open canon, writing/voice, PixelLab pipeline | Plus: contributor network (the real moat), entitlements and metering, payments provider |
| **Key activities** | Building core, API, mentor, content | Plus: content commissioning cadence, cohort teaching, contributor payouts, cost control |
| **Key partners** | OpenRouter/Qwen, Hetzner, PixelLab, cuisine contributors | Plus: Merchant of Record (payments and VAT), health-privacy counsel, community orgs, foundations |
| **Cost structure** | Not modelled | §5 and Appendix C: variable AI and voice, fixed infra, content, legal |

### Lean Canvas view (startup lens)

- **Problem:** cooking apps teach recipes, not skills. Trackers shame people. Allergy-safe cooking is scary. Learning other cuisines often happens extractively.
- **Unfair advantage:** an open, community-reviewed canon with **paid** contributors; a deterministic safety engine; a distinctive comic voice; the Multiverse School pipeline. None is unique alone. **Together they're rare.**
- **Key metric (North Star): *techniques added per active cook per month*.** An active cook cooked at least one dish this month. A technique is added when the player first cooks a dish tagged with a skill they hadn't cooked before.
- **Unit-economics metric:** contribution margin per *active cook*, not per MAU.

### Ecosystem Dependencies (critical → minor)

| Dependency | Criticality | Risk to monetization |
|---|---|---|
| OpenRouter + `qwen/qwen3.8-27b` pricing and availability | **Critical** | Margin swings directly with token prices. The model is set by config (good), but there's no cost metering yet |
| Self-hosted Whisper and TTS on Hetzner (GPU) | **Critical** for the premium tier | Fixed GPU floor before revenue. Latency target unproven |
| Cuisine contributors and reviewers | **Critical** | No contributors → no content → nothing to sell. They also need a fair, trackable share |
| Payment provider / Merchant of Record | **High** | VAT and sales tax, auto-renewal law, chargebacks. A PWA avoids app-store fees but needs web checkout |
| Multiverse School (cohorts, brand) | **High** (positive) | Strongest revenue lever. Needs instructors and a verifiable assessment |
| PixelLab | Moderate | Credits are a small fixed cost. Art license terms matter if art is sold as cosmetics |
| Legal (health data, consumer subscription law) | **High** | One-time review before any paid launch |
| Web Push and iOS PWA limits | Moderate | Retention, and therefore conversion, depends on reminders working |

---

## 3. Value Chain Mapping (Porter)

### Primary Activity Impact

| Primary activity | What monetization changes | Impact |
|---|---|---|
| **Inbound logistics** (content and data in: recipes, ingredient graph, contributors, art) | Paid commissioning plus a revenue-share ledger turns contributors from volunteers into **paid suppliers**. Needs contributor IDs per canon file (today `credit:` is free text) | **Critical** |
| **Operations** (running the game: AI mentor, voice, rules engine, hosting) | Every AI and voice call becomes a metered cost centre. Free-tier caps and premium voice need entitlement checks at the API edge, and **must never touch safety paths** | **Critical** |
| **Outbound logistics** (delivering the experience: PWA, offline, export) | Free export stays free. Packs are delivered as content entitlements. The PWA avoids app-store take rates | Moderate |
| **Marketing and sales** | The mission is the marketing: "pay what you can," "contributors are paid," "no ads ever." School cohorts are a sales channel *into* the Guild (cohort includes 12 months of Guild) | **Critical** |
| **Service** | Cancellation in two taps, refunds, bursary requests without questions, accessibility exemption, transparent annual ledger | Moderate (trust-critical) |

### Support Activity Impact

| Support activity | Impact |
|---|---|
| **Firm infrastructure** | Payments (MoR), finance (revenue share payouts, 1099/international contractor payments), legal (health data, subscriptions, health-claims review). Multiverse Games needs an owner for "revenue ops." **Critical** |
| **HR / people** | Paid contributors and reviewers per cuisine; cohort instructors from The Multiverse School; a community lead. Moderate |
| **Technology development** | Entitlements, metering, contribution ledger, payments webhooks, privacy-preserving analytics (no third-party trackers per §9). **Critical, and cheapest if done now** |
| **Procurement** | OpenRouter (consider caching and committed spend), Hetzner GPU, PixelLab, MoR, insurance. Moderate |

### Wardley Map Positioning

| Component | Evolution stage | Strategy |
|---|---|---|
| LLM inference (OpenRouter/Qwen) | **Utility** | Buy. Stay swappable. Meter it. Never differentiate on it |
| STT/TTS (Whisper, open TTS) | **Product → commodity** | Self-host now for privacy and cost. Re-evaluate yearly. Keep a CPU fallback |
| Payments, VAT, hosting | **Utility** | Buy (MoR, Hetzner) |
| Rules engine plus ingredient graph | **Custom-built → product** | **Differentiator. Free to users, but it's the trust moat.** Could later be licensed B2B *as software, without user data* |
| Open canon (CC BY-SA) | **Commons** | Free by design. The moat is the *community that keeps it reviewed*, not the files |
| Game layer: quests, cooks, writing, voice, art | **Custom** | This is what's sellable (packs, cosmetics), **if** it isn't CC-licensed (§D change 4) |
| Cohort teaching, certification | **Genesis → custom** (for this product) | The highest-margin, most defensible revenue. Experiment early |

---

## 4. Strategic Analysis

### VRIO Analysis (of the product plus the recommended model)

| Resource or capability | Valuable | Rare | Inimitable | Organized | Result |
|---|---|---|---|---|---|
| Deterministic allergy and diet engine | ✔ | ✔ (few cooking games have one) | ◐ (code can be copied; tested data and fixtures take time) | ✔ (M1 done) | Temporary advantage |
| Open, community-reviewed canon | ✔ | ✔ | ✘ by design (CC BY-SA) | ◐ | **Parity on content; advantage on *relationships*** |
| Paid contributor network and revenue share | ✔ | ✔ | ✔ (trust and relationships are slow to copy) | ✘ (no ledger, no IDs, no payout process) | **Unrealized sustained advantage. Organize it** |
| Comic voice, writing, characters | ✔ | ✔ | ✔ (style, authorship) | ✔ (voice guide, content files) | Sustained advantage, **if the content license protects it** |
| Multiverse School channel | ✔ | ✔ | ✔ | ✘ (no course designed) | **Unrealized sustained advantage** |
| Monetization infrastructure (entitlements, metering) | ✔ | ✘ | ✘ | ✘ | Necessary parity. Currently missing |

**Synthesis:** the defensible assets are **people and voice** (contributors, School, writing), not code or recipes. The model should charge for *access to people and craft* (cohorts, new cuisines taught by credited communities, voiced mentorship) and give away *information and safety*.

### SWOT Analysis

| | Helpful | Harmful |
|---|---|---|
| **Internal** | **S1** Safety-first, trustworthy design (no ads, encrypted health data). **S2** PWA: no 15–30% app-store tax. **S3** Distinctive voice and comedy. **S4** Open canon attracts contributors and press. **S5** Scripted-first content keeps AI costs low (content/README §"scripted first"). **S6** School brand and audience | **W1** No entitlements, metering, payments or analytics yet. **W2** Variable AI and voice cost on *free* players, with a primary interface (the mentor) that is AI by default. **W3** Content licensing for `content/` and art is undefined. **W4** Small launch content (9 dishes): thin for a paid tier at launch. **W5** Photos unverified: certificates can't come from in-app play alone |
| **External** | **O1** Demand for "learn real skills" and anti-diet-culture products (estimate: a growing segment, not quantified here). **O2** Community orgs, food-security and newcomer programs need cooking education (grant-fundable). **O3** Open-weight STT/TTS keep getting cheaper. **O4** Dietitians want adherence tools for elimination diets | **T1** LLM price and availability changes. **T2** Health-data regulation (GDPR Art. 9, WA My Health My Data, FTC Health Breach Notification Rule). **T3** "Free AI cooking assistant" competitors (big platforms bundling AI). **T4** Contributor and cultural backlash if packs feel like *selling culture*. **T5** Subscription fatigue |

**Strategic synthesis (TOWS):**
- **S1+S4 → O2:** pitch funders and orgs on safety plus respect. Seat licenses carry no data back.
- **W2 → T1:** meter and cap now.
- **W3 → T4:** decide licensing and rev share *before* the first paid pack.
- **S6 → W5:** the School supplies the verified assessment the app deliberately lacks.

### PESTEL Analysis

| Force | Key factors | Rating |
|---|---|---|
| **Political** | Public-health and food-security funding priorities shift with administrations (grant revenue is volatile). Cultural-appropriation discourse: commercialising other people's food is politically sensitive, which makes revenue share *protective* | Moderate |
| **Economic** | Cost-of-living pressure → sliding scale widens reach. Subscription fatigue → annual plans and households help. LLM token prices trend down long-term (estimate) but can spike per model. FX for international contributor payouts | **High** |
| **Social** | Disordered-eating risk: any monetized "progress" or streak mechanic can harm (spec §5). Trust deficit with health apps that sell data. Strong appetite for community credit and decolonial framing | **High** |
| **Technological** | Open STT/TTS maturity; iOS PWA push limits; OpenRouter free variants have shared rate limits and **may have different data-logging policies, so they're unsuitable for health-adjacent prompts** without checking each provider's policy | Moderate |
| **Environmental** | GPU energy use (minor). Food waste reduction ("use-it-up" recipes) is a positive story for funders | Minor |
| **Legal** | **Health data:** allergies, symptoms and diet journeys are special-category data under GDPR Art. 9 (explicit consent, DPIA); "consumer health data" under Washington's My Health My Data Act (consent, private right of action); FTC Health Breach Notification Rule for non-HIPAA health apps. **HIPAA** applies if a covered entity (clinic, insurer) deploys the app for patients and shares data, which needs a BAA. **FDA / EU MDR:** low-FODMAP "journeys" must stay within *general wellness* framing. Claims like "manages IBS" or "treats" risk device classification. **Consumer subscription law:** state auto-renewal laws (e.g. California), EU consumer rights (withdrawal, clear cancellation). Easy online cancel is required regardless of the federal "click-to-cancel" rule's status. **FTC endorsement rules** if any affiliate or sponsorship. **Minors 16–17** can't always enter binding contracts: consider 18+ for paid plans, or parental purchase. **CC BY-SA share-alike:** anything licensed BY-SA can't be made exclusive | **Critical** |

**PESTEL conclusion:** the legal column eliminates insurer and employer data deals. It also turns the B2B-clinical option into a regulated product. That's possible later, but not cheap.

### BCG Matrix (among revenue streams, projected 24 months)

| Stream | Market growth | Relative share/fit | Placement |
|---|---|---|---|
| Guild membership (sliding scale) | High | Medium | **Star** (build) |
| School cohorts and certificates | High | High (own channel) | **Star → future Cash Cow** |
| Community/education seat licenses | Medium | Medium | **Question Mark** (pilot one) |
| Cuisine packs à la carte | Medium | Low (until the content library grows) | **Question Mark** (later) |
| Clinician licensing (B2B2C health) | High | Low, high regulatory cost | **Question Mark** (defer to year 2+) |
| Cosmetics | Low | Low | Small **Question Mark / Dog**, fine as a sideline |
| Donations / Patreon / Open Collective | Low | Medium | **Dog** standalone, so fold it into the Patron tier |
| Affiliate, ads, brand sponsorship | n/a | Negative fit | **Dog: do not enter** |

---

## 5. Prioritization

### Impact/Effort Matrix Placement

| | Low effort | High effort |
|---|---|---|
| **High impact** | Entitlements and metering schema now (M2); pricing fake-door test; School cohort pilot (uses existing School ops); license decision for `content/` | Live voice premium (M7); Guild launch with payments (M11); contributor rev-share payouts |
| **Low impact** | Patron tier and bursary copy; cosmetics shop | Clinician B2B product; à la carte pack store; native app wrappers |

### Cost-Benefit Summary

#### A. Per-player monthly cost model (variable)

**Token assumptions per call** (estimates; measure in M3, see Appendix A test 3):

| Call | Input tokens | Output tokens | Cost |
|---|---|---|---|
| Mentor text turn (persona, style summary, tool schemas, player context, short history) | 2,500 | 150 | **$0.00145** |
| Voice-mode turn (longer history, short spoken replies) | 3,000 | 120 | **$0.00156** |
| Photo reaction (image ≈1k tokens + prompt) | 2,000 | 120 | **$0.00116** |
| Recipe import (page text in, Cooklang JSON out) | 5,000 | 1,500 | **$0.0065** |

**Voice compute assumption** (estimates):
- A Hetzner GPU box costs about **$200 a month** (a GEX44-class dedicated server; check current pricing).
- Faster-Whisper turbo runs at about 40× realtime and a fast open TTS (e.g. Kokoro-class) at about 50×. That makes about **350 GPU-seconds per heavy voice user per month**.
- Half the load falls in a three-hour evening peak, with GPUs kept at 50% utilisation for latency. On that basis one box serves about **900 heavy voice users**, so the marginal cost is about **$0.25–0.50 per heavy user**. This analysis uses $0.40.
- There is also a **fixed floor of about $400 a month** for two boxes, for redundancy.

**Infra variable** (Postgres, app CPU, photo storage at 8 photos × ~300 KB a month after EXIF strip and resize, egress): **$0.03–0.15 per user**. Photo storage is negligible at Hetzner Object Storage pricing (estimate: about €6 a month base for 1 TB).

| Persona | Usage per month | LLM | Voice GPU | Infra | **Total** |
|---|---|---|---|---|---|
| **Free, typical MAU** | 30 mentor turns, 3 photos, 0.5 imports, a little voice | $0.05 | $0.02 | $0.03 | **≈ $0.10** |
| **Text-only engaged** (free or paid) | 150 turns, 8 photos, 3 imports | $0.25 | $0 | $0.05 | **≈ $0.30** |
| **Heavy voice** (hands-free cook mode about 2× a week) | 50 text plus 550 voice turns, 12 photos, 4 imports; ≈90 min of speech in, ≈180 min of Pan audio out | $0.97 | $0.40 | $0.10 | **≈ $1.47** |
| **Extreme voice** (daily, long sessions) | 100 text plus 1,400 voice turns, 25 photos, 8 imports | $2.41 | $1.00 | $0.15 | **≈ $3.56** |

**Takeaways:**
- **AI cost is low per paying user but large across the free population.** The free tier, not the premium tier, decides break-even.
- Output tokens are 7.5× pricier than input, so keep spoken replies short. The voice guide's "short" rule already does this.
- **Prompt caching** (if OpenRouter's Qwen providers support it; unverified) and **scripted-first** responses (content/README) are the two biggest cost levers.
- **Don't route free users to the free Qwen variant.** Its shared rate limits make it unreliable at scale, and its providers' logging policies may be unsuitable for health-adjacent text.

#### B. Fixed costs (monthly estimates)

| Item | Ops floor | Notes |
|---|---|---|
| Hetzner app, Postgres, backups, staging | $250 | Self-managed Postgres. Scales in steps |
| Voice GPU (2 boxes) | $400 | Launch with 1 GPU plus a CPU fallback ($200) if needed |
| Object storage, email, monitoring (self-hosted GlitchTip) | $60 | |
| PixelLab credits | $50 | Estimate. Check the current plan |
| Content commissioning: 2 new dishes a month × ~$750 | $1,500 | ~$400 contributor + $200 reviewer + $150 voice, art and QA per dish (estimates; set real rates with contributors) |
| Legal, compliance and insurance (amortized) | $700 | Launch legal pack ~$8–15k (privacy policy, terms, DPIA, health-claims review, subscription compliance) over 24 months, plus cyber/E&O insurance. Estimate |
| **Ops fixed total** | **≈ $3,000** | Excludes salaries |
| Small team (e.g. 1 FTE engineer + 0.5 FTE content/community) | +$15,000 | Highly location-dependent. Estimate |
| **Sustainable-studio total** | **≈ $18,000** | |

**One-time launch costs** (estimate): 9 launch dishes × $750 ≈ $6.8k, plus a legal pack of about $10k, plus art and voice direction. **That's roughly $20k before the first dollar.**

#### C. Revenue per paying member (baseline hypothesis)

- **Mix:** 40% Seedling ($3), 45% Standard ($6), 15% Patron ($12). 60% pay annually at about 33% off ($24, $48 or $96).
- **Gross ARPPU:** $4.56 a month.
- **Fees:** Merchant-of-Record fees of about 5% + $0.50 per transaction (estimate; it handles VAT and sales tax) bring net to $4.11. Refunds and chargebacks of 2% bring it to **$4.02**.
- **Variable cost:** a 50/50 text/heavy-voice paid mix costs **$0.88**.
- **Contributor revenue share:** 15% of net, **$0.60**.
- **Bureau Bursary:** 1 free Guild seat per 10 paid, **$0.09**.
- **Contribution margin: $2.45 per paying member per month (61% of net).**

#### D. Break-even (paid members and MAU needed)

Each paying member's margin must also cover the free players behind them. "Per paid after free" below is the margin left once each paying member also covers their share of free players' costs.

| Free cost per MAU | Conversion | Margin per paid after free | **Ops ($3k) break-even** | **Studio ($18k) break-even** |
|---|---|---|---|---|
| $0.10 (as designed today) | 3% | negative | never | never |
| $0.10 | 5% | $0.55 | 5,500 paid / **110k MAU** | 33k paid / 660k MAU |
| $0.10 | 8% | $1.30 | 2,300 paid / 29k MAU | 13.9k paid / 174k MAU |
| **$0.05 (capped, recommended)** | **5%** | **$1.50** | **2,000 paid / 40k MAU** | **12k paid / 240k MAU** |
| $0.05 | 8% | $1.87 | 1,600 paid / 20k MAU | 9.6k paid / 120k MAU |
| $0.03 | 5% | $1.88 | 1,600 paid / 32k MAU | 9.6k paid / 192k MAU |

Conversion benchmarks are **estimates**: typical consumer freemium apps convert low single-digit percentages of MAU. Best-in-class gamified learning apps report high single digits. Don't plan on more than 5% without evidence.

**Price sensitivity:** with Standard at $8 a month or $64 a year (tiers $4/$8/$15), net ARPPU rises to about $5.33 and the margin to about **$3.56, up 45%**. Test $6 against $8 (Appendix A).

**Blended studio scenario** (recommended model at about 80k MAU, 5% conversion, free tier capped at $0.05):

| Line | Assumption | Monthly contribution |
|---|---|---|
| Guild members | 4,000 paid | ≈ $6,000 |
| School cohorts | 3 a month × 20 learners × ~$180 net avg, minus ~$1,200 instructor | ≈ $6,700 |
| Community and education seat licenses | ~1,500 seats × $2.50, minus usage cost | ≈ $3,100 |
| Grants and Patron surplus | not counted | (upside) |
| **Total** | | **≈ $15,800** (≈88% of the $18k studio) |

**Conclusion:**
- **The subscription can pay its own costs and the contributors. The School and licenses pay for the studio.**
- One School cohort a month (about $2.2k contribution) covers most of the ops floor on its own, before the game has a single subscriber.

### RICE Scoring (monetization workstreams)

Reach is players or decision-makers affected per quarter (relative). Impact is 0.25–3. Confidence is %. Effort is person-weeks.

| Workstream | Reach | Impact | Conf. | Effort | **RICE** | Priority |
|---|---|---|---|---|---|---|
| Entitlements and free-forever invariant test (M2) | 10 | 2 | 90% | 1 | **18.0** | 1 |
| Usage metering schema (M2) plus writes in AiProvider (M3) | 10 | 2 | 90% | 1.5 | **12.0** | 2 |
| Pricing fake-door and Van Westendorp survey on prototypes | 5 | 2 | 80% | 1 | **8.0** | 3 |
| License decision for `content/` and art, plus contributor IDs in canon | 8 | 2 | 80% | 2 | **6.4** | 4 |
| School cohort pilot (one cohort, manual) | 3 | 3 | 60% | 3 | **1.8** | 5 |
| Guild launch with MoR checkout | 10 | 3 | 60% | 6 | **3.0** | 6 (after M7/M11) |
| Contributor rev-share payouts (quarterly, manual first) | 3 | 2 | 70% | 2 | **2.1** | 7 |
| Org seat-license pilot (one community org) | 2 | 2 | 50% | 3 | **0.7** | 8 |
| Clinician B2B product | 2 | 3 | 30% | 12 | **0.15** | defer |
| Affiliate / ads / sponsorship | n/a | negative | n/a | n/a | n/a | **reject** |

*(Prioritization takes RICE together with dependencies: the Guild launch scores higher than the cohort pilot, but it depends on M7 voice and M11 launch, so the pilot comes first.)*

---

## 6. Strategic Impact

### Balanced Scorecard Mapping

| Perspective | Objective | Measures (targets are hypotheses) |
|---|---|---|
| **Financial Impact** | Cover variable and contributor costs from day 1. Cover the ops floor by month 12. Cover the studio by month 24–36 through blended revenue | Contribution margin per paid ≥ $2.40. Free cost per MAU ≤ $0.05. Monthly fixed costs covered %. Share of revenue from School and licenses ≥ 40% |
| **Customer Impact** | Learn techniques, eat enough, feel safe, never feel squeezed | **North Star: techniques added per active cook per month (target ≥ 1).** Week-4 retention. % of free players who cook ≥ 1 dish a month. Refund rate < 3%. "Felt pressured to pay" survey item < 5%. Bursary seats granted |
| **Internal Process Impact** | Cheap, predictable cost to serve; fast, fair content pipeline | Cost per AI turn. Scripted-line hit rate (≥ 70% of mentor responses scripted). Voice p95 latency < 1.5 s. Dish commissioning cost and review turnaround. Rev-share paid on time |
| **Learning and Growth Impact** | Contributor network, School curriculum, monetization capability | Paid contributors per cuisine (≥ 1 author + 1 reviewer). Cuisines live. Instructors trained. Experiments run per quarter (Appendix A) |

### Critical Value Drivers (ranked)

1. **Free-tier cost discipline (critical).** Scripted-first, capped AI, short outputs, caching. This decides whether the free tier is a funnel or a drain.
2. **The School tie-in (critical).** Highest margin, already your channel, and it supplies the verified assessment the game deliberately doesn't do.
3. **Contributor revenue share as brand (critical).** It turns "selling other cultures' food" into "paying the people who teach it," protects against T4, and is genuinely rare.
4. **Voice as the premium experience (moderate).** It's the most valuable paid feature, but it carries a fixed GPU floor and an accessibility exemption.
5. **Sliding scale and bursary (moderate).** Little cost, large trust and reach. Patron tier funds it.

### Strategic Risks (ranked)

1. **Critical: free-tier AI cost outruns conversion.** The mentor is the primary interface and AI by default (spec principle 7). Mitigation: caps, scripted-first, metering from day 1.
2. **Critical: legal and health exposure from monetizing anything adjacent to health.** That includes B2B clinical, journeys marketed as treatment, and payment by 16–17-year-olds. Mitigation: general-wellness framing, legal review, 18+ (or guardian) for paid plans.
3. **Critical: content can't be sold because its license isn't defined.** If `content/` or the art is ever released as CC BY-SA like the recipes, packs can't be exclusive. Mitigation: decide now (§D).
4. **High: contributor and community backlash** if packs look like paywalled culture. Mitigation: recipes always free, transparent 15% share, contributors consulted on pack pricing.
5. **High: voice latency or quality misses its target,** and the premium tier loses its anchor. Mitigation: benchmark before committing GPU spend; a "Guild without voice" still offers packs, household and higher caps.
6. **Moderate: willingness to pay is lower than $6** for a game with only 9 dishes at launch. Mitigation: launch the Guild after content reaches about 20 dishes; run the founding pre-sale as a test.
7. **Moderate: Octalysis drift.** Future designers add streaks, timers or FOMO to lift conversion. Mitigation: the monetization charter below, enforced in review like the voice guide's hard rules.

---

# Recommendation Summary

- **Should this feature be prioritized?** **Yes. Prioritize the *plumbing* now and the *paywall* later.**
  - The data-model and metering changes are a week or two of work in M2 and M3. Without them, every later monetization step needs a migration of encrypted health data.
  - Don't launch payments until M7 (voice) and about 20 dishes exist.
  - **Do pilot a Multiverse School cohort now.** It needs no app changes and can fund content commissioning.
- **Suggested Next Steps:**
  1. Liz answers spec §15 Q3 with this model, or a variant of it.
  2. Make the M2 plan changes in §D (entitlements, usage meter, contributor ledger, export invariant) before M2 Step 2 is implemented. **M2 is still unchecked, so this is the cheapest moment.**
  3. Decide the license for `content/` and `prototype/art` (and future art) and record it in spec §10 and `content/README.md`.
  4. Run the four cheapest tests in Appendix A within 30 days: token measurement, fake-door pricing, contributor interviews, cohort waitlist.
  5. Book a 1–2 hour health-privacy and health-claims consult before any paid launch or B2B conversation.
  6. Adopt the **Monetization Charter** (§C) as a hard-rules document beside `docs/style/voice.md`.

---

# Beyond the template

## A. Business model options (scored)

**Scoring.** Each is scored 1–5 (5 = best) on:
- **Mission fit** (Social Justice, Community, Growth, Knowledge, Purpose, Independence)
- **Revenue potential** (24 months)
- **Margin**
- **Effort** (5 = easy)
- **Legal/PESTEL safety** (5 = safe)

**Extractiveness** runs 0–5 (0 = not extractive, 5 = scummy).

| # | Option | Mission | Revenue | Margin | Effort | Legal | **Extractive** | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | **Freemium subscription** (voice and AI premium) | 4 | 4 | 4 | 3 | 4 | **1**, if safety stays free and voice has an accessibility exemption; 3 if voice is paywalled for people who need it | **Core, modified** (as the Guild) |
| 2 | **One-time purchase** | 3 | 2 | 1 (ongoing AI and voice cost per player, forever) | 4 | 5 | 0 | **Only as a capped founding offer** (e.g. "Founding Apprentice": first year $36, price locked 3 years). No unlimited lifetime voice |
| 3 | **Pay-what-you-can / sliding scale** | 5 | 3 (average price drops) | 4 | 4 | 5 | **0** | **Yes: build it into the Guild** ($3/$6/$12 plus bursary) |
| 4 | **School tie-in** (cohorts, certificates) | 5 | 4 | 4 | 3 | 4 | 0–1 (fair if certificates are honestly assessed) | **Yes: primary second engine**. Certificates need a *live or recorded practical* assessed by an instructor, since in-app photos are deliberately unverified (§6) |
| 5 | **B2B2C: employers, insurers** | 2 | 4 | 4 | 1 | 1 | **4** (the value buyers want is the data; it breaks §9 "no selling or sharing") | **No.** Employer *seat licenses with zero data back* are acceptable (see 11) |
| 5b | **B2B2C: dietitians and clinics** (gut-health and allergy journeys) | 4 | 3 | 3 | 1 | 2 (HIPAA BAA if a covered entity deploys it; FDA general-wellness boundary; GDPR Art. 9) | 1, if patient-initiated sharing only | **Defer to year 2+.** Start with a free, user-generated "share with my dietitian" report, which is also research |
| 6 | **Cookware / grocery affiliate** | 1 | 2 | 5 | 4 | 3 (FTC disclosure) | **4**: it bends advice toward commission. Conflicts with the market's *cost-per-serving* teaching and with "no third-party trackers" | **No** |
| 7 | **Paid cuisine expansion packs** with contributor rev share | 4 | 3 (grows with content) | 4 | 3 | 4 | **1–2**: fine if the **recipe stays free in the open canon** and the pack sells the *apprenticeship* (quests, voiced cook, art, lessons); 4 if techniques can *only* be learned by paying | **Yes, inside the Guild first**; à la carte ($4–5 per pack) later for free players |
| 8 | **Sponsorship from food organizations** | 3 (foundations, food-security nonprofits, public-health grants) / 1 (food brands) | 2 | 5 | 3 | 4 / 2 | 0 (philanthropy) / **4** (brands) | **Grants and foundations: yes** (e.g. "Bursaries funded by…"). **Brands: no** |
| 9 | **Donations / Patreon / Open Collective** | 4 | 1 | 4 (Patreon fees ~8–12%, estimate) | 5 | 5 | 0 | **Fold into the Patron tier.** Use Open Collective only for the *open canon fund*, for transparency |
| 10 | **Cosmetic purchases** | 3 | 1–2 | 5 | 3 | 5 | 1 with direct prices; **5 with loot boxes, paid currency or limited-time FOMO** | **Small, later**: commissioned cosmetic sets with artist rev share, direct prices, always available. Most cosmetics stay earnable with Bureau Stamps |
| 11 | **Community and education seat licenses** (food banks, newcomer and refugee programs, schools and colleges, senior centres, employers *without data*) | 5 | 3 | 4 | 3 | 4 | 0, if the org gets only seat counts | **Yes: pilot one** at about $2–3 per seat a month (estimate). Often grant-funded. Pairs with the School |

**Octalysis read across the options:**
- Options 1, 3, 4, 7 and 11 monetize **white-hat** drives:
  - CD1 Epic Meaning (paying the cooks, funding bursaries)
  - CD2 Accomplishment (techniques, certificates)
  - CD3 Empowerment (voice-guided cooking, new cuisines)
  - CD4 Ownership (your kitchen, your recipe book)
  - CD5 Social Influence (cohorts, trust with cooks)
- Options 6, a branded 8, and loot-box versions of 10 lean on CD7 Unpredictability and CD6 Scarcity, and on outside commercial interests. That's the black-hat side Liz explicitly doesn't want.

## B. What must stay free forever

These are commitments, not features. Put them in the spec (§D change 1) and test them.

1. **Safety:**
   - allergy and diet rule creation, read-back and spell-back
   - every `check` result, cross-contact and label notes, the disclaimer
   - substitutions re-checked by the engine
   - the **AI rule-expansion proposal** too, because an unknown term like "carrageenan" or "alpha-gal" is a safety need
   - emergency and medical-deflection lines
2. **The open canon:** every canon recipe's text, its cook mode (timers, wake lock), nutrition, and credit. CC BY-SA requires the files to be free. The *cooking experience* of them should be free too.
3. **Core logging and the tracker:** one-tap logging, text logging via the Pan within the free cap, and **unlimited one-tap/form fallback**. "Enough" targets, the weekly view, the variety garden.
   - *Abuse limit (M4 ruling M-4):* the API stops a single account at 200 meal logs (and 200 rule loosenings) per rolling day, so a script can't flood the sealed health tables. This is an abuse ceiling, not an allowance: it is identical for every plan, far above human use, never sold, never raised for pay, and never blocks adding, removing or tightening a rule.
4. **Nourishment safeguards:** meal reminders, low-intake gentle check-ins, support links.
5. **Diet journeys** (low-FODMAP and custom), with symptom check-ins. They're health-adjacent: paywalling a gut-health tool for people in pain is extractive. Monetize clinician *tooling* later, not the patient's journey.
6. **Export and delete:** one-click, complete, any tier, including after a subscription lapses. **No hostage data.**
7. **The full weekly loop and progression:** plan → market run → cook → photo → reaction (scripted reactions always; AI reactions within the cap). XP, skill XP, trust and Bureau Stamps earn **at the same rate** for free and paid players. **No paid XP boosts.**
8. **At least one free path to every technique** (skill tag). Packs add *breadth* (more cuisines, more cooks), never the *only* door to a skill. This is what makes "one more technique" a mission, not a paywall.
9. **The market minigames** (shopping-skills trainer). They're cheap to serve and core to the mission.
10. **Offline mode** for recipes, cook mode and logging.
11. **Accessibility voice:** players who need voice (motor, vision, dyslexia and similar needs) can turn on an **accessibility setting** that makes voice unmetered and free. Self-declared, no proof required. Principle 7 says "Talk, don't type," so talking can't be a luxury for people who can't type.
   - *As built (M7 Step 4, compliance C-19, M7 README Ruling 6):* the setting is health data (it implies a disability), so it is the sealed `voice_settings` row, never a plain profile column and never an entitlement. Turning it on needs the `health_data` consent; a player who declines it has the free allowance (**[founder] / [lawyer]**: counsel may prefer "necessary for the service" as the basis). It is exported and deleted with the player's health data. The abuse ceiling (six hours of speech a day) still applies to everyone, and the accessibility copy says so. The free voice allowance is shown only as a state ("resting until <date>"), never a number or an upsell.
12. **No ads and no data selling, ever.** Not even "anonymized" or "aggregate" sale.
13. **Cancellation and refunds** in-app, in two taps, with no guilt copy. The voice guide's hard rule 7 ("Missed days cost nothing") extends to "leaving costs nothing."

## C. Recommended model and pricing

### The model: "Apprentice free · Guild by sliding scale · School as the engine"

| Offer | Price hypothesis | What it includes | Why |
|---|---|---|---|
| **Apprentice** (free) | $0 | Everything in §B. Mentor AI text up to **~15 free-form AI turns a day** (scripted lines unlimited). **60 minutes of voice a month**. 3 AI recipe imports a month. AI photo reactions on cooked dishes | Funnel and mission. Cost target ≤ $0.05 per MAU |
| **Pantry Guild** (sliding scale, *same features at every price*) | **Seedling $3/mo ($24/yr) · Standard $6/mo ($48/yr) · Patron $12/mo ($96/yr)** | Fair-use unlimited **live voice and hands-free cook mode**. Higher AI caps (~100 turns a day). Unlimited imports. **All cuisine packs**. Seasonal Guild cosmetics. Name in the Bureau Ledger (opt-in). Patron funds bursaries | Performance and Delighter features with real costs. Sliding scale fits Social Justice. Same features keep it genuine |
| **Household Guild** | **$10/mo ($80/yr)**, up to 4 accounts | Shared plan, pantry and market list; separate private health data per person | Cooking is a household job. Raises ARPPU without dark patterns |
| **Bureau Bursary** | Free Guild | Anyone who asks gets it: one sentence, no proof, renews yearly | Social Justice. Costs ~$0.09 per paid member at a 1:10 ratio |
| **Founding Apprentice** (pre-launch only) | **$36 first year**, price locked for 3 years, capped at ~500 | Guild plus founder credit | Validates willingness to pay, funds launch content. Avoids unlimited lifetime voice liability |
| **Multiverse School: "Bureau License" cohort** | **$99 / $179 / $249 sliding scale**, 6 weeks, ~20 learners | Live instructor sessions, one technique a week, a **verified practical assessment** (live or video), a certificate, 12 months of Guild | Highest-margin line. Uses the School's existing channel and fills W5 (no verification in-app) |
| **Community and education seats** | **~$2–3 per seat a month** (estimate), minimum ~25 seats; grant-friendly | Guild for members. Org admin sees **only** seat activation counts | Mission reach plus steady revenue. No data flows |
| **Cuisine packs à la carte** (year 2) | **$4–5 per pack** for free players | One cook's full apprenticeship: quests, voiced cook, art, lessons. **The recipe itself stays free in the canon** | Breadth for non-subscribers. Contributors share revenue |
| **Revenue share** | **15% of net Guild and pack revenue** to the cuisine contributor pool | Allocated **user-centric**: each member's share goes to the cuisines that member actually cooked that quarter (from aggregated `CookSession` counts). Pack sales: 30% to that pack's contributors | Transparent, rare, protective against T4 |

**Price testing:** run **$6 against $8** for Standard. At $8 the margin rises from about $2.45 to about $3.56.

### Comparables (all prices are estimates; verify before quoting)

| Product | Approx. price | Model | What we learn |
|---|---|---|---|
| **Noom** (non-medication) | ~$59–70 a month (third-party trackers, early 2026; Noom's pricing varies per user) | Coaching subscription, weight-loss framed | High prices are possible with "coaching," but the weight-loss framing is exactly what we refuse (§5 safeguards) |
| **MyFitnessPal Premium** | ~$20 a month or ~$80 a year (estimate from memory; unverified this session) | Freemium tracker; core logging paywalled over time | A cautionary tale: users resent previously-free basics moving behind the paywall. Our §B list prevents this |
| **Habitica** | **$4.99 a month; $47.99 a year** (Apple US App Store listing) | Free habit RPG; subscription for perks and cosmetics; open source | The closest analogue (habit RPG, open source). Our $6/$48 Standard sits at its price, justified by voice and AI cost |
| **Duolingo Super** | ~$96 a year individual, ~$120 a year family (third-party sources; regional variation) | Freemium learning; ad removal plus convenience; family plan | Family plans work. But Duolingo's streak and hearts mechanics are the black-hat patterns we exclude |
| **NYT Cooking** | Roughly $5–6 a month standalone; also bundled in NYT All Access (estimate; sources conflict) | Recipe-library paywall | Recipes behind a paywall are the model we are explicitly *not* (open canon). Shows ~$5/mo is a normal cooking-content price |
| **Mealime Pro / similar meal planners** | ~$3–6 a month (estimate) | Freemium planner | Planner-only apps price below us; our voice mentor and game justify a small premium |

**Positioning:**
- **Priced like a habit game, not like a diet coach.** The Standard tier sits next to Habitica and NYT Cooking, far below Noom and MFP.
- **The pitch:** "the price of one takeaway coffee a month, and some of it pays the cooks who teach you."

### Unit economics (baseline: $6 Standard, mix 40/45/15, 60% annual)

| Per paying member per month | $ |
|---|---|
| Gross ARPPU | 4.56 |
| − Payment/MoR fees and refunds | −0.54 |
| **Net revenue** | **4.02** |
| − Variable cost to serve (50% text $0.30, 50% heavy voice $1.47) | −0.88 |
| − Contributor revenue share (15%) | −0.60 |
| − Bursary seats (1 per 10 paid) | −0.09 |
| **Contribution margin** | **2.45 (61%)** |
| − Free-player subsidy at 5% conversion and $0.05 per free MAU | −0.95 |
| **Margin toward fixed costs** | **1.50** |

**Break-even:**
- **Ops floor (~$3k a month):** ≈ **2,000 paying members / ~40k MAU**.
- **Small studio (~$18k a month):**
  - Guild only: ≈ **12,000 paying / ~240k MAU**.
  - **Blended** with 3 cohorts a month and ~1,500 licensed seats: ≈ **80–90k MAU**.
- At $8 Standard pricing, every number above improves by about a third.

### Monetization Charter (Octalysis guardrails; adopt as hard rules)

The **mission behaviour** is "one more technique." Use white-hat drives to pull toward it and **never sell a black-hat drive**.

- **Encouraged (white hat):**
  - CD1 *Epic Meaning*: Guild fees pay the cooks; Patron funds bursaries; the Bureau Ledger shows it
  - CD2 *Accomplishment*: "technique toolkit" page; skill badges; School certificates
  - CD3 *Empowerment*: hands-free voice cooking; adapting dishes to your rules; the market as a real skill
  - CD4 *Ownership*: your kitchen, your recipe book, cosmetics earned with Stamps
  - CD5 *Social*: cohorts; trust with cooks; later, gifting a Guild month
- **Allowed with care:**
  - CD8 *Loss avoidance* only in its kindest form: "use-it-up before it spoils" for real food, never for progress
  - CD7 *Unpredictability* only in free content: surprise letters from cooks, never in anything purchasable
- **Never:**
  - paid currency (keep Bureau Stamps unpurchasable forever)
  - loot boxes or randomized paid items
  - streaks, or streak freezes for sale
  - energy or "hearts" systems
  - countdown timers or limited-time paid offers
  - paid XP, skill or trust boosts
  - paywall interruptions in cook mode or during a safety flow
  - "your progress will be lost" copy
  - guilt-trip cancellation flows
  - upsells after a low-intake check-in or a symptom log
  - selling, sharing, or "anonymized" licensing of health data
  - affiliate links, ads, or brand-sponsored recipes
- **Upsell moments allowed:**
  - after a *success* (a dish cooked, a technique learned: "Want the Pan in your ear next time? Try voice free for 7 days.")
  - when a free cap is reached, with a written in-character line and the free fallback shown right beside it
- **The test for any new paid feature:** *Would Liz be comfortable if the player's dietitian, a contributor from that cuisine, and a 16-year-old all read the sales copy?*

## D. Changes the spec and plans need now

**M2 is unchecked, so these are cheap today.** They get expensive once encrypted rows exist.

| # | Change | Why now | Where |
|---|---|---|---|
| **1** | **Entitlements, not tiers.** Add `entitlements(id, user_id → users cascade, key text, source text check in ('free','subscription','bursary','school','org_license','founder','accessibility','grant'), starts_at, ends_at, external_ref text null)`. Keys like `voice.unmetered`, `ai.cap.guild`, `pack:<id>`, `household:<id>`. Add a single helper `hasEntitlement(user, key, now)`. **No tier enum on `users`**: bursary, school and org grants all compose as rows. *As built:* accessibility is not an entitlement source; it is the sealed `voice_settings` row (C-19, row 9) | Every paid line here grants the *same* features through different sources. A `tier` column breaks this immediately | `plans/m2-api/step-2.md` (table and migration); `plans/m2-api/step-3.md` (load entitlements into `request.user`); spec §9 "Key entities" |
| **2** | **Free-forever invariant.** Add to Global Constraints: "Routes under `/rules`, `/recipes`, `/ingredients`, `/profile`, `/me/export`, `DELETE /me` and (later) meal logs, journeys and reminders never call `hasEntitlement`." Enforce with an e2e test: a user with **zero** entitlements, plus a user whose subscription has *expired*, complete the full safety journey and export | Makes §B a tested property, like the M1 safety property test, not a promise | `plans/m2-api/README.md` (Global Constraints); `plans/m2-api/step-8.md` (test); spec §2 new principle 8: "Safety, logging and your data are never for sale" |
| **3** | **Usage metering.** `usage_events(id, user_id → users cascade, kind text ('mentor_turn','voice_turn','photo_reaction','import','rule_expansion','stt_ms','tts_ms'), model text, input_tokens int, output_tokens int, audio_ms int, cost_microusd bigint, created_at)`. **No prompt or response content stored.** `AiProvider` writes one row per call from OpenRouter's returned usage. Caps read a daily rollup. Spec §7.3's "per-user daily message limit" becomes entitlement-aware | Without it you can't price, cap, detect abuse, or check the cost model in §5 | Schema: `plans/m2-api/step-2.md`. Writes and caps: M3 mentor plan (`plans/m3-mentor/README.md`, to be written). Voice metering: M7 voice plan. Spec §7, §7.3, §7.7 |
| **4** | **Content and art license decision.** Recipes are CC BY-SA. `content/` (quests, dialogue, personas), voices and art have **no stated license**. Recommend: `content/` and art are **© Multiverse Games, all rights reserved**, with contributor agreements granting Multiverse Games rights plus revenue share. **Or** CC BY-NC-SA if you want openness without commercial copying. Record the cuisine contributor's consent per pack | Packs and cosmetics can't be sold if the content is (or is assumed to be) BY-SA. Also needed to pay contributors fairly | Spec §10 (new "Content license" bullet); `content/README.md`; new `content/LICENSE`; `recipes/CONTRIBUTING.md` (clarify that recipes are BY-SA, the game layer is not) |
| **5** | **Contributor identity and contribution ledger.** Add optional, then required, front matter `contributors: [{ id: <handle>, role: author\|reviewer\|translator\|lesson }]` beside the human-readable `credit:`. Add `data/contributors.json` (public handle, display name, cuisine). **Payout details stay outside the repo.** Canon sync writes `canon_contributions(recipe_path, contributor_id, role, weight)`. Do the same for `content/cooks/*.yaml` (`contributors:` block) and art (`art/CREDITS`) | Rev share needs machine-readable attribution. Retro-tagging 50 files later is error-prone and disputes are costly | `plans/m2-api/step-6.md` (sync and table); `packages/core` front-matter validation as an M2 Step 0 addition (`plans/m2-api/step-0.md`); `recipes/CONTRIBUTING.md`; `content/README.md` |
| **6** | **Packs as data.** Add `pack: <id>` to cook files (`content/cooks/*.yaml`) and `data/packs.json` (id, cooks, skills covered, contributors). Quest unlock (spec §3.3) becomes `trust ∧ requires ∧ (pack free ∨ entitled)`. **Validator rule:** every skill tag in any pack must also appear in at least one free pack's dish (enforces §B.8) | Encodes "breadth, not doors" as a CI check | M5 weekly loop and quests plan (future); spec §3.3; `content/README.md` |
| **7** | **Export stays free and complete.** Add to Step 7: export includes entitlements, usage-event summaries and (later) contributor payout statements for contributors. Export and delete must work for lapsed subscribers. Delete must cancel the subscription through the payments provider first | "No hostage data" is part of the trust proposition. Deletion with an active paid plan is a real edge case | `plans/m2-api/step-7.md`; spec §9 |
| **8** | **B2B data-sharing stance: no org data access.** Add to spec §9: "Organizations that license seats receive only seat activation counts. Kitchen Quest never shares an individual's data with an employer, insurer or organization. A player may create a **revocable, expiring share link or PDF report** for a clinician of their choosing." Schema rule: an `org_memberships(org_id, user_id)` table may exist, but no endpoint joins orgs to health tables | Removes the temptation forever. Keeps HIPAA, WA MHMDA and GDPR exposure minimal. Patient-initiated sharing keeps the clinician option open | Spec §9 and §14; `plans/m2-api/README.md` Global Constraints (now); org tables in the M11 launch plan |
| **9** | **Accessibility voice setting.** *Superseded as built (M7 Step 4, C-19, C7):* not a `profiles` column and not an entitlement. The self-declared need is the sealed `voice_settings` row (`{ accessibility: boolean }`, sealed per user, kept as a sealed `false` when off), set by `PUT /voice/accessibility` under the `health_data` consent; it makes voice unmetered (the abuse ceiling still applies). The plain `accessibility_voice` entitlement kind is retired and the database refuses it. *Original proposal:* a plain `profiles` boolean that granted an `accessibility` entitlement for `voice.unmetered` | Makes the accessibility exemption a data fact, not support tickets, while keeping a disability signal out of plain columns and analytics | `plans/m7-voice/README.md` Ruling 6; `apps/api/src/voice/settings.ts` |
| **10** | **Payments readiness without vendor lock-in.** Reserve `entitlements.external_ref` for MoR subscription IDs. Plan a `POST /billing/webhook` (signed) and a `/billing/portal` link. **Paid plans require an 18+ confirmation** (or guardian purchase) separate from the 16+ age gate | Minors' contracts and auto-renewal law. Avoids redoing auth later | Spec §1.2 (age), §14 (move "subscription" from out-of-scope to "v1.x"); M11 launch plan |
| **11** | **North Star instrumentation, privacy-preserving.** Emit a `technique_added` `XpEvent` the first time a player cooks a dish with a new skill tag. Add a self-hosted, cookie-less product analytics counter (aggregate only; no third-party trackers, per §9) to measure conversion and retention | You can't run Appendix A tests, or prove mission impact to funders, without it | Spec §6 and §9; M5 weekly loop plan; M11 launch plan |
| **12** | **Spec text updates** | Keep the spec truthful | §1.2: replace "No monetization in v1" with this model's phasing. §6: "Bureau Stamps can never be bought." §15 Q3: answered |

**Top three to do this week:** #1 + #2 (entitlements plus the free-forever test), #3 (usage metering schema), and #4 + #5 (content license plus contributor IDs).

## E. Discovery-driven planning (Rita McGrath)

**Reverse income statement.** For the studio to be sustainable (~$18k a month contribution) by month 30, **all** of these must hold:

- ≥ 80k MAU
- ≥ 5% paid conversion
- ≥ $4.00 net ARPPU
- free cost ≤ $0.05 per MAU
- 3 School cohorts a month at ~20 learners
- ~1,500 licensed seats

Each is an assumption. Rank them by (impact if wrong) × (uncertainty), and test the cheapest way first.

| # | Assumption (riskiest first) | If wrong… | Cheapest test | Cost / time | Pass threshold |
|---|---|---|---|---|---|
| 1 | **People will pay ~$6 a month for a cooking RPG with a voice mentor** | Guild revenue collapses; the School must carry everything | **Fake-door plus Van Westendorp:** add a "Join the Pantry Guild" panel to the three prototype pages showing the three sliding-scale prices. Clicking records the tier (no charge) and asks the four Van Westendorp price questions. Recruit 50–100 playtesters from the Multiverse community | ~2 days; $0 | ≥ 25% click a tier; acceptable price range includes $6. Tier split ≥ 50% at Standard or higher |
| 2 | **Free-tier AI cost can be held to ≤ $0.05 per MAU** | Break-even MAU doubles (§5 D) | **Measure real tokens:** run the 3 prototypes' scripted conversations and 50 real playtest transcripts through the Qwen tokenizer with the M3 prompt draft; count scripted-line hit rate | ~1 day | Mentor turn ≤ 3k in / 200 out; scripted hit rate ≥ 70% |
| 3 | **School cohorts sell at ~$180 average** | Lose the second engine | **Waitlist with deposit:** announce a 6-week "Bureau License" cohort to the Multiverse School list with a $25 refundable deposit and the sliding scale | ~1 week; ~$0 | ≥ 20 deposits in 2 weeks |
| 4 | **Contributors accept the commissioning rates plus 15% user-centric share, and see packs as fair** | Content stalls; reputational harm (T4) | **5–8 interviews** with prospective contributors and reviewers from the launch cuisines (Kerala, Oaxaca, Osaka). Show a one-page term sheet and a mock pack card | ~1 week; honoraria ~$50 each | ≥ 4 of 6 would sign. No one objects to the recipe-free / apprenticeship-paid split (or you learn the right split) |
| 5 | **Voice works at < 1.5 s p95 and ~900 heavy users per GPU box** | The premium anchor weakens, or GPU cost triples | **Rent an hourly cloud GPU** (comparable to the Hetzner card), benchmark faster-whisper turbo plus 2 open TTS voices with 20 simulated concurrent streams | ~2 days; < $50 | p95 < 1.5 s at 20 concurrent; GPU-seconds per turn within 2× of the estimate |
| 6 | **Health positioning stays "general wellness"** (no device or HIPAA burden) and paid plans are compliant | Legal cost, forced redesign, or blocked launch | **1–2 hour consult** with a US/EU health-privacy lawyer. Bring the journey copy, the §D.8 stance, and the subscription flow. Read FDA's general-wellness guidance first | ~$500–1,500 | Written go / no-go per claim; a list of required copy changes |
| 7 | **Sliding scale doesn't collapse to Seedling** | ARPPU falls ~30% | Same fake-door as #1, randomized: show the three tiers with and without a sentence on where the money goes | Included in #1 | ≥ 50% choose Standard or Patron when the "where it goes" sentence is shown |
| 8 | **Bursary abuse stays low** (≤ 1 bursary per 10 paid) | Margin leak | Soft launch with a counter. Bursary copy asks people to "take it if you need it, pay later if you can" | At launch | Ratio ≤ 1:8 after 3 months; if higher, add a light annual renewal sentence, never proof |
| 9 | **A community org will license seats** | Lose ~$3k a month of the blended plan | **1 pilot conversation** with a community kitchen, newcomer program or college dining program the School already knows. Offer 3 months free in exchange for a quote | ~2 weeks | A signed letter of intent at ≥ $2 per seat |
| 10 | **Dietitians want a patient-shared report** (the B2B2C future) | Year-2 option shrinks | **5 dietitian interviews** about low-FODMAP adherence. Show a mock "share with my dietitian" PDF | ~1 week; honoraria | ≥ 3 of 5 would recommend it to patients |

**Checkpoints** (McGrath milestones; re-plan at each):
1. **After tests 1–4 (≈30 days):** confirm or revise prices, the free caps, and the School pilot.
2. **After M7 voice benchmark (test 5):** commit GPU spend or reframe the Guild around packs and household.
3. **At ~20 dishes plus legal sign-off (test 6):** open the Founding Apprentice pre-sale (cap 500).
4. **3 months after launch:** check the conversion, free cost per MAU and bursary ratio against the reverse income statement. Adjust price ($6 → $8 test) before adding new paid lines.

## F. Fit with the organization's and Liz's values

| Value | How the recommended model honours it |
|---|---|
| **Social Justice** (org) | Sliding scale, bursary, safety and journeys free, contributors from each cuisine paid with a transparent share, no data selling |
| **Community** (org) | Contributor network as a co-owner of revenue; School cohorts; org licenses for community programs |
| **Growth / Knowledge** (org) | North Star = techniques added; at least one free path to every technique; open canon |
| **Purpose** (org + Liz) | Revenue tied to cooking and learning, not engagement minutes or anxiety |
| **Independence** (org) / **Freedom** (Liz) | PWA (no app-store gatekeeping), open canon, swappable AI model, export always free, no investor-style data monetization |
| **Genuineness** (Liz) | Same features at every sliding-scale price; public Bureau Ledger; no dark patterns (Charter) |
| **Rationality** (Liz) | Metered costs, explicit break-even, discovery-driven tests before spend |
| **Wealth** (Liz) | School cohorts and seat licenses are high-margin and scale with The Multiverse School. The Guild pays its own costs. The $8 price test and Household plan raise ARPPU without extraction |

**Hedgehog (Collins):**
- **Best in the world at:** respectful, safe, funny cooking apprenticeship.
- **Passionate about:** people feeding themselves well and the cooks who teach them.
- **Economic engine:** **contribution margin per active cook**, fed by the Guild and multiplied by the School.

---

## Appendix: assumptions register

| Assumption | Value used | Confidence |
|---|---|---|
| OpenRouter price for `qwen/qwen3.8-27b` | $0.40/M in, $3.00/M out | Given by founder |
| Tokens per mentor turn | 2,500 in / 150 out | Low. Measure (test 2) |
| Turns per month (free typical / text engaged / heavy voice) | 30 / 150 / 600 | Low. Instrument |
| GPU box cost and capacity | ~$200 a month; ~900 heavy voice users | Low. Benchmark (test 5) |
| MoR fees | ~5% + $0.50 per transaction | Medium. Check the provider's current terms |
| Refunds and chargebacks | 2% | Medium |
| Tier mix / annual share | 40/45/15; 60% annual | Low. Test 1 and test 7 |
| Conversion | 3–8% (5% planning) | Low. Industry ranges are estimates |
| Content cost per dish | ~$750 all-in | Low. Set with contributors (test 4) |
| Legal launch pack | $8–15k | Low. Get quotes |
| Team cost | ~$15k a month | Placeholder. Liz to set |
| Competitor prices | See §C table | Estimates. Habitica from Apple US listing; Noom and Duolingo from third-party sources; MFP and NYT Cooking unverified |

*The cost and break-even arithmetic was computed with a small script; changing any assumption above changes the break-even table proportionally. Re-run it once real token counts exist.*
