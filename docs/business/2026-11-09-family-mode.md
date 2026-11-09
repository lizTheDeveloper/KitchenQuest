# Feature-to-Value-Chain Report: Family Mode

**Date:** 2026-11-09
**Prepared for:** Liz Howard, Founder and CEO, Multiverse Games / The Multiverse School
**Feature under analysis:** **Family Mode**: younger cooks (under 16) take part in Kitchen Quest through a parent-run household.
**The request:** "we should probably add family mode or something like that so you can have a family cooking quest game thing… get the business analyst agent on that as a revenue thing as well."
**Inputs read:** design spec (`docs/superpowers/specs/2026-11-09-kitchenquest-design.md`, especially §1.2, §5, §7.0, §7.7, §9, §15–18), `docs/business/2026-11-09-value-chain-monetization.md` (pricing and unit economics; "the prior report"), `docs/business/2026-11-09-octalysis-audit.md` (never-rules, M-7, M-9, M-10), `plans/m2-api/` (Step 2b entitlements are already built).
**Status:** analysis and recommendation. Nothing here is decided until Liz decides it.

> **This is not legal advice.** §B summarises children's privacy and safety law as background for product decisions. Laws in this area changed in 2025–2026 and are still being litigated. Every legal point is marked with what a lawyer must confirm, and §B.7 lists the questions to take to counsel. Market numbers are **estimates** unless a source is named. No statistics are invented: where a number is an assumption, it says so.

---

## TL;DR

- **Design in one line:** a parent (18+) runs a **Family Kitchen**: child **cook profiles** with no accounts, emails or birthdays; **Cook Together** quests that split each recipe's steps by age band (kids wash, measure and stir; adults handle knives and heat); a **family recipe book** that records who taught whom; and a weekly **Family Table** ritual with no streak.
- **AI and children:** **children never talk to the AI.** In **Family Table mode** the Pan speaks only scripted lines (`ai: never`), server speech-to-text is off, and the only voice controls are a few fixed commands ("next", "repeat", "timer") recognised on the device. The parent can step out of Family Table mode to ask the Pan a free-form question as themselves.
- **Data stored about a child:** a nickname, an age band, a preset avatar, their own skill progress, "cooked together" records, and allergy or diet rules **entered and confirmed by the parent** (sealed like adult rules). **Nothing else:** no intake, nutrition, meal logs, symptoms, photos of the child, voice, free text from the child, school or location.
- **Disordered-eating safeguards are stricter for children:** **no tracking of children's intake at all**, no nutrition numbers on child profiles, no "clean plate" or "ate it" rewards. "Try It" quests reward handling and cooking a food, never eating it.
- **Pricing:**
  - **Family mode's safety and core are free:** one adult account with up to 4 child profiles, per-child allergy rules, age-band safety tasks, Cook Together quests for every canon dish, and the printable family book.
  - The **Household Guild** becomes a sliding scale: **$6 / $10 / $16 a month** ($48 / $80 / $128 a year). It covers up to 4 accounts aged 16+ and 6 child profiles, gives Guild features to every account, and adds the shared plan, pantry and market list across accounts plus seasonal Family Table packs.
  - New lines:
    - **Gift memberships** (bought by an adult, redeemed by an adult)
    - **print-on-demand family recipe books**, sold by us at a stated margin with no affiliate links
    - a **Junior Kitchen Club kit** through The Multiverse School for schools, libraries and after-school programs, with **no child data at all**
- **Revenue impact (estimate):** at the prior report's 80k-MAU scenario, family mode adds roughly **+$0.8k to +$4.2k a month in contribution** from households. Clubs, gifts and print add roughly **+$1.5–2.5k**. That lifts the blended plan from ≈$15.8k toward the ≈$18k studio target. A Household subscriber's contribution margin is ≈**$4.36 a month**, against $2.45 for an individual. The extra legal and compliance cost is ≈**$10–25k one-time** (estimate).
- **When:** **post-v1.** Reserve the data model in **M5** (with `Household`, which the audit already reserves there). Ship as a new **M13 Family Mode** milestone after M12 launch hardening. **Before that, run a paper-only pilot** (printable Cook Together cards through the School) that collects no data.
- **Top spec changes:**
  1. Add a new **§19 Family Mode** and change the age rule in §1.2: child profiles under 16 without accounts, managed by an 18+ guardian.
  2. Add a **data model** to §9: `households`, `household_members`, `child_profiles`, `child_rules`, `parental_consents`, `family_cook_sessions`, `book_lineage`. Keep children out of every AI prompt.
  3. Add **content and safety data**: `family:` task splits with `min_band` / `adult_only` per recipe step, a CI linter that refuses to assign heat, knives or hot oil below a band, and a Family Table mode in the mentor that uses scripted lines only.

---

# Feature-to-Value-Chain Report

## 1. Feature Overview

### Summary

Family Mode lets a household cook together inside Kitchen Quest. Today the app is 16+ for accounts and 18+ for paid plans (spec §1.2, §16), and spec §15 Q4 already defers "younger cooks" to a family mode (§19, which doesn't exist yet). This report proposes that section.

**The proposed design ("The Family Kitchen"):**

| Component | What it is | Key guardrail |
|---|---|---|
| **Family Kitchen** (household) | A parent or guardian (account holder, 18+) creates a household. Other 16+ account holders can join by invitation (M-10 Household Kitchen). | Same privacy rules as M-10: meal logs, nutrition, rules, symptoms and journeys of *adults* are never shared. Adult allergy rules are shared for planning only with each person's opt-in. |
| **Cook profiles** (children) | A parent adds a child as a **profile**, not an account: nickname (a nickname or emoji, not a legal name), age band (**3–5, 6–8, 9–12, 13–15**), a preset pixel avatar, and allergy or diet rules entered by the parent. | No email, password, birthday, photo or free text. A child can't sign in. The profile exists only on a parent's device session ("Who's helping today?"). |
| **Cook Together quests** | Any canon dish can be cooked as a family. The recipe's steps are split into **tasks tagged by age band and hazard**. The game hands each helper the tasks their band and their parent allow. | Task bands are written in content and reviewed. They aren't AI advice. The parent can always move a task *up* to an adult. They can move it *down* only one band, after a read-back of the safety note. |
| **Kitchen-safety tasks by age** | Short, illustrated "how to" cards per task: handwashing, the claw grip, oven mitts, "tell a grown-up before you touch the stove". | Written content, `ai: never`, reviewed by a food-safety or child-nutrition educator before launch (§5). |
| **The Family Recipe Book** | A family section of the Recipe Book (M-7). Each page records who cooked, which tasks each helper did, and **who taught whom**: a lineage line ("Grandma Rosa → Dad → Jo"). Teachers outside the app are free-text labels the parent types. | Free printable export (M-7: export and print are never paywalled). Food photos only (§B.4). |
| **Family Table** (weekly ritual) | One evening a week, chosen by the family. The child picks from **three dishes the parent approved** (autonomy within limits), and the family cooks it together. The Bureau stamps a "Family Table Charter" page. | **No streak and no counter of weeks.** Missing a week costs nothing (principle 3, never-rule 8). The book shows the dishes cooked, not the gaps. |
| **"Try It" quests** (picky eaters) | A food-exposure ladder where each rung is about *meeting* a food, not eating it: **look → touch → smell → help cook it → (optional) taste**. Each rung earns the child a sticker for the *cooking* skill (washing, tearing, stirring). | Nothing is recorded about eating. "Tasted it" is never required, never rewarded more than the other rungs, and never shown as progress. No "clean plate" language. Follows the widely used *division of responsibility* idea in child feeding (parent decides what, when and where; child decides whether and how much). A child-nutrition reviewer should check the copy. |
| **Neighborhood Pantry as a family activity** | Kids help make, portion and **label** a share ("Label the jar" task: name, date, keeps until). The *parent* posts, accepts requests and hands over. A **Community Fridge visit** quest (offline) for families. | Children never post, request or appear in posts, by name or photo. A post from a family account looks like any other post (§18). |
| **Kids' Technique Toolkit** | Each child has their own Seen → Tried → Yours tiers (M-1) for kid-scale techniques: washing, measuring, cracking eggs, kneading, tearing, the claw grip. | Nothing earned is taken back. **No sibling comparison:** each child sees only their own book. The family wall shows "who can do what" without counts or ranks. |

### Jobs To Be Done (Christensen)

| Who | Job ("When I…, I want to…, so I can…") | What they'd pay for |
|---|---|---|
| **Parent of young kids (3–8)** | When I'm making dinner and the kids want to "help", I want jobs that are safe for them and keep dinner on track, so we cook together without a burn or a meltdown | Free core. Pays for the household plan, Family Table packs, the printed book |
| **Parent of a picky eater** | When my child refuses new food, I want a no-pressure way to bring them close to it, so mealtimes stop being a fight | Free ("Try It" is safety-adjacent and must not be paywalled). Gratitude conversion |
| **Parent of a child with allergies** | When I cook for the family, I want every dish checked against *everyone's* rules, including the kids', so I can involve my child without fear | **Free forever** (never-rule 1: never charge for safety) |
| **Parent of a 9–15-year-old** | When my kid is nearly independent, I want them to learn real skills before they leave home, so they can feed themselves | Household Guild; later, a teen pathway at 16 when they get their own account |
| **Grandparent or relative** | When I want to pass down my cooking, I want my recipes recorded with my name, so the family keeps them | **Gift memberships, printed family books** |
| **Teacher, librarian, after-school leader** | When I run a cooking club, I want a ready-made, safe, age-banded curriculum with no student logins, so I can run it with no admin or privacy risk | **Junior Kitchen Club kit** (School) |

**Core job:** *"Help my family learn to cook together, safely, at each person's level, and keep what we learn."* This fits the prior report's North Star (*techniques added per active cook*): Family Mode adds techniques for helpers who aren't players.

### Kano Categorization

| Element | Kano | Implication |
|---|---|---|
| Per-child allergy rules and the family-wide `check` | **Basic** | Free forever. A family app without them is dangerous |
| Age-band safety tasks | **Basic** | Free forever. Must be reviewed content, not AI |
| Cook Together quests on canon dishes | **Performance** | Free (canon stays free, never-rule 10). More family content increases satisfaction steadily |
| Family recipe book with lineage, printable | **Delighter** → Performance | Free PDF. The print-on-demand hardcover is a paid physical product |
| Family Table ritual | **Delighter** | Free core. Seasonal Family Table packs are Guild content |
| "Try It" ladder | **Delighter** for parents of picky eaters | Free |
| Shared plan, pantry and market list across two or more adult accounts | **Performance** | Household Guild (a coordination service, audit §4.1 CD5) |
| Junior Kitchen Club kit | **Performance** for educators | B2B2C, School |

**Kano rule (carried over from the prior report):** monetize only Performance and Delighter attributes, never Basic ones. A child's safety is Basic.

---

## 2. Context Mapping

### Business Model Impact (Business Model Canvas)

| Block | Change with Family Mode |
|---|---|
| **Customer segments** | Adds (1) **parents and guardians** as buyers; (2) **under-16 helpers** as *users who are not customers or accounts*; (3) **gift buyers** (grandparents, relatives); (4) **educators**: schools, libraries, after-school programs |
| **Value proposition** | "Cook together, at every age, safely, and keep what you learn." Allergy safety for the whole family, free. No ads, no selling to kids, ever |
| **Channels** | PWA (unchanged). The Multiverse School for club kits. Libraries and community programs. Holiday gifting, marketed to adults only |
| **Customer relationships** | Parent-mediated. The Pan addresses the parent. Kids hear only scripted lines |
| **Revenue streams** | Household Guild (sliding scale), gift memberships, print-on-demand books, Junior Kitchen Club kits and seats, foundation grants for library and community kits |
| **Key resources** | Age-banded task content plus safety review. Parental-consent records. Child-nutrition and food-safety reviewers |
| **Key activities** | Writing task splits for each dish. Compliance (COPPA, UK and EU children's codes). Educator support |
| **Key partners** | Children's-privacy counsel. A verifiable-parental-consent method or vendor (if needed, §B). A print-on-demand vendor. Libraries and after-school networks |
| **Cost structure** | Content: ≈ +$150 a dish for task splits and a safety review (estimate). Legal: ≈ $10–25k one-time (estimate). Little extra AI cost, since child play is scripted |

### Lean Canvas (startup lens)

- **Problem:** kids' cooking content is either unsafe ("let them use the knife!") or babyish. Family meal apps plan *for* kids, not *with* them. Allergy families can't involve kids safely. Picky-eating advice comes as pressure.
- **Unfair advantage:** a deterministic allergy engine that checks a dish against **every family member's rules**, plus a respectful, credited canon and a mentor that kids hear only in scripted lines. Competitors with free-form AI chat for kids carry a regulatory load we choose not to carry.
- **Key metric:** *family techniques added per active household per month* (adult and kid toolkits combined).

### Ecosystem Dependencies

| Dependency | Criticality | Note |
|---|---|---|
| Children's-privacy counsel (US + UK + EU) | **Critical** | Gates launch (§B.7) |
| Verifiable parental consent method | **High** | Possibly not needed if nothing is collected *from* a child. That's a key lawyer question |
| Food-safety or child-nutrition reviewer | **High** | For task bands and "Try It" copy |
| M-10 Household Kitchen, M-7 Recipe Book, M-9 Cooked for Someone | **High** | Family Mode builds on them |
| Print-on-demand vendor | Moderate | A data processing agreement is needed. Content holds nicknames and food photos only |
| Multiverse School | **High (positive)** | Channel for club kits |

---

## 3. Value Chain Mapping (Porter)

### Primary Activity Impact

| Activity | Impact | Rating |
|---|---|---|
| **Inbound logistics** (content) | Every dish needs a `family:` task split and safety bands, reviewed. About +20% content cost per dish (estimate). Contributors may add family stories ("how I learned this as a child") | **Critical** |
| **Operations** | Profile switching, Family Table mode in the mentor (scripted, server STT off), multi-person `check`, consent records, child-data deletion. Low AI cost | **Critical** |
| **Outbound logistics** | Printable family book (free PDF), print-on-demand, printable club kit | Moderate |
| **Marketing and sales** | A strong, mission-true story ("cook together, at every age"), and a new gift channel. **All marketing is aimed at adults.** No child-directed ads, ever | **Critical** |
| **Service** | Parent dashboard: view, export and delete each child's profile in two taps. Support for consent questions | Moderate (trust-critical) |

### Support Activity Impact

| Activity | Impact |
|---|---|
| **Firm infrastructure** | Children's-privacy compliance program: COPPA written retention policy and information security program (§B.1), a children's DPIA (UK AADC, GDPR), consent records. **Critical** |
| **HR** | A child-nutrition or food-safety reviewer per launch region. Club facilitators through the School. Moderate |
| **Technology** | Household and child-profile schema. A content linter for hazards. The scripted-only mentor mode. On-device face check for photos (§B.4). **Critical, but modest** |
| **Procurement** | Print vendor, possibly a consent vendor. Minor |

### Wardley Map Positioning

| Component | Stage | Strategy |
|---|---|---|
| Multi-person allergy `check` | Custom → product | **Differentiator.** Already the moat; Family Mode extends it at almost no cost (`check` is pure) |
| Age-banded task content | **Genesis** | Build it, review it, own it. Can't be copied quickly because it's reviewed content |
| Parental consent / age assurance | Product → utility | Buy if needed. Better still, design so it's barely needed |
| Print-on-demand | Utility | Buy |
| Kids' AI chat | (deliberately not built) | Others will build it. We position *against* it |

---

## 4. Strategic Analysis

### VRIO Analysis

| Resource | V | R | I | O | Result |
|---|---|---|---|---|---|
| Allergy `check` across every family member | ✔ | ✔ | ◐ | ✔ (M1 done) | Temporary advantage, strong for allergy families |
| Reviewed, age-banded Cook Together content | ✔ | ✔ | ✔ (slow to write and review well) | ✘ (no format or reviewers yet) | **Unrealized sustained advantage** |
| "Children never talk to the AI" stance | ✔ (trust with parents and regulators) | ✔ (most AI products go the other way) | ◐ (copyable, but it costs competitors their AI story) | ✔ (scripted-first content already exists, spec §8) | Temporary to sustained, as a **trust brand** |
| Multiverse School educator channel | ✔ | ✔ | ✔ | ✘ | Unrealized advantage |
| Family book with lineage | ✔ | ◐ | ◐ | ✔ (M-7) | Parity-plus. Emotional value, so retention |

### SWOT Analysis

| | Helpful | Harmful |
|---|---|---|
| **Internal** | **S1** Deterministic allergy engine works for any number of eaters. **S2** Scripted-first content (spec §8) makes AI-free child play cheap and natural. **S3** No ads, no data sales, no streaks: already the right posture for kids. **S4** The School gives a B2B2C channel | **W1** Children's law adds fixed compliance cost and process to a small studio. **W2** Every dish needs extra content (task splits). **W3** The weekly loop assumes one cook. Family scheduling is new design work. **W4** Launch content (9 dishes) is thin for families |
| **External** | **O1** Families cooking together is a familiar parenting goal; demand is plausible but **not quantified here**. **O2** Libraries, schools and after-school programs run cooking clubs and seek low-admin, grant-fundable kits (estimate; validate). **O3** Gifting season. **O4** Parent distrust of AI chatbots for kids makes "no AI for kids" a selling point | **T1** Fast-moving children's law (COPPA amendments, state laws in litigation, UK and EU codes). **T2** Reputational damage from any child safety incident (a burn after a task card). **T3** "Directed to children" classification could pull the whole app into COPPA scope (§B.1). **T4** Big platforms bundle family plans cheaply |

**TOWS:**
- **S2 + S3 → O4:** lead with "your kids never talk to an AI here".
- **W1 → T1/T3:** design for data minimization so compliance is small, and get counsel early.
- **S4 → O2:** the club kit holds **no child data**, so it scales with little risk.

### PESTEL Analysis

| Force | Factors | Rating |
|---|---|---|
| **Political** | Bipartisan child-online-safety attention in the US, UK and EU. AI chatbots and minors are under specific scrutiny: the FTC sent 6(b) study orders to seven AI companion-chatbot companies in Sept 2025, and California's companion-chatbot law SB 243 took effect 1 Jan 2026 | **High** |
| **Economic** | Cost-of-living pressure keeps sliding-scale and free safety important. Family plans are a normal consumer pattern (Duolingo and Spotify both sell them). Holiday gifting is seasonal | Moderate |
| **Social** | Children's relationship with food is formative. Pressure, "clean plate" rules and moral food language are widely cautioned against in child-feeding guidance. ARFID and picky eating are real; the app must not act as therapy. Burns and cuts are the main kitchen hazards for kids | **High** |
| **Technological** | On-device keyword spotting and face detection are feasible in the browser (verify performance on low-end phones). Mic picks up children incidentally when an adult uses voice | Moderate |
| **Environmental** | Families' food waste and the Neighborhood Pantry are a positive story | Minor |
| **Legal** | COPPA (amended), state children's codes and privacy laws, UK Children's Code and Online Safety Act, GDPR Art. 8 and Art. 9, EU AI Act transparency. Product liability for safety instructions. Consumer law on gift cards (expiry rules vary by state). See §B | **Critical** |

### BCG Matrix (Family Mode revenue lines, 24 months)

| Line | Placement |
|---|---|
| Household Guild with family features | **Star** (build) |
| Junior Kitchen Club kit (School) | **Question Mark**, but promising (pilot) |
| Gift memberships | **Cash Cow** once the Guild exists: no extra product, seasonal |
| Print-on-demand family book | Small **Question Mark / Dog**: fine as a sideline, strong for loyalty |
| Kids' paid content or kids' cosmetics store | **Dog: do not enter** (pester power) |

---

## 5. Prioritization

### Impact/Effort Matrix

| | Low effort | High effort |
|---|---|---|
| **High impact** | Reserve the data model in M5. Paper-only Cook Together pilot via the School. Gift memberships (once the Guild exists). Multi-person `check` (pure function, already there) | Family Mode milestone (M13): profiles, tasks, Family Table mode, consent, legal |
| **Low impact** | Print-on-demand book | Teen-specific solo pathway for 13–15 (defer) |

### Cost-Benefit Summary

**Costs (estimates):**

| Item | One-time | Ongoing |
|---|---|---|
| Children's-privacy legal review (US + UK + EU), DPIA, policy drafting | $10–25k | ≈ $300/mo amortized plus annual refresh |
| Consent method (if counsel says it's needed for free families) | Integration ≈ 1 week | Per-check fee if a vendor is used ($ unknown; quote it) |
| Task-split content for the 9 launch dishes plus 5 basics | ≈ $2k (14 × ~$150) | ≈ +$300/mo at 2 new dishes a month |
| Food-safety or child-nutrition review | ≈ $1–2k | ad hoc |
| Engineering (M13) | ≈ 6–8 person-weeks | — |
| AI cost of child play | — | ≈ $0 (scripted lines). Adults' AI use is already in the prior model |

**Benefits:** see the revenue model in §C. In short, Household subscribers carry roughly **1.8×** the contribution of individual subscribers, and the segment is plausibly a large share of adult players (an assumption, 30%).

### RICE Scoring

Same scales as the prior report. Reach is relative per quarter, Impact is 0.25–3, Effort is in person-weeks.

| Workstream | Reach | Impact | Conf. | Effort | **RICE** |
|---|---|---|---|---|---|
| Paper-only Cook Together pilot via the School (no app, no data) | 3 | 2 | 70% | 1 | **4.2** |
| Reserve household and child data model in M5 | 6 | 1 | 90% | 0.5 | **10.8** |
| Children's-privacy legal consult (scoping) | 6 | 2 | 80% | 0.5 | **19.2** |
| Gift memberships (after the Guild launches) | 4 | 1 | 70% | 1 | **2.8** |
| Family Mode M13 (full) | 6 | 2 | 50% | 8 | **0.75** |
| Junior Kitchen Club kit (digital, printable) | 3 | 2 | 50% | 3 | **1.0** |
| Print-on-demand book | 2 | 0.5 | 60% | 2 | **0.3** |
| Kids' free-form AI chat | — | negative | — | — | **reject** |

**Order:** legal scoping → reserve schema → paper pilot → (after launch) M13 → club kit → gifts → print.

---

## 6. Strategic Impact

### Balanced Scorecard Mapping

| Perspective | Objective | Measures (targets are hypotheses) |
|---|---|---|
| **Financial** | Lift ARPPU and conversion among parents without extraction | Household share of paid ≥ 30%. Contribution margin per Household ≥ $4.00. Club kits ≥ 30 per term in year 1. Gift redemptions |
| **Customer** | Families cook together safely and enjoy it | **Family techniques added per active household per month.** Family Table weeks per quarter, reported to *us* only as aggregate counts and never shown as a streak. Zero safety incidents reported. "My child felt pressured about food" survey item (parents) < 5% |
| **Internal process** | Compliance and content at low cost | 100% of canon dishes with a reviewed `family:` split. Hazard-linter violations = 0. Child-data deletion SLA (immediate). DPIA current |
| **Learning and growth** | New capabilities: children's-privacy practice, educator channel | Reviewer network includes ≥ 1 child-nutrition or food-safety educator. Club facilitators trained |

### Critical Value Drivers (ranked)

1. **Trust with parents (critical).** No AI for kids, no child data beyond the minimum, no selling to kids. This is the product.
2. **Multi-person allergy safety (critical).** It's free, and it's the reason allergy families will choose this app.
3. **The Household Guild's higher margin (moderate–critical).** About $4.36 against $2.45 per paid member.
4. **The educator channel (moderate).** School kits reach families without any child data.
5. **Lineage and the family book (moderate).** Epic Meaning and long-term retention, and they feed print and gifts.

### Strategic Risks (ranked)

1. **Critical: a child is hurt following a task card.** Mitigation: conservative bands, hazard linter, an adult on every heat or knife step, reviewed safety copy, visible "a grown-up is in charge" framing, and product-liability review of the terms.
2. **Critical: the whole app becomes "directed to children" or "mixed audience" under COPPA** because of family features and pixel art, pulling every flow into scope. Mitigation: kids appear only as parent-managed profiles. Child-appealing content stays inside the parent-gated mode, and marketing targets adults. **Get counsel's view first** (§B.7, Q1).
3. **High: incidental child data through the adult's voice or photos** (a child talking near the mic, a face in a dish photo). Mitigation: Family Table mode turns server STT off; on-device face check; no transcript retention in that mode.
4. **High: disordered-eating harm to children** through food-related praise or tracking. Mitigation: no intake tracking, "Try It" rewards cooking not eating, no moral food words, reviewer sign-off.
5. **Moderate: Household cannibalizes two individual subscriptions** (two parents paying $6 each switch to one $10 plan). Mitigation: it's still higher margin per household, so accept it; price the household at ≥1.6× an individual.
6. **Moderate: content cost slows the canon.** Mitigation: task splits are short and written by contributors in the same pass.

---

# Recommendation Summary

- **Should this feature be prioritized?** **Yes, as the first post-v1 milestone, with three cheap moves now.**
  - Family Mode strengthens the mission (Community, Growth, Purpose) and the business: a higher-margin plan, a gift channel, and a School channel. **But it multiplies legal exposure**, so it must not ride along with v1.
  - **Now (≈1 week total):** a scoping consult with children's-privacy counsel, reserving the schema in the M5 plan, and a paper-only Cook Together pilot through the School.
  - **After M12:** build M13 Family Mode.
- **Suggested next steps:**
  1. Liz approves (or edits) the **"children never talk to the AI"** stance and the child-data list (§B.3). These are the decisions everything else depends on.
  2. Add spec §19 Family Mode (draft in §D) and the §1.2 age change.
  3. Book a 2-hour scoping consult with US/UK/EU children's-privacy counsel, using the questions in §B.7.
  4. Write `family:` task splits for 3 launch dishes plus the 5 basics, have them reviewed, and print them as cards for a School pilot (§E test 1).
  5. Add `households`, `household_members`, `child_profiles`, `child_rules` and `parental_consents` to the M5 plan as **reserved** tables (no endpoints until M13).
  6. Extend the Monetization Charter with the children's rules in §A.

---

# Beyond the template

## A. Octalysis fit

| Drive | What Family Mode adds | Hat |
|---|---|---|
| **CD1 Epic Meaning** | **"Passing it down":** the lineage line in the family book, heritage recipes kept as private imports, a grandparent's dish credited to them | White |
| **CD2 Accomplishment** | Each child's own Technique Toolkit (Seen → Tried → Yours). Bureau "Apprentice Papers" certificates the parent can print | White |
| **CD3 Empowerment** | The child picks the Family Table dish from three. Family Pantry Frames ("what can we make with what we have?") | White |
| **CD4 Ownership** | The family book and the printed hardcover. Kid avatars and earned kitchen objects | White |
| **CD5 Social / Relatedness** | Cooking *with* people, not competing against them. M-9 "Cooked for Someone" becomes "cooked *with* someone". The family wall: "Jo can crack eggs; ask Jo" | White-leaning |
| **CD6 Scarcity** | Only real seasons (M-12): "strawberry season, let's make jam" | Neutral, honest |
| **CD7 Unpredictability** | Travelling Cooks may visit with a family quest (free content only) | Neutral |
| **CD8 Loss** | Only real-world: use-it-up food. Never in-game | Kept minimal |

**Score effect (estimate, against the audit's scale):** CD5 rises from 3 → 6 (above the audit's projected 5 with M-10), and CD1 rises by 1. Black-hat load does not rise.

**Dark patterns to avoid with children (add to the Monetization Charter as hard rules):**

1. **No pester-power upsells.** Nothing in child-facing screens mentions money, the Guild, packs or gifts. A locked item is never *shown* to a child as "locked". It simply isn't there.
2. **No child-directed purchase prompts.** There's no store, price or "ask a grown-up to buy" anywhere in a child profile. Purchases happen only in the adult's account settings, behind the adult's sign-in.
3. **No streaks, and no streak-like counters** ("4 Family Tables in a row!"). Never-rule 8 applies doubly.
4. **No leaderboards or sibling comparison.** No "Jo has 12 skills, Sam has 7". The family wall lists skills, not counts.
5. **No variable rewards for kids.** No surprise boxes, spins or random stickers. Stickers map one-to-one to tasks.
6. **No pushes to children.** Notifications go to adult devices only, and never mention a child's activity as leverage ("Jo misses cooking with you!").
7. **No food-moralizing.** No "good/bad", "healthy/junk", "clean plate" or "earn dessert". No reward for eating, finishing or trying a bite more than for any other rung.
8. **No body talk.** No weight, size or appearance in any line or reaction, as for adults (voice guide).
9. **No social pressure for growth.** No "invite your family" rewards (never-rule 9) and no referral for gifts.
10. **No urgency in gifting.** Holiday gift copy has no countdowns or "offer ends" (never-rule 5). Gift memberships are on sale all year.

## B. Children's privacy and safety law (the binding constraint)

> **Not legal advice.** This summarises the law as best I understand it for product design. Items marked **(verify)** need counsel. Laws and their litigation status are moving.

### B.1 United States: COPPA

- **Scope.** COPPA applies to operators of online services **directed to children under 13**, or with **actual knowledge** that they collect personal information **from** a child under 13. Personal information includes names, online contact information, persistent identifiers, **photos, video or audio containing a child's image or voice**, and geolocation.
- **Duties when in scope:** notice to parents; **verifiable parental consent (VPC)** before collection; parental rights to review and delete; data minimization (no conditioning participation on more data than reasonably necessary); retention only as long as reasonably necessary; and reasonable security.
- **The 2025 amendments.** The FTC published amendments in the Federal Register on **22 April 2025**. They took effect **23 June 2025**, with a compliance deadline of **22 April 2026**, which has passed. From my understanding of the final rule **(verify the details with counsel)**, they:
  - require **separate parental consent** to disclose children's data to third parties (e.g. for advertising)
  - require a **written data retention policy**, published in the privacy notice, and forbid indefinite retention
  - require a **written information security program**
  - add **biometric identifiers** (e.g. face and voice prints) to the definition of personal information
  - add new approved VPC methods (e.g. knowledge-based questions, government ID with a face match, and a text-message method)
  - tighten safe-harbor program transparency
- **Feb 2026 policy statement.** The FTC issued a policy statement on 25 February 2026 limiting enforcement where mixed-audience or general-audience services collect children's data **solely to verify age** without first getting parental consent. **(verify its scope)**
- **Voice.** The FTC's 2017 enforcement policy statement says it won't take action when a child's voice recording is collected **solely to replace written words** (e.g. a search) and **deleted immediately**, with notice. The Amazon Alexa settlement (2023) shows the FTC's view of *retaining* children's voice data and transcripts. **(verify)**
- **What this means for the design:**
  - **The key question is whether a parent-entered profile is information collected "from a child".** If the parent types a nickname, age band and allergies into the parent's own account, that is plausibly collected **from the parent**. But a child tapping "done" on a task card on a device in Family Table mode could create persistent identifiers or activity data *from the child*. **Lawyer question 1.**
  - **"Directed to children" risk.** Pixel art, a talking pan, and kid quests are factors the FTC weighs (subject matter, visual content, animated characters, child-oriented activities). The whole app could be treated as **mixed audience**. That's manageable: age-screen, then apply COPPA to under-13s. But it must be designed deliberately. **Lawyer question 2.**
  - **Design to need little VPC:** no child accounts, no contact information, no free text, no photos or voice of the child, no third-party disclosure (in particular, **no child data to OpenRouter**), so the AI provider is not a third-party recipient of child data. If counsel still says VPC is needed, the **paid** path can use the monetary-transaction method (card-based VPC with a notice), and free families need another method. **Lawyer question 3.**
- **COPPA in schools.** The FTC has historically allowed schools to consent on parents' behalf for educational use only. The club kit avoids this entirely by having no student data.

### B.2 Other jurisdictions

| Law | What matters for Family Mode | Status |
|---|---|---|
| **California Age-Appropriate Design Code (AB 2273)** | Applies to under-18s "likely to access" a service: high-privacy defaults, DPIAs, no dark patterns, limits on profiling and geolocation | **Litigation, uncertain.** NetChoice v. Bonta: preliminary injunctions in 2023 and again on 13 Mar 2025. The Ninth Circuit issued a **mixed ruling on 12 Mar 2026** that leaves several key provisions enjoined. Sources disagree on what is enforceable now. **(verify current docket, 9th Cir. No. 25-2366)**. Design to its standards anyway; they match the UK code |
| **Other state children's codes and laws** | Maryland's Kids Code (2024), Vermont's (2025), and others. Under-18 data protections in New York's Child Data Protection Act. Washington's **My Health My Data Act** (consumer health data includes allergies; applies regardless of age). Texas SCOPE Act. App-store age-verification laws (Utah, Texas) | Varying effective dates and litigation. **(verify per launch state)** |
| **California SB 243 (companion chatbots)** | Safeguards for "companion chatbots", with specific protections for minors (break reminders, "not human" disclosure) and a private right of action. **In effect from 1 Jan 2026** | Is the Pan a "companion chatbot"? It's a task mentor, but with a persona. **Lawyer question 4.** Our "kids never talk to the AI" stance mostly sidesteps it |
| **UK Age Appropriate Design Code (Children's Code)** | Applies to services **likely to be accessed by under-18s**. That already includes **16–17-year-old account holders** today, not only Family Mode. 15 standards: best interests of the child, DPIA, **high privacy by default**, data minimization, no detrimental use, **no nudge techniques**, geolocation off, profiling off, parental controls transparency. The UK digital age of consent is 13 | In force (ICO). **Action needed for v1 as well** |
| **UK Online Safety Act** | User-to-user services must assess risk to children. **The Neighborhood Pantry is user-to-user**, so a children's risk assessment is likely needed if children can access the service. Children never touch the Pantry in this design; counsel should confirm that's enough | Child-safety duties in force since 2025 **(verify)** |
| **EU GDPR Art. 8** | For information-society services offered directly to a child, consent below the digital age of consent (**13–16, set by each member state**) must come from the holder of parental responsibility, with "reasonable efforts" to verify it | In force. **Art. 9** applies too: allergies are health data and need **explicit consent** from the parent for each child |
| **EU AI Act** | Art. 5 prohibits AI that exploits vulnerabilities due to age. Art. 50 requires transparency that users are interacting with AI (applies from Aug 2026 **(verify)**). Scripted lines aren't "AI interaction", but the adult-mode Pan is | Mostly met by design |
| **EU Digital Services Act Art. 28** | Online platforms accessible to minors must ensure a high level of privacy, safety and security. No profiling-based ads to minors | Relevant to the Pantry if offered in the EU **(verify)** |

### B.3 Recommended stance: AI and children

**Children never talk to the AI.** Concretely:

1. **Family Table mode** (on whenever any child profile is "in the kitchen"):
   - The Pan and the cooks speak **only scripted lines** marked `ai: never`: task instructions, safety cards, praise lines, timers, and the "Try It" ladder.
   - **Server STT is off.** The only voice input is a **fixed command grammar** recognised on the device ("next", "back", "repeat", "start timer", "pause"). It sends no audio and stores no audio.
   - **No free-text box** is shown.
   - **No AI photo reaction** for Family Table dishes by default. Cooks react with a **scripted line bank** per dish ("Haruka would like a word about how even those rice balls are"). The parent can choose to send a food-only photo for an AI reaction *in adult mode*, after the face check (B.4).
2. **The parent can step out** ("Grown-up question") to the normal adult Pan, as themselves. A banner says "Kids' mode paused". Anything they say is the adult's conversation, under adult rules. **Transcripts from turns taken while Family Table mode is on are not retained**, so a child's incidental voice isn't kept as conversation text. Spec §7.7 keeps transcripts for adults; this is the exception.
3. **No child identifiers in any prompt.** If an adult-mode prompt needs family context (e.g. planning a meal for four), children appear as "Helper 1 (age band 6–8)" with their **confirmed rule IDs**, never nicknames. The rules engine, not the AI, does the checking.
4. **No AI-written content is ever shown to a child** that hasn't been written and reviewed in advance.

*Why this design:* it removes the hardest COPPA questions (voice, free text, third-party disclosure to the AI provider) and the AI-companion questions (SB 243, the FTC 6(b) study), and it costs almost nothing, because spec §8 already makes play work without AI.

### B.4 Photos of children

- **Food-only photos.** In Family Table mode the camera shows a "plate frame" overlay and the line "Just the food, please. The Bureau doesn't file faces."
- **An on-device face check** runs before any upload. If a face is detected, the photo is **not uploaded**. The parent sees: "Looks like someone's in the shot. Retake, or keep it on this device only?" **Nothing about the face is stored or sent.** Counsel should confirm that transient on-device detection isn't biometric processing under the amended COPPA or state biometric laws (**lawyer question 5**). If it is, fall back to a warning plus the parent's confirmation.
- Spec §9 rules still apply: EXIF and GPS stripped, private by default, deleted with the account.
- **Family-book photos can stay on the device** (not synced) if the parent chooses.
- **No AI vision on any photo taken in Family Table mode** unless the parent chooses it in adult mode.
- **Use AI providers with zero data retention** for any photo (verify each OpenRouter provider's policy).

### B.5 What is stored about a child (complete list)

| Field | Purpose | Notes |
|---|---|---|
| `nickname` | Show "Jo's book" | Parent-chosen. Can be an emoji. Never sent to the AI |
| `age_band` | Task safety | 3–5, 6–8, 9–12 or 13–15. No birthday. The band is moved up by the parent (a prompt once a year, which the parent can dismiss) |
| `avatar_id` | Visual | From a preset sprite list. No uploads |
| Allergy and diet rules | Safety | **Entered and confirmed by the parent** with the full read-back and spell-back flow (§4.4, §7.6). Sealed like adult rules (column-level encryption). Severe rules need the parent's tap |
| Technique progress (tiers) | Kids' toolkit | Kid-scale techniques only |
| Family cook sessions | Book page | Which dish, which date, which tasks each helper did |
| Lineage entries | "Who taught whom" | Free-text *labels* typed by the parent for people outside the app ("Grandma Rosa"). Treated as the parent's data |
| `per_task_overrides` | The parent moved a task up or down a band | Kept for the book's safety record |

**Never stored about a child:** legal name, birthday, email, phone, school, location, photos of the child, voice or transcripts, free text from the child, **food intake, portions, "ate it", nutrition, body metrics, symptoms or journeys**, device identifiers tied to the child, or analytics events attributed to the child. Aggregate counts only, such as "Family Table sessions this week", tied to the household.

**Rights:** the parent can view, export (included in the parent's one-click export) and delete each child profile at any time, immediately. Deleting the parent account deletes the household's child profiles; if another adult remains in the household, the parent is asked first.

### B.6 Allergy rules per child

- Rules are created **only by an adult household member** with the standard read-back. The AI rule-expansion proposal is allowed (it's an adult's action, and free forever), but the child is referred to as "Helper 1".
- **Family `check`:** a Cook Together dish is checked against the **union of rules of everyone eating** (each child, plus each adult who has opted in to sharing rules for planning, M-10). Findings name the rule's *owner role* ("a helper's rule"), never an adult's private rule details without that adult's opt-in.
- **Severe child rules** (anaphylactic or allergy) show cross-contact notes on the **task cards** too ("wash hands after the peanut butter before helping with the bread").
- **Free forever:** per-child rules and family checks never check an entitlement. Extend the M2 free-forever invariant test.

### B.7 What needs a lawyer (questions to bring)

1. **Is a parent-entered child profile "collected from a child" under COPPA,** given that a child taps task cards on the parent's device in Family Table mode? What exactly makes us an operator with actual knowledge?
2. **Does Family Mode make the service "directed to children" or "mixed audience"** (pixel art, talking pan, kids' quests)? If mixed, what age screen is needed at sign-up, and how does the Feb 2026 FTC policy statement on age verification apply?
3. **Is VPC needed** for free families, and which method fits (card-based for paid families, and something else for free ones)? Wording and placement of the direct notice to parents. Retention policy text.
4. **Is the Pan a "companion chatbot"** under California SB 243, or similar laws, for its 16–17-year-old users and in adult mode?
5. **Is on-device face detection** (with nothing stored) biometric processing under amended COPPA, Illinois BIPA, Texas CUBI or Washington MHMDA?
6. **Health data:** explicit consent for children's allergy data under GDPR Art. 9 and Washington MHMDA. Does a parent's consent suffice, and how is it recorded?
7. **UK:** a Children's Code DPIA for the whole app (16–17-year-olds are already "children"); whether the Online Safety Act risk assessment covers the Neighborhood Pantry when children can't use it.
8. **EU:** Art. 8 digital age of consent per launch member state; DSA Art. 28 if the Pantry counts as an online platform.
9. **Product liability** for age-band safety task cards: terms, disclaimers, the "adult in charge" framing, and insurance.
10. **Gift memberships:** state gift-card laws (expiry, escheat, refund) and auto-renewal rules when a gift converts to a subscription. Recommend: **gifts never auto-renew.**
11. **School and library kits:** confirm that a kit with no student data doesn't trigger student-privacy laws (FERPA, California SOPIPA and similar state laws), and draft a simple facilitator agreement.

## C. Revenue

### C.1 Pricing

| Offer | Price | What's included | Notes |
|---|---|---|---|
| **Family Mode (free)** | $0 | 1 adult account plus up to 4 child profiles, per-child rules and family `check`, age-band safety tasks, Cook Together quests for every canon dish, Family Table ritual, "Try It" ladder, free printable family book, free Apprentice Papers | Safety and the canon are free (never-rules 1 and 10). A one-adult family is the entry point |
| **Household Guild (sliding scale)** | **$6 / $10 / $16 a month; $48 / $80 / $128 a year** | Up to **4 accounts aged 16+** and **6 child profiles**. Guild features for every account (voice, AI caps, packs). Shared plan, pantry and market list across accounts (M-10). **Seasonal Family Table packs** (themed family quests by season, e.g. a harvest supper). Supporter credit | Replaces the prior flat **$10/$80** with the same sliding-scale principle as the Guild. **$10 stays the standard.** Same features at every price. The purchaser must be 18+. 16–17-year-old members get a `household_member` entitlement |
| **Bureau Bursary for families** | Free Household Guild | Anyone who asks | As in the prior report |
| **Gift membership** | **Household Guild annual $80 or Guild annual $48** (gift cards at any sliding tier) | Bought by an adult, redeemed by an adult (18+) | **Gifts never auto-renew.** At the end of the year the recipient is asked once, without pressure. On sale all year, with no countdowns |
| **Print-on-demand family recipe book** | **≈ $29–45** hardcover (estimate; depends on the vendor's price and page count) | The family book, with lineage, nicknames and food photos | **We are the seller**, not an affiliate. Shown price = vendor cost + a stated margin (≈ $8–12, estimate) + shipping. The free PDF export always comes first. Nicknames only, no child photos |
| **Junior Kitchen Club kit** (Multiverse School) | **$99 / $249 / $399 per club per term, sliding scale** (estimate); free for libraries with a grant sponsor | Facilitator guide, printable age-banded task cards, safety cards, "Apprentice Papers", and a Household Guild seat for the facilitator | **No student accounts, no student data.** The facilitator runs it from their own account or from paper |

**How Family Mode changes Guild pricing:**
- The individual Guild is unchanged ($3/$6/$12, with the $6 vs. $8 test).
- The Household Guild becomes sliding and gains family content, so it moves from "a discount for flatmates" to the **main family product**.
- The household price at the standard tier ($10) is **1.67× the individual standard tier**. That's high enough to protect revenue when two parents would otherwise each subscribe, and low enough to read as a family deal (Duolingo's family plan sits at roughly 1.25× its individual plan, per third-party sources; **estimate**).

### C.2 Unit economics: Household Guild (estimates)

Assumptions: tier mix 30% / 55% / 15% at $6 / $10 / $16; 60% pay annually at about a third off; fees and refunds as in the prior report; **1.6 active adult accounts** per household at the prior blended cost of $0.88 each; child play ≈ $0.03 infra; 15% contributor share; bursary scaled from the prior report.

| Per paying household per month | $ |
|---|---|
| Nominal monthly price (mix) | 9.70 |
| Gross (with annual discount) | 7.76 |
| **Net** (after MoR fees ≈5% + $0.50 per transaction, and 2% refunds) | **7.00** |
| − Variable cost (1.6 adults × $0.88, plus kids $0.03) | −1.44 |
| − Contributor share (15%) | −1.05 |
| − Bursary allowance | −0.16 |
| **Contribution margin** | **≈ 4.36** (vs. **2.45** for an individual) |

### C.3 Impact on conversion and ARPU (scenarios, estimates)

Base case from the prior report: **80k MAU, 5% conversion**. **Assumption:** 30% of adult players have children under 16 at home (**estimate, no source; test it**), which makes 24k parent MAU.

| Scenario | Parent conversion | Of those, Household | Paying parents | Contribution / mo from parents | Less cannibalization* | **Δ vs. no Family Mode** | ARPPU (net) of parent payers |
|---|---|---|---|---|---|---|---|
| No Family Mode (base) | 5% | 0% | 1,200 | $2,940 | — | — | $4.02 |
| A: no conversion lift | 5% | 50% | 1,200 | $4,085 | −$370 | **+$0.8k** | $5.51 |
| B: modest lift | 7% | 60% | 1,680 | $6,040 | −$490 | **+$2.6k** | $5.81 |
| C: strong lift | 9% | 60% | 2,160 | $7,770 | −$640 | **+$4.2k** | $5.81 |

\*Cannibalization assumes 20–25% of households would otherwise have been two individual subscribers.

**Other lines (estimates, year 2):**

| Line | Assumption | Contribution / mo |
|---|---|---|
| Junior Kitchen Club kits | 30 clubs a term × 3 terms × ~$249, less ≈ 20% facilitator support | ≈ $1.5k |
| Gift memberships | ≈ 300 gifted Household annuals a year at $80, net of fees and costs | ≈ $1k (seasonal; overlaps with Household, so partly already counted) |
| Print-on-demand books | ≈ 200 books a year × ≈ $10 margin | ≈ $0.15k (small; a loyalty product, not a revenue line) |
| **New fixed cost** | Legal ($10–25k over 24 months), reviewers, content task splits | ≈ −$0.9k |

**Bottom line (estimate):** Family Mode adds roughly **+$2.5k to +$6k a month of net contribution** at the 80k-MAU scenario (central case **≈ +$4k**). That moves the blended plan from ≈$15.8k to roughly **$18–22k**: **about the studio target**. It also gives a new acquisition story ("cook together") that may bring in parents who aren't current players. That upside isn't counted, because there's no basis for estimating it.

**Sensitivity:**
- If fewer than about 15% of players are parents, Family Mode roughly breaks even after legal costs. That makes **test 2** (§E) decisive.
- If Household converts mostly from *two* individual payers, the gain shrinks by about a third, but stays positive because of the higher household margin.

## D. Changes needed to the spec and plans

| # | Change | Where | When |
|---|---|---|---|
| **1** | **New spec §19 Family Mode**, with: the design table in §1; "children never talk to the AI" (B.3); the child-data list (B.5); the photo stance (B.4); per-child rules and family `check` (B.6); the children's dark-pattern rules (§A); and "Try It" rewarding cooking, not eating | Spec §19 (new); cross-reference from §5, §7.0, §7.7, §9, §16, §17, §18 | Now (text only) |
| **2** | **Age rule in §1.2 and §16:** "Accounts are 16+. Paid plans and household ownership are 18+. Children under 16 take part only as **cook profiles** inside a household owned by an adult (18+). Profiles aren't accounts: no email, sign-in or birthday." Also update M-10's "Minors: the 16+ minimum still applies" | Spec §1.2, §15 Q4, §16; audit M-10 | Now |
| **3** | **Data model** (reserved in M5, built in M13): `households(id, name, owner_user_id → users)`; `household_members(household_id, user_id, role ∈ owner\|adult\|member16, rule_sharing boolean default false)`; `child_profiles(id, household_id → cascade, nickname, age_band ∈ '3-5'\|'6-8'\|'9-12'\|'13-15', avatar_id, created_by_user_id, created_at)` (no birthday, email or photo columns; a schema test asserts the exact column list, like `usage_events`); `child_rules(id, child_profile_id → cascade, sealed bytea)`; `child_technique_progress`; `family_cook_sessions(id, household_id, recipe_ref, date, participants jsonb of {member or child id, task ids})`; `book_lineage(id, household_id, teacher_label or member ref, learner ref, recipe_ref)`; `parental_consents(id, household_id, user_id, scope, notice_version, method, granted_at, revoked_at)`. **No table holds child intake or nutrition.** No M2 migration is needed: rules for children live in their own table, so no existing encrypted rows move | Spec §9 "Key entities"; M5 plan (reserve); M13 plan (build) | M5 / M13 |
| **4** | **Entitlements:** add kind `household_owner` (the purchaser) beside the existing `household_member`; add source `gift`; add a kind `club_facilitator` or source `school` for kit facilitators. Gifts carry `ends_at` and never renew | `apps/api/src/entitlements/entitlements.ts`, `plans/m2-api/step-2b.md` (follow-up); M11 launch / payments plan | M11–M13 |
| **5** | **Free-forever invariant extended:** child profiles, child rules, family `check`, age-band safety tasks and Cook Together for canon dishes never call `hasEntitlement`. Add to M2 Global Constraints and the e2e test in M13 | `plans/m2-api/README.md`; spec §16 "Free forever" | M13 (record now) |
| **6** | **Content format:** a per-recipe `family:` block in the lesson sidecar (`<name>.family.yaml`), mapping each step to tasks with `min_band`, `hazards: [knife\|heat\|oven\|hot_oil\|raw_meat\|sharp_tool\|appliance]` and `adult_only`. Kitchen-safety cards in `content/safety/` (`ai: never`). **CI hazard linter:** `hot_oil` is always `adult_only`; `knife` (other than a butter or nylon knife) and `heat` can't be assigned below `9-12`; `oven` is adult-only below `13-15`; every step with a hazard needs a reviewed safety card. **Bands are proposals for reviewers, not final** | `content/README.md`, `recipes/CONTRIBUTING.md`, a new validator in `packages/core` | M10 (format) / M13 |
| **7** | **Mentor: Family Table mode.** A session flag that restricts the agent to scripted triggers (`ai: never` for every line in this mode), disables server STT and every write tool except `check_off_task`, turns off transcript retention, and enables an on-device command grammar. Prompt-building strips child nicknames ("Helper N"). Agent tests: no AI call is made while the mode is on; no child identifier appears in any prompt | Spec §7.0, §7.6, §7.7, §8; M3/M7 mentor and voice plans (add the flag early so it's not retrofitted); M13 | Flag in M3/M7, feature in M13 |
| **8** | **Photos:** an on-device face check before upload in Family Table mode; device-only storage option; no AI vision by default in that mode | Spec §7.2, §9; M8 AI features; M13 | M13 |
| **9** | **Children's dark-pattern rules** added to the Monetization Charter and spec §16 never-rules (§A list) | Spec §16; prior report §C Charter | Now |
| **10** | **Neighborhood Pantry:** children never post or request; family tasks (labelling, portioning) live in Cook Together, not in the Pantry flow; posts never name helpers | Spec §18 | M11 (one line) |
| **11** | **Privacy (UK Children's Code)** applies to 16–17-year-olds already: high-privacy defaults and a DPIA for v1, not only for Family Mode | Spec §9; M12 launch hardening | **v1 (M12)** |

**Milestone:** **M13 Family Mode**, after M12 launch hardening. It depends on M5 (household reserved), M9 (Household Kitchen), M10 (content format and art) and M11 (payments).

**Must be in place before Family Mode launches:**
1. Written legal sign-off on §B.7 questions 1–9, a children's DPIA, a COPPA-style written retention policy and information-security program, and a direct notice to parents.
2. Every launch dish and basic with a reviewed `family:` split. Hazard linter green. Safety cards reviewed by a food-safety or child-nutrition educator.
3. Family Table mode agent tests passing (no AI calls, no child identifiers in prompts, no transcript retention).
4. Free-forever e2e test covering child rules and family `check`.
5. Parent controls: view, export and delete each child profile; consent record and revocation.
6. A playtest with 5–10 families (using the `game-playtesting` skill flow plus in-person observation) with zero safety concerns raised.

## E. Discovery-driven planning (McGrath)

**Reverse income statement.** For Family Mode to add ≈ $4k a month of contribution at 80k MAU, all of these must hold:
- ≥ 25% of players have under-16s at home
- parent conversion ≥ 7%
- ≥ 50% of paying parents choose Household at ≈ $10
- legal and compliance fixed cost ≤ $25k one-time
- the design needs no expensive VPC for free families
- ≥ 30 club kits a term

| # | Assumption (riskiest first) | If wrong… | Cheapest test | Cost / time | Pass threshold |
|---|---|---|---|---|---|
| 1 | **Families actually cook together with age-banded task cards, and it's safe and fun** | The feature is a novelty, or a safety risk | **Paper pilot:** print Cook Together cards (3 dishes plus 5 basics, reviewed bands) and give them to 10–15 Multiverse School families and staff. Collect a short parent survey and a 15-minute interview. **No app, no child data** | ~2 weeks; ~$300 printing and honoraria | ≥ 70% cook ≥ 2 dishes in 3 weeks; ≥ 60% "would do it weekly"; **zero** safety incidents or near-misses |
| 2 | **≥ 25% of players are parents of under-16s** | The revenue case shrinks below legal cost | Add one optional question to the prototype playtest sign-up and the pricing fake-door (prior report test 1): "Do children under 16 live with you?" | ~1 hour; $0 | ≥ 25% yes |
| 3 | **Parents will pay ≈ $10 for a Household Guild with family features** | Household ARPPU falls | Extend the prior fake-door: show the Household tiers ($6/$10/$16) with the family feature list to parents only, plus Van Westendorp | Included in prior test 1 | ≥ 50% of parent clickers pick Household; acceptable range includes $10 |
| 4 | **Compliance can stay light** (no VPC for free families; no child data collected "from" children) | Fixed cost and friction jump; free family tier may need a consent step | **2-hour scoping consult** with children's-privacy counsel using §B.7 | ~$1–2k | A written view on Q1–Q3; an estimate for the full review ≤ $25k |
| 5 | **"Children never talk to the AI" doesn't make the experience flat** | Kids get bored; parents want the Pan to talk to kids | In the paper pilot, have a facilitator *read* scripted Pan lines from a card deck (Wizard-of-Oz). Ask kids and parents what they missed | Included in #1 | ≥ 70% of parents rate scripted lines "enough"; requests for kids' AI chat are a minority |
| 6 | **Educators will buy a club kit** | The B2B2C line disappears | Offer the paper pilot kit to 3 librarians or after-school leaders the School knows, free for one term, in exchange for a price quote | ~3 weeks | ≥ 2 of 3 would pay ≥ $99 a term, or name a grant that would |
| 7 | **"Try It" reduces pressure rather than adding it** | Harm to children's relationship with food | Review the ladder copy with a child-nutrition professional (e.g. a pediatric dietitian) and 5 parents of picky eaters | ~1 week; honoraria | No reviewer flags pressure; parents describe it as "low pressure" |
| 8 | **Gift buyers exist (grandparents, relatives)** | The gift line is negligible | A "gift a Guild year" fake-door in December *aimed at adults*, with no countdown | At Guild launch | ≥ 2% of annual purchases are gifts in the first season |
| 9 | **Household doesn't mostly cannibalize two individual subscriptions** | ≈ ⅓ less gain | After launch, ask in Household checkout: "Were you both already paying members?" | At launch | ≤ 30% yes |

**Checkpoints:**
1. **After tests 1, 2 and 4 (≈ 30 days):** go / no-go on writing spec §19 in full and reserving the M5 tables. If the pilot shows safety concerns, change the bands first.
2. **At M12 launch hardening:** confirm counsel's full review is booked and the task-split format is in M10 content.
3. **3 months after Family Mode launches:** check parent share, Household mix and cannibalization against the reverse income statement before building print or expanding kits.

## F. Fit with the organization's and Liz's values

| Value | How Family Mode honours it |
|---|---|
| **Community** | Cooking together. The family book's lineage. Clubs in libraries and schools |
| **Social Justice** | Safety for every child is free. Sliding-scale household. Bursary. Free library kits with grant sponsors. No selling to kids |
| **Growth / Knowledge** | Kids' Technique Toolkit. Real skills taught by age |
| **Purpose** | "Passing it down" ties the game to why people cook |
| **Genuineness** | No pester power, no streaks, no dark patterns. Same features at every price |
| **Rationality** | Discovery-driven: paper pilot and legal scoping before engineering |

**Hedgehog (Collins):** Family Mode is the same hedgehog, *a respectful, safe, funny cooking apprenticeship*, applied to the most natural unit of cooking: the household.

---

## Sources (law and regulation, checked 2026-11-09)

- COPPA amendment dates and the Feb 2026 policy statement: [Hunton, "COPPA Rule Amendment Compliance Deadline Approaches"](https://www.hunton.com/privacy-and-cybersecurity-law-blog/coppa-rule-amendment-compliance-deadline-approaches); [Finnegan, "COPPA's Amended Rule Is Now in Full Effect"](https://www.finnegan.com/en/insights/articles/coppas-amended-rule-is-now-in-full-effect-what-operators-need-to-know.html); [National Law Review, "Amendments to FTC COPPA Rule Now in Effect"](https://natlawreview.com/article/amendments-ftc-coppa-rule-now-effect)
- California AADC litigation: [Cooley, "NetChoice v. Bonta: Ninth Circuit Narrows Injunction" (Mar 2026)](https://www.cooley.com/news/insight/2026/2026-03-30-netchoice-v-bonta-ninth-circuit-narrows-injunction-against-californias-ageappropriate-design-code-act); [Holland & Knight, "Ninth Circuit Issues Mixed Ruling" (Mar 2026)](https://www.hklaw.com/en/insights/publications/2026/03/ninth-circuit-issues-mixed-ruling-on-california-age-appropriate-design-code-act); [Hunton, AG appeal](https://www.hunton.com/privacy-and-cybersecurity-law-blog/california-ag-appeals-decision-blocking-enforcement-of-age-appropriate-design-code-act)
- AI chatbots and minors: [DLA Piper, FTC 6(b) orders on AI chatbots (Sept 2025)](https://www.dlapiper.com/en-qa/insights/publications/2025/09/ftc-ai-chatbots); [Kelley Drye, "AI Chatbots Face Rising Legal and Legislative Scrutiny"](https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/ai-chatbots-face-rising-legal-and-legislative-scrutiny); [CLA Privacy Law, "Regulatory Focus on AI Companion Chatbots"](https://calawyers.org/privacy-law/regulatory-focus-on-ai-companion-character-chatbots/)
- The other legal points (the content of the COPPA amendments, the 2017 voice policy, the UK Children's Code and Online Safety Act, GDPR Art. 8, the EU AI Act and DSA, state laws) come from background knowledge and were **not re-checked this session**. Each is marked **(verify)** where it matters.

## Appendix: assumptions register

| Assumption | Value used | Confidence |
|---|---|---|
| Share of players with under-16s at home | 30% | **Low.** Test 2 |
| Parent conversion with Family Mode | 5% / 7% / 9% scenarios | Low |
| Household share of paying parents | 50–60% | Low. Test 3 |
| Household tier mix | 30/55/15 at $6/$10/$16; 60% annual | Low |
| Active adult accounts per household | 1.6 | Low. Instrument |
| Child-play AI cost | ≈ $0 (scripted) | High, by design |
| Cannibalization (households replacing two individual subscriptions) | 20–25% | Low. Test 9 |
| Legal and compliance one-time cost | $10–25k | Low. Get quotes (test 4) |
| Task-split content cost | ≈ $150 per dish | Low |
| Club kits | 30 a term at ≈ $249 average | Low. Test 6 |
| Print-on-demand margin | ≈ $8–12 a book | Low. Check vendor pricing |
| Duolingo family vs. individual price ratio | ≈ 1.25× | Estimate, from third-party prices in the prior report |

*The household unit economics and scenario table were computed with a small script using the prior report's fee, refund, cost and revenue-share assumptions. Re-run them when real data exists.*
