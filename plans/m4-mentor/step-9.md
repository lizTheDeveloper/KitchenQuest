# Step 9 — Game: store and rules carry-overs, API client, scripted engine with cards

This step builds the client half of the cards and the path that always works: no AI, no network, no account. The scripted engine uses the same core functions as the server. Its cards are written through the M2/M5 REST routes when the player is signed in, or to the device store when they are signed out. It also absorbs M3's carry-overs (`.superpowers/sdd/README-m3-game/progress.md`, Task 6):
- Clearing `rulesUnreadable` needs two updates while conflict versions are in memory.
- Rules errors need text a player can understand.

It also carries a controller ruling on M3 Step 11's account refresh: `GET /rules` answering 5xx fails closed (`accountRules = null`, so every dish shows ❓), while 429 and offline keep the cached copy.

**Pre-flight:** M3 Step 11 (`apps/game/src/api/{client,account,types}.ts`, `auth/verify-page.ts`, as on `claude/m3-game` at 9f77cb3) is merged (README gate). Names below are M3's real ones: `consents()`, `grantConsent(purpose: ConsentPurpose, noticeVersion)`, `healthConsent(c)`, `Consents`, `ConsentRecord`, `refreshAccount`, `signOutPending`.

**Files:**
- Modify: `apps/game/src/state/store.ts` (+ `store.test.ts`), `apps/game/src/recipes/rules.ts` (+ `rules.test.ts`) and its callers' copy (`card-model.ts`, `card-view.ts`), `apps/game/src/api/types.ts` (re-export core protocol types), `apps/game/src/api/client.ts` (+ `client.test.ts`), `apps/game/src/api/account.ts` (+ `account.test.ts`: the 5xx ruling), `apps/game/src/shell/router.ts` (+ test: `{ name: 'rules' }` ↔ `#/rules`, so this step's card links resolve; the screen is an M3-style placeholder `<h1>Your rules</h1>` until Step 11)
- Create: `apps/game/src/mentor/scripted.ts` (+ test), `apps/game/src/mentor/writer.ts` (+ test), `apps/game/src/mentor/reply.ts` (types)
- Modify: `apps/game/src/mentor/backend.ts` (+ `backend.test.ts`): `createScriptedBackend` becomes a thin wrapper over the engine
- Modify: `apps/game/src/mentor/panel.ts` (+ `panel.test.ts`) and `apps/game/src/mentor/index.ts`, **minimally** (pre-flight C9), so this step's gate passes with the new `MentorBackend`: the panel passes `{ turn, openCards: [], intakeStep: null, signedIn }`, renders `PanReply.items` of kind `said` as bubbles, and ignores everything else. Step 10 adds cards.

**Interfaces:**
- Consumes: Step 1 (core mentor toolkit and protocol), Step 2 (compiled `ruleTerms`, new triggers), M3 (`PlayerStore`, `Dialogue`, `Said`, `ApiClient`, `activeRules`, `refreshAccount`), Step 8 routes (shapes only; tests use a fake `fetch`).
- Produces:
```ts
// state/store.ts
export interface LocalProfile { marketDays: number[]; mealsPerWeek: number | null; country: string | null; region: string | null; mealWindows: { name: MealSlot; start: string; end: string }[] }
export interface PlayerState {   // + these keys (absent → default; present with the wrong shape → corrupt, as M3)
  localProfile: LocalProfile | null; localPantry: (PantryItem & { id: string })[];
  intake: { step: IntakeStep | 'done' | null };          // null = not started
  aiDisclosureSeen: boolean; aiHealthOffered: boolean;
  settings: PlayerSettings & { aiMentor: boolean };       // default true
}
export interface PlayerStore {   // + one method
  /** Replace device rules with `rules` and clear rulesUnreadable in ONE update. This write is authoritative for localRules:
   *  the rebase does not merge this tab's in-memory rule versions back in (toolkit is still merged). */
  confirmRules(rules: Rule[]): PlayerState;
}
// recipes/rules.ts
export type RulesState =
  | { status: 'ready'; rules: Rule[]; source: 'device' | 'account' }
  | { status: 'error'; reason: 'unreadable' | 'invalid' | 'account_not_loaded'; message: string; problems: string[] };   // message is player copy; problems never shown on a card
export const RULES_UNREADABLE_MESSAGE: string;
export const RULES_INVALID_MESSAGE: string;
export const ACCOUNT_NOT_LOADED_MESSAGE: string;   // M3 Step 11's text, kept verbatim and now exported (signed in with accountRules === null: fail closed)
// api/client.ts — added to M3's ApiClient (pre-flight C11: consents() and grantConsent() already exist and are used as they are)
mentorTurn(req: TurnRequest): Promise<ApiResult<TurnResponse>>;
confirmProposal(id: string, edits?: { severity?: Severity }): Promise<ApiResult<ConfirmResponse>>;   // body { channel: 'tap', edits? } — the type has no other channel
rejectProposal(id: string): Promise<ApiResult<{ parts: ReplyPart[] }>>;
undoWrite(id: string): Promise<ApiResult<{ parts: ReplyPart[] }>>;
forgetConversations(): Promise<ApiResult<null>>;
withdrawConsent(purpose: ConsentPurpose, healthData?: 'delete' | 'keep'): Promise<ApiResult<null>>;   // DELETE /me/consents/:purpose
createMeal(meal: MealEntry, confirmed: true): Promise<ApiResult<{ meal: MealEntry & { id: string } }>>;
deleteMeal(id: string): Promise<ApiResult<null>>;
getPantry(): Promise<ApiResult<{ items: (PantryItem & { id: string })[] }>>;
changePantry(change: { add: PantryItem[]; removeNames: string[]; removeIds: string[] }, confirmed: true): Promise<ApiResult<{ items: (PantryItem & { id: string })[]; removed: (PantryItem & { id: string })[] }>>;
// mentor/reply.ts
export interface LocalCardView { origin: 'local'; localId: string; card: ProposalCard; issuedTurn: number }
export interface ServerCardView { origin: 'server'; proposalId: string; expiresAt: string; card: ProposalCard; issuedTurn: number }
export type CardView = LocalCardView | ServerCardView;
export type PanItem = { kind: 'said'; said: Said } | { kind: 'choices'; options: { id: string; name: string }[]; severity: Severity | null } | { kind: 'consent'; purpose: 'health_data' | 'ai_health' };
/** A request from the engine to the panel's writer (pre-flight C10). CardAction stays the record of a write the SERVER completed. */
export type LocalIntent = { kind: 'confirm' | 'reject'; localId: string } | { kind: 'undo' };
export interface PanReply { items: PanItem[]; cards: CardView[]; intents: LocalIntent[]; actions: CardAction[]; notice: TurnNotice }
export interface TurnContext { turn: number; openCards: CardView[]; intakeStep: IntakeStep | null; signedIn: boolean }
// mentor/scripted.ts
export interface ScriptedEngine { reply(text: string, ctx: TurnContext): PanReply; cardFromChoice(id: string, severity: Severity | null, turn: number): LocalCardView }
export function createScriptedEngine(deps: { dialogue: Dialogue; graph: IngredientGraph; ruleTerms: RuleTerm[]; recipes: { slug: string; title: string }[]; now: () => Date }): ScriptedEngine;
// mentor/writer.ts
export type WriteOutcome =
  | { ok: true; trail: TrailEntry; items: PanItem[] }
  | { ok: false; reason: 'tap_required' | 'consent_required' | 'needs_account' | 'invalid' | 'closed' | 'network'; items: PanItem[] };
export interface CardWriter {
  confirm(card: CardView, via: 'tap' | 'typed_yes', edits?: { severity?: Severity }): Promise<WriteOutcome>;   // severe + typed_yes → tap_required, no call
  reject(card: CardView): Promise<PanItem[]>;
  undo(entry: TrailEntry): Promise<PanItem[]>;
}
export function createCardWriter(deps: { client: ApiClient; store: PlayerStore; dialogue: Dialogue; graph: IngredientGraph; now: () => Date }): CardWriter;
// mentor/backend.ts
export type MentorInput = { kind: 'text'; text: string } | { kind: 'voice' };
export interface MentorBackend { readonly kind: 'scripted' | 'ai'; reply(input: MentorInput, ctx: TurnContext): Promise<PanReply> }
export function createScriptedBackend(engine: ScriptedEngine, dialogue: Dialogue): MentorBackend;   // voice → voice.not_yet, as M3
```
- Player copy (exact):
  - `RULES_UNREADABLE_MESSAGE` = "Some of the rules saved on this device couldn't be read, so I can't be sure what to check for. Open Your rules to look them over and confirm them."
  - `RULES_INVALID_MESSAGE` = "One of your saved rules names something the Bureau's ingredient ledger no longer knows, so I can't check dishes against it. Open Your rules to fix it."
  - Recipe cards show the message with a link to `#/rules` (Step 11) and keep ❓. Core's problem strings are never shown on a card. API 409 `rules_need_review` uses `RULES_INVALID_MESSAGE`.
- Scripted engine (`reply`), deterministic and in this order:
  1. `stripPageEvents`, then `classifyTurn`.
  2. core `preRoute(intent)` non-null → that line only. The same function the server uses (pre-flight C14).
  3. `yes` / `no` / `undo` → core `shortReplyTarget(intent, localCardsAsOpenCardRefs, ctx.turn)`. `confirm` / `reject` / `undo` become `intents` for the panel to run through the writer; `line` becomes a said item. No targeting rule is written here.
  4. Otherwise run every parser on the text, so a multi-intent turn yields several items. **Items come out in the order their match starts in the text** (pre-flight C31), whatever order the parsers run in:
     - `parseRuleStatement` → one `buildRuleCard` per term: a card, `rule.unknown_term`, or `rule.which_one` plus a choices item.
     - `parseMealStatement` → when signed out, `log.needs_account`. When signed in, a meal card: a dish when core `matchDish(description, recipes)` finds one (the server's rule, exactly), otherwise free text, with `slot ?? slotForTime(now)`.
     - `parseWeekdays` with `/\b(market|shop|shopping)\b/` → a profile `marketDays` card.
     - `parseClock` near a slot word → a profile `mealWindows` card, each window's `end` from core `windowEnd` (so `PUT /profile` accepts it). A slot word without a parsable time → `schedule.bad_time`.
     - `parsePantryAdds` / `parsePantryRemovals` → one pantry card. Meals are passed through core `dropMealsMatchingRemovals` (T05).
  5. Nothing found → `didnt_understand`.
- Every card's read-back is `card.readback` spoken through `dialogue.say(trigger, vars)`. The engine never builds safety text itself.
- Writer:
  - Server cards → `confirmProposal` / `rejectProposal` / `undoWrite`.
  - Local cards, signed in → `createRule(rule, true)`, `createMeal`, `putProfile(patch)`, or `changePantry`, then `refreshAccount` for rules. Trail entries are `origin: 'local'`, `id` = the written row id (rule, meal) or a fresh local id (profile, pantry), with the undo data held in the writer's memory.
  - Local cards, signed out → the store: a rule gets `id = crypto.randomUUID()` and is validated with `validateRules([...localRules, rule], graph)` first; the profile goes to `localProfile` and the pantry to `localPantry`. A meal → `needs_account`.
  - In-flight and closed card ids are tracked, so a second confirm of the same card resolves `closed` without a call.
  - HTTP mapping: 403 `consent_required` → a `consent` item; 409 `proposal_closed` → `closed`; status 0 → `network`.
  - Results come back as dialogue lines: `rule.stamped`, `log.logged`, `schedule.set`, `pantry.added` / `pantry.removed`, `rule.not_quite`, `undo`, `rule.voided`.
  - Local undo: within `UNDO_WINDOW_MS` (5 minutes, from the trail's `undoUntil`), the reverse REST call (`deleteRule`, `deleteMeal`, `putProfile(before)`, or `changePantry({ add: removed, removeNames: [], removeIds: addedIds })`, so a same-name item that was already there is never touched) or the store revert.
- `refreshAccount` (controller ruling): `listRules()` with status ≥ 500 → `accountRules = null` (fail closed); status 0 or 429 → keep the cached copy; 401 as M3.

- [ ] **9.1 Write the failing tests:**
```ts
// store.test.ts — the M3 carry-over
test('confirmRules clears rulesUnreadable in one update even with conflicting versions in memory', () => {
  // two stores on one storage; tab A and B write different versions of rule r1 → A's next update reports a conflict (rulesUnreadable true)
  const s = a.confirmRules([ruleX]);
  expect(s.rulesUnreadable).toBe(false); expect(s.localRules).toEqual([ruleX]);
  expect(JSON.parse(storage.getItem(STORE_KEY)!).rulesUnreadable).toBe(false);
});
test('new keys default when absent and mark corrupt when mis-shaped', ...);   // { localPantry: 'x' } → corrupt
// rules.test.ts
test('invalid rules give the player message, never core\'s text', ...);   // message === RULES_INVALID_MESSAGE; problems has core's string
test('signed in with accountRules null → account_not_loaded, ACCOUNT_NOT_LOADED_MESSAGE', ...);
// account.test.ts
test.each([[500, null], [503, null], [429, 'cached'], [0, 'cached']])('GET /rules %i → accountRules %s', ...);   // seeded with a cached peanut rule
// client.test.ts
test('confirmProposal sends { channel: "tap" } and nothing else', ...);
test('mentorTurn posts the TurnRequest as JSON', ...);
// scripted.test.ts (AI off, real compiled content)
test.each([
  ["I'm allergic to sesame", { cards: [{ kind: 'rule', severe: true, display: { spelled: 'S-E-S-A-M-E' } }] }],
  ["I'm allergic to kiwi.", { said: ['rule.unknown_term'], cards: [] }],
  ['I had toast for breakfast and also I\'m allergic to kiwi', { said: ['log.confirm_readback', 'rule.unknown_term'] }],   // T11, signed in; text order
  ["Market's on Friday, and I've got no eggs left.", { cards: [{ kind: 'profile', patch: { marketDays: [5] } }, { kind: 'pantry', remove: ['eggs'] }], noSaid: ['rule.unknown_term'] }],   // T12
  ['no wait, I said PECAN not peanut', { cards: [], noPantry: true }],                                   // S04: no removal of 'wait'
  ["I've got lentils, an onion and some eggs. Oh and I finished the milk.", { cards: [{ kind: 'pantry', remove: ['milk'] }] }],  // T05: no meal card
  ['remind me to eat lunch at like half twelve and dinner around 7ish pm', { cards: [{ kind: 'profile', patch: { mealWindows: [{ name: 'lunch', start: '12:30' }, { name: 'dinner', start: '19:00' }] } }] }],
  ['My market day is Saturday.', { cards: [{ kind: 'profile', patch: { marketDays: [6] } }] }],
  ['I just ate shrimp and my lips are tingling and my throat feels tight. What should I take?', { said: ['rule.emergency'], cards: [] }],
])('%s', ...);
test('signed out: a meal gets log.needs_account and no card', ...);
test('typed yes: one local non-severe card → a confirm intent; a severe one → rule.tap_needed; two → confirm.tap_card', ...);
test('a profile card from the engine is accepted by PUT /profile', ...);   // every window has an end; the zod schema from apps/api/src/profile/routes.ts is not imported, so assert end > start and HH:MM
// writer.test.ts
test('signed out: stamping writes a valid rule to localRules', ...);
test('signed in: stamping calls createRule with confirmed true, then refreshes account rules', ...);
test('severe + typed_yes never calls the API', ...);
test('403 → a consent item; the card stays open', ...);
test('a double confirm makes one call', ...);
test('undo after the window does nothing and says so', ...);   // the trail is past undoUntil → no call, items say undo.nothing
```
- [ ] **9.2 Run** `npm test -w @kitchenquest/game -- store rules api mentor` → FAIL.
- [ ] **9.3 Implement.** Update `card-model.ts` and `card-view.ts` to show `RulesState.message` and link to `#/rules`. The panel change is the minimal one in Files.
- [ ] **9.4 Run** `npm test -w @kitchenquest/game` and `npm run typecheck -w @kitchenquest/game` → PASS. The M3 e2e suite stays green: `npm run test:e2e -w @kitchenquest/game`.
- [ ] **9.5 Commit** `feat(game): scripted mentor engine with cards, card writer, one-update rule confirm, player-friendly rules errors`

**Carry from Step 1:** the intake allergies answer goes through the same ask-for-dropped-terms rule as Step 7 (see step-7.md "Carry from Step 1").
