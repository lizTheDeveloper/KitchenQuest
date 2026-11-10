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
export function renderTrail(entry: TrailEntry, opts: { now: () => Date; onUndo(): void; onEdit(): void }): HTMLElement;   // "📒 Logged: …", "🛡 Stamped: …", "🗓 Inked: …", "🫙 Pantry: …"
// mentor/consent-card.ts
export function renderConsentCard(purpose: 'health_data' | 'ai_health', opts: { form: BureauForm; notice: { version: string; text: string };
  onAgree(): void; onDecline(): void }): HTMLElement;   // the notice text verbatim in a [data-content] element; buttons from the form
// mentor/panel.ts
export function mountMentorPanel(root: HTMLElement, opts: { mode: MentorMode; backend: MentorBackend; dialogue: Dialogue; writer: CardWriter;
  engine: ScriptedEngine; client: ApiClient; forms: Record<string, BureauForm>; store: PlayerStore; reducedMotion: () => boolean; now: () => Date }): MentorPanel;
export interface MentorPanel { /* M3 members */ show(reply: PanReply): void; readonly turn: number }   // show() is used by intake (Step 11)
```
- AI backend `reply`:
  - When the text is a strict yes/no (`classifyTurn`) and `ctx.openCards` from the previous turn are **local**, answer through `engine.reply` (Step 9). A strict undo goes by the **newest live trail entry** (pre-flight C36): `origin: 'local'` → the writer, `origin: 'server'` → `client.mentorTurn`. Everything else → `client.mentorTurn`.
  - `route` `ai` or `deterministic` → map `parts`:
    - `line` → `dialogue.say(trigger, vars)`
    - `text` → never sent in M4 (Ruling R9): the mentor shows only scripted lines and cards, never model text. A `text` part from the server is dropped and not rendered (a dev-mode warning). The "AI" tag and `ai.text` rendering wait for the grounded Q&A milestone.
    - `choices` / `consent` → items
    - `cards` → `ServerCardView`s, and `actions` pass through
  - `route: 'scripted'`, by notice:
    - `ai_unavailable` → `mentor.ai_unavailable` (pre-flight C33), then `engine.reply(text, ctx)`
    - `rate_limited` → `rate_limited`, then the engine
    - `needs_ai_health` → the engine, plus an `ai_health` consent item once (`aiHealthOffered` set in the store)
    - `ai_off` → the engine only
  - Fetch status 0, 5xx, 429 or invalid JSON → `mentor.ai_unavailable` + `engine.reply`. The backend keeps the turn **in memory only** (no store key, no storage: N-4) and retries it once by itself, after 5 s or on the next `online` event, whichever is first (spec §7.5 "queues the request, and retries", pre-flight C23). The retry's reply is shown only when it adds something the scripted reply didn't (a server card; never model text, R9). If the retry fails too, the panel shows `ai.try_again` and a "Try again" button.
  - 401 → `refreshAccount`, then the engine.
- Panel:
  - Each reply renders its items in order, then its cards.
  - A rule card uses `forms[card.form]` and shows ingredient, spelled (severe only), severity words and "This covers".
  - When `severityUnclear`, a labelled `<select>` (Severe allergy · Allergy · Intolerance · Preference, default Severe allergy) feeds `edits.severity`.
  - Meal, profile and pantry cards use `meal_log`, `profile` (Step 2, pre-flight C38) and `pantry`. A profile card shows only the fields its patch sets. Buttons use the form's labels; a missing decline shows "Not now".
  - Confirm → `writer.confirm(view, 'tap', edits)`. While it is pending, both buttons are disabled. Success replaces the card with its trail entry and plays the stamp (skipped with reduced motion). `tap_required`, `consent_required` and `closed` keep or close the card as their items say.
  - A server card past `expiresAt` renders disabled with "This card has expired. Tell the Pan again."
  - The trail's Undo button lives until `undoUntil` → `writer.undo(entry)`. Its **Edit** control (spec §7.0 "tap it to edit or undo", pre-flight C24): for rules it navigates to `#/rules`; for other kinds, within the window, it undoes and re-shows the same card (a new local card built from the old one) for correction; after the window it is hidden for meals and pantry and opens Settings for profile.
  - Choices render as buttons → `engine.cardFromChoice`.
  - A consent item → `renderConsentCard` with the notice from M3's `client.consents()` (`data.notices[purpose]`). Agree → `grantConsent(purpose, version)`. Decline → nothing else happens; play continues.
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
test('a failed fetch keeps the text in memory only, retries once after 5 s, then offers Try again', ...);   // fake clock; 2 mentorTurn calls; storage.setItem never called with the text
test('undo goes by the newest live trail entry: local → writer, server → /mentor/turn', ...);
test('a strict yes for a local card never reaches the server', ...);
test('a text part from the server is never shown (Ruling R9: only scripted lines and cards)', ...);
// cards-view.test.ts
test('a severe rule card shows the spelling and has no confirm on Enter in the text box', ...);
test('an unclear severity offers the picker, defaulting to Severe allergy', ...);
test('an expired server card is disabled', ...);
test('trail Undo disappears at undoUntil', ...);   // fake clock
test('trail Edit on a meal undoes it and re-shows the card', ...);
// panel.test.ts
test('family table: no text box; show() with a card throws in dev', () => {
  expect(() => panel.show({ items: [], cards: [card], intents: [], actions: [], notice: null })).toThrow(/Family Table/);
});
test('family table: with the production flag, show() drops the cards and renders the lines', ...);   // import.meta.env.PROD stubbed true via vi.stubEnv
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

**Carry from Step 2 review:** `intake.allergies.followup` ("Stamped… / Saved…") fires only after a confirmed write; `rule.readback` lines ending "Is that right?" on a severe card must be followed by `rule.tap_needed` and never accept a typed yes.

**Ruling R9 (Step 7 fix round 4):** the game shows only scripted lines and cards from the mentor, never model text. `POST /mentor/turn` never returns a `text` part, and the panel must not render one if it arrives.
