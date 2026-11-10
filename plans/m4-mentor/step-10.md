# Step 10 — Game: cards in the panel, the AI backend, trail and undo

The panel shows cards (spec §7.6b.3: "The on-screen card is the record") and the trail of writes with undo (§7.0). The AI backend sends turns to the server, and on any failure, cap or missing consent it hands the same text to the scripted engine, so the player always gets an answer and can always stamp.

**Files:**
- Create: `apps/game/src/mentor/ai-backend.ts` (+ test), `apps/game/src/mentor/cards-view.ts` (+ test), `apps/game/src/mentor/consent-card.ts` (+ test)
- Modify: `apps/game/src/mentor/panel.ts` (+ `panel.test.ts`), `apps/game/src/mentor/index.ts` (backend choice), `apps/game/src/styles/components.css` (card and trail styles from the Bureau form slip)
- Test: `apps/game/e2e/mentor.e2e.test.ts` (extend)

**Interfaces:**
- Consumes: Step 9 (`ScriptedEngine`, `CardWriter`, `PanReply`, `CardView`, `TurnContext`, client methods); M3 (`showBureauForm` styles, `contentText`, `BureauForm`, `forms.yaml` via compiled content).
- Produces:
```ts
// mentor/ai-backend.ts
export function createAiBackend(deps: { client: ApiClient; engine: ScriptedEngine; dialogue: Dialogue; now: () => Date;
  screen: () => TurnRequest['screen']; intakeStep: () => IntakeStep | null }): MentorBackend & { readonly conversationId: string | null };
// mentor/cards-view.ts
export function renderCard(view: CardView, opts: { forms: Record<string, BureauForm>; now: () => Date;
  onConfirm(edits?: { severity?: Severity }): void; onReject(): void }): HTMLElement;
export function renderTrail(entry: TrailEntry, opts: { now: () => Date; onUndo(): void }): HTMLElement;   // "📒 Logged: …", "🛡 Stamped: …", "🗓 Inked: …", "🫙 Pantry: …"
// mentor/consent-card.ts
export function renderConsentCard(purpose: 'health_data' | 'ai_health', opts: { form: BureauForm; notice: { version: string; text: string };
  onAgree(): void; onDecline(): void }): HTMLElement;   // the notice text verbatim in a [data-content] element; buttons from the form
// mentor/panel.ts
export function mountMentorPanel(root: HTMLElement, opts: { mode: MentorMode; backend: MentorBackend; dialogue: Dialogue; writer: CardWriter;
  engine: ScriptedEngine; client: ApiClient; forms: Record<string, BureauForm>; store: PlayerStore; reducedMotion: () => boolean; now: () => Date }): MentorPanel;
export interface MentorPanel { /* M3 members */ show(reply: PanReply): void; readonly turn: number }   // show() is used by intake (Step 11)
```
- AI backend `reply`:
  - When the text is a strict yes/no/undo (`classifyTurn`) and `ctx.openCards` from the previous turn are **local**, answer through `engine.reply` (Step 9). Otherwise call `client.mentorTurn`.
  - `route` `ai` or `deterministic` → map `parts`:
    - `line` → `dialogue.say(trigger, vars)`
    - `text` → `Said { trigger: 'ai.text', text, ai: 'allowed' }`, rendered with a visible "AI" tag and the `disclaimers.ai_answers` text as its accessible description
    - `choices` / `consent` → items
    - `cards` → `ServerCardView`s, and `actions` pass through
  - `route: 'scripted'`, by notice:
    - `ai_unavailable` → `ai_unavailable`, then `engine.reply(text, ctx)`
    - `rate_limited` → `rate_limited`, then the engine
    - `needs_ai_health` → the engine, plus an `ai_health` consent item once (`aiHealthOffered` set in the store)
    - `ai_off` → the engine only
  - Fetch status 0, 5xx, 429 or invalid JSON → `ai_unavailable` + `ai.try_again` + `engine.reply`. The panel keeps the text for a "Try again" button **in memory only**: no store key, no storage (N-4).
  - 401 → `refreshAccount`, then the engine.
- Panel:
  - Each reply renders its items in order, then its cards.
  - A rule card uses `forms[card.form]` and shows ingredient, spelled (severe only), severity words and "This covers".
  - When `severityUnclear`, a labelled `<select>` (Severe allergy · Allergy · Intolerance · Preference, default Severe allergy) feeds `edits.severity`.
  - Meal, profile and pantry cards use `meal_log`, `schedule` and `pantry`. Buttons use the form's labels; a missing decline shows "Not now".
  - Confirm → `writer.confirm(view, 'tap', edits)`. While it is pending, both buttons are disabled. Success replaces the card with its trail entry and plays the stamp (skipped with reduced motion). `tap_required`, `consent_required` and `closed` keep or close the card as their items say.
  - A server card past `expiresAt` renders disabled with "This card has expired. Tell the Pan again."
  - The trail's Undo button lives until `undoUntil` → `writer.undo(entry)`.
  - Choices render as buttons → `engine.cardFromChoice`.
  - A consent item → `renderConsentCard` with the notice from `client.listConsents()`. Agree → `grantConsent(purpose, version)`. Decline → nothing else happens; play continues.
  - While a turn is pending: `aria-busy` on the bubbles, a polite live status "The Pan is thinking…", and Send disabled. Enter in the text box never activates a card button.
  - Family Table mode: no text box (M3), no cards, no consent items, and `show()` refuses cards (throws in dev, drops them in prod) (§19).
- `mountMentor` builds the backend from the store, and rebuilds it when `account` or `settings.aiMentor` changes:
  - `familyTable` → scripted.
  - Signed in and `aiMentor` → AI.
  - Otherwise → scripted.

- [ ] **10.1 Write the failing tests:**
```ts
// ai-backend.test.ts (fake client)
test('a scripted route runs the engine on the same text, after the notice line', ...);   // needs_ai_health + "I'm allergic to sesame" → local severe card
test('a failed fetch keeps the text for Try again in memory only', ...);                 // storage.setItem never called with the text
test('a strict yes for a local card never reaches the server', ...);
test('model text is shown with the AI tag', ...);
// cards-view.test.ts
test('a severe rule card shows the spelling and has no confirm on Enter in the text box', ...);
test('an unclear severity offers the picker, defaulting to Severe allergy', ...);
test('an expired server card is disabled', ...);
test('trail Undo disappears at undoUntil', ...);   // fake clock
// panel.test.ts
test('family table: no text box, show() drops cards', ...);
// mentor.e2e.test.ts (signed out, AI off unless noted; /api/** mocked)
test('AI off: say an allergy, get a 27-B card, a typed yes asks for a tap, a tap stamps it, and the dish is blocked', async () => {
  // type "I'm allergic to coconut" → card shows 'C-O-C-O-N-U-T'; type 'yes' → text of rule.tap_needed and no stamp; click 'Stamp it ✔' → 'Stamped' trail;
  // #/recipe/india/kerala/parippu → blocked (M3's severe-coconut fixture), with the allergy disclaimer
});
test('AI on: a server card is confirmed with exactly one POST { channel: "tap" } on a double click', ...);
test('AI down (503): the Pan says so, answers from the script, and offers Try again', ...);
test('family table: no textbox, no /api/mentor request', ...);
test('cards pass axe and keep focus order', ...);   // expectNoA11yViolations with a rule card and a trail entry open
```
- [ ] **10.2 Run** `npm test -w @kitchenquest/game -- mentor` and `npm run test:e2e -w @kitchenquest/game -- e2e/mentor.e2e.test.ts` → FAIL.
- [ ] **10.3 Implement.**
- [ ] **10.4 Run** the game unit, e2e and typecheck commands → PASS.
- [ ] **10.5 Commit** `feat(game): proposal cards, write trail with undo, AI backend with scripted fallback`
