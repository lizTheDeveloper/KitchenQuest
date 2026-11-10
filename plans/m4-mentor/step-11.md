# Step 11 — Game: Form 1-A intake, consent and disclosure cards, rules screen, age screen, settings

Spec §13 M4: "Onboarding is an interview in text."

The interview is scripted first:
- The Pan asks with the written `intake.*` lines.
- The answer is parsed by core, and any card it yields is stamped like any other.
- Only an answer code can't parse goes to the AI, when it is available.

Allergies come after a tap-based consent card (C-17), and every question can be skipped. This step also adds:
- the rules screen, which is the form fallback for §7.5 and the place to clear `rulesUnreadable`
- the AI disclosure (C-16)
- the neutral age screen (C-39)
- the AI section in Settings

**Files:**
- Create: `apps/game/src/mentor/intake.ts` (+ test), `apps/game/src/rules/rules-screen.ts`, `apps/game/src/rules/rule-form.ts` (+ test), `apps/game/src/settings/mentor-section.ts`, `apps/game/src/auth/age-screen.ts` (+ test)
- Modify: `apps/game/src/shell/router.ts` (+ test: `{ name: 'rules' }` ↔ `#/rules`), `apps/game/src/shell/app.ts` (register the screen; start intake on first open), `apps/game/src/settings/settings-screen.ts`, `apps/game/src/auth/verify-page.ts` (the age screen replaces M3's "I'm 16 or older" checkbox), `apps/game/e2e/signin.e2e.test.ts`
- Test: `apps/game/e2e/intake.e2e.test.ts`, `apps/game/e2e/rules.e2e.test.ts`

**Interfaces:**
- Consumes: Steps 9–10 (`ScriptedEngine`, `CardWriter`, `MentorPanel.show`, `renderConsentCard`, `renderCard`), Step 1 (`parseWeekdays`, `parseCount`, `parseRuleStatement`, `parsePantryAdds`, `buildRuleCard`, `buildProfileCard`, `buildPantryCard`), M3 (`activeRules`, `PlayerStore`, `registerScreen`, `showBureauForm`).
- Produces:
```ts
// mentor/intake.ts
export const INTAKE_ORDER: readonly IntakeStep[];   // ['market_day', 'meals_per_week', 'region', 'allergies', 'pantry']
export interface Intake { start(): void; answer(text: string): Promise<PanReply>; skip(): PanReply; readonly step: IntakeStep | 'done' | null; readonly expecting: 'answer' | 'more_rules' | 'consent' | null }
export function createIntake(deps: { panel: MentorPanel; engine: ScriptedEngine; ai: MentorBackend | null; store: PlayerStore; client: ApiClient;
  writer: CardWriter; dialogue: Dialogue; signedIn: () => boolean }): Intake;
export function parseIntakeAnswer(step: IntakeStep, text: string, deps: { graph: IngredientGraph; ruleTerms: RuleTerm[] }):
  { kind: 'card'; card: ProposalCard } | { kind: 'none' } | { kind: 'done' } | { kind: 'skip' } | { kind: 'unparsed' } | { kind: 'reply'; reply: RuleCardResult };
// rules/rule-form.ts — the form fallback (no AI, no conversation)
export function mountRuleForm(el: HTMLElement, opts: { graph: IngredientGraph; ruleTerms: RuleTerm[]; onCard(card: RuleCard): void }): () => void;
// auth/age-screen.ts
export type AgeAnswer = 'ok' | 'under' | 'ask_birthday';
export function ageFromYear(birthYear: number, thisYear: number): AgeAnswer;   // diff ≥ 17 → ok; 16 → ask_birthday; < 16 → under
export function mountAgeScreen(el: HTMLElement, opts: { thisYear: number; onOk(): void; onUnder(): void }): void;
// settings/mentor-section.ts
export function mountMentorSection(el: HTMLElement, opts: { store: PlayerStore; client: ApiClient; forms: Record<string, BureauForm> }): () => void;
```
- Intake:
  - Start on first open, when `intake.step === null`, standard mode, after `greet.first_ever`. The panel says `intake.open`, shows the Form 1-A checklist (`forms.intake`, one tick per stamped field), and asks each step's `intake.<step>.ask`. `intake.step` is persisted after each step.
  - For each answer, `parseIntakeAnswer`:
    - `market_day` → `parseWeekdays` → a profile card with `marketDays`.
    - `meals_per_week` → `parseCount` → `mealsPerWeek`.
    - `region` → up to 80 characters. With a comma, `country` is the last part and `region` the rest. Without one, `country` is the text and `region` is null.
    - `allergies`:
      - `none|no|nothing|nope|that's all|that's it|no allergies` → `intake.allergies.none`, or `done` once a rule has been stamped.
      - Otherwise `parseRuleStatement`, falling back to the whole answer as one term → `buildRuleCard`.
      - After each stamp → `intake.allergies.followup`, and stay on the step.
    - `pantry` → `parsePantryAdds`, with the whole answer split on commas as a fallback.
    - `skip|not now|later|pass` → `intake.skip`, then the next step.
  - When an answer is `unparsed`:
    - With the AI backend available, it sends the answer as a turn with `intakeStep` set. The server's tools make the card (Step 7).
    - Otherwise the Pan says the step's re-ask (`schedule.bad_time` for times, `didnt_understand` otherwise) and shows chips: weekday buttons, 1–7, or Skip.
  - A stamped card → the step's `intake.<step>.followup` with its var (`day`, `count`, `region`, `items`), then the next ask.
  - After `pantry`, `intake.complete`, then `intake.notifications` is **not** shown (reminders are M9). `intake.step = 'done'`.
  - **Consent before allergies (C-17):** when signed in and `health_data` has no current grant (`listConsents`), the allergies step first shows `renderConsentCard('health_data', …)`. Declining → `intake.skip` and the next step; onboarding completes without rules (spec §6). Signed out, the rule card footnote reads "*Kept on this device only." and no consent card is shown.
  - Family Table mode never starts the intake.
- AI disclosure (C-16): the first time the panel opens in standard mode with `aiDisclosureSeen === false`, a plain notice bubble shows `disclaimers.ai_characters` verbatim with a "Got it" button that sets the flag. Settings shows the same text, always.
- Rules screen (`#/rules`, h1 "Your rules"):
  - It lists `activeRules`: name(s) from the graph, the severity words, "on this device" or "on your account", and a Remove button. Remove opens the `rule_void` form. Severe rules first show `rule.void_confirm` in the form's lead, and removal needs the form's own "Remove" tap. Then `deleteRule` or a store removal, then `rule.voided`.
  - "Add a rule" → `mountRuleForm`: an ingredient search over `graph.search` plus rule-term phrases, then a severity select with no preselection (an empty choice defaults to Severe allergy, said on screen), then the same `renderCard` 27-B card → `writer.confirm(…, 'tap')`.
  - When `rulesUnreadable`, a banner shows `RULES_UNREADABLE_MESSAGE` and a button "These are all my rules", which calls `store.confirmRules(currentList)`.
  - For an `invalid` state, each bad rule shows "This rule names an ingredient the ledger doesn't know any more." and Remove.
  - The screen works with the AI off and when signed out.
- Age screen (C-39; replaces M3 Step 11's checkbox on 400 `age_confirmation_required`):
  - h2 "Before we make your account". Label "What year were you born?" on a `<select id="birth-year">` whose first option is "Choose a year" (empty, selected), then every year from this year back 100 years. There is no other default.
  - `ok` → enable "Create my account" → `verify(token, true)`.
  - `ask_birthday` → the radio question "Have you had your birthday yet this year?" (Yes → ok, No → under).
  - `under` → replace the form with "Kitchen Quest accounts are for people aged 16 and over. You can still play on this device without an account." and a link to `/#/kitchen`. The form cannot be shown again on that page load.
  - The year is never sent, stored, logged or put in the URL. `[lawyer]` per C-39.
- Settings → "The Pan":
  - The disclosure text.
  - "Talk to the Pan's AI" (`settings.aiMentor`).
  - When signed in, "Let the AI see my allergies, rules and meals" (grant or withdraw `ai_health`, with the notice shown on grant).
  - "Forget my conversations with the Pan" → a confirm modal → `forgetConversations()` → `forget.done`.

  Withdrawing is one tap, as easy as granting (P-4).

- [ ] **11.1 Write the failing tests:**
```ts
// intake.test.ts (AI off)
test.each([['market_day', 'Saturdays usually', { kind: 'card', card: { kind: 'profile', patch: { marketDays: [6] } } }],
           ['meals_per_week', 'maybe four', { kind: 'card', card: { patch: { mealsPerWeek: 4 } } }],
           ['region', 'Pacific Northwest, USA', { kind: 'card', card: { patch: { region: 'Pacific Northwest', country: 'USA' } } }],
           ['allergies', 'none', { kind: 'none' }], ['allergies', 'severe peanut allergy', { kind: 'card', card: { kind: 'rule', severe: true } }],
           ['pantry', 'rice, beans and eggs', { kind: 'card', card: { kind: 'pantry' } }],
           ['market_day', 'whenever the fridge echoes', { kind: 'unparsed' }], ['region', 'skip', { kind: 'skip' }]])
  ('%s: %s', ...);
test('signed in without health_data: the consent card comes before intake.allergies.ask; declining skips to pantry', ...);
test('intake completes with every step skipped', ...);   // step === 'done'
test('an unparsed answer goes to the AI with intakeStep when available', ...);
test('the AI fails mid-intake (503, then rate_limited): the Pan re-asks with chips and the interview still completes', ...);   // Review Focus 3
// age-screen.test.ts
test.each([[2000, 2026, 'ok'], [2010, 2026, 'ask_birthday'], [2011, 2026, 'under'], [2009, 2026, 'ok']])('born %i in %i → %s', ...);
// rule-form.test.ts
test('search → pick → severity → 27-B card; an empty severity is Severe allergy', ...);
// intake.e2e.test.ts
test('AI off and signed out: the whole Form 1-A interview by typing, with every stamp on screen', ...);   // checklist ticks 5/5; localProfile and localPantry set; a rule on the device
test('signed in: the consent card is a tap; declining still completes onboarding', ...);   // POST /api/me/consents only after the tap, body method 'tap'
test('the AI disclosure shows once, and always in Settings', ...);
// rules.e2e.test.ts
test('the rules screen adds, removes (a severe one needs the Remove tap) and clears rules-unreadable', ...);
test('it works with the AI off and the API down', ...);   // /api/** → abort; signed out
// signin.e2e.test.ts (extend)
test('age screen: no year preselected; under-16 gets no account and the year is never sent', ...);   // verify request bodies never contain the year; localStorage unchanged
```
- [ ] **11.2 Run** `npm test -w @kitchenquest/game -- intake age rule-form router` and the three e2e files → FAIL.
- [ ] **11.3 Implement.**
- [ ] **11.4 Run** the full game unit and e2e suites and the typecheck → PASS.
- [ ] **11.5 Commit** `feat(game): Form 1-A intake by conversation, consent and AI disclosure cards, rules screen, neutral age screen`
