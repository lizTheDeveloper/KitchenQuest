# Step 9 — World map, travel permit, cook's kitchen

The world map (`#/map`) shows the three cooks. Choosing one opens the Bureau's Travel Permit (Form 9-T). Stamping it travels to that cook's kitchen (`#/visit/<cookId>`): the cook's intro lines, then the recipe card, then cook mode. In M3 all three cooks are open to visit. Quest steps, trust and `unlock` gating arrive with the quest engine in M5.

**Files:**
- Create: `apps/game/src/world/pins.ts` (+ `pins.test.ts`), `apps/game/src/world/map-screen.ts`, `apps/game/src/world/visit-screen.ts`, `apps/game/src/scenes/MapScene.ts`, `apps/game/src/scenes/CookKitchenScene.ts`
- Modify: `apps/game/src/scenes/phaser-host.ts` (register the two scenes)
- Test: `apps/game/e2e/world.e2e.test.ts`

**Interfaces:**
- Consumes: `showScene`, `emitAction`, `renderActionBar` (Step 8); `showBureauForm` (Step 3); `showDialogue`, `getMentor` (Step 5); `buildRecipeCard`, `renderRecipeCard`, `activeRules`, `localDate` (Step 6); `content` (Step 4).
- Produces:
```ts
// world/pins.ts: % positions on scene.map (from prototype/BRIEF.md; adjust by eye against the art)
export const MAP_PINS: Readonly<Record<string, { x: number; y: number }>>;   // marisol {21,44}, leela {67,50}, haruka {86,34}
```
- Map screen:
  - h1 "World map"
  - backdrop: the canvas `Map` scene, or a pixelated `<img>` fallback
  - the pins as HTML `<button>`s absolutely positioned over the backdrop by `MAP_PINS`, each labelled "Visit {cook.name} — {cook.place}" and drawn with the cook's sprite (the canvas draws no pins, so there is one set of controls)
  - an action bar with "Talk to the Pan" (says `travel.map_remark`) and "Home kitchen"
  - a footnote from `bureau.footnotes` with tag `map`
- Choosing a cook → `showBureauForm(forms.travel)` with values: bearer = "One (1) apprentice, plus pan"; destination = `cook.place`; host = `cook.name`; status = "Guest. Invited."; purpose = "To learn, if taught". The footnote is a random entry of the form's `footnotes`.
  - Confirm → Pan `travel.depart` `{ cook: cook.name, place: cook.place }`, then `navigate({ name: 'visit', cookId })`.
  - Decline → the form closes and focus returns to that pin.
- Visit screen (`#/visit/<cookId>`; an unknown id → not found):
  - h1 "{cook.name}'s kitchen" and the line "{cook.place}"
  - backdrop: the `CookKitchen` scene with `scene.kitchen-<id>` or `scene.kitchen` plus `char.<id>`, or the `<img>` fallback
  - on mount: `showDialogue(overlayRoot, { speaker: cook.name, portrait: assets['char.' + id], lines: cook.intro, reducedMotion })`, played in order, not randomly
  - then the action bar: "See the recipe: {cook.dish}" (opens `renderRecipeCard` for `cook.recipe` in a modal, with h2; its Cook button → `#/cook/<slug>`), "Hear the intro again", "Back to the map"
  - copy follows voice.md §0.3: "{cook.name} will teach you {cook.dish}", never "unlock" or "get"

- [ ] **9.1 Tests:**
  - `pins.test.ts`: every cook id in the compiled real content has a pin, and every pin's x and y lie in [0, 100].
  - `world.e2e.test.ts`:
    - `#/map` shows 3 pin buttons with the expected accessible names.
    - Click "Visit Ammachi Leela — Kochi, Kerala, India" → a dialog containing "FORM 9-T/TRAVEL", "Travel Permit", "Kochi, Kerala, India" and "To learn, if taught". "Not quite" → the dialog is gone and focus is on the Leela pin.
    - Again, then "Stamp it ✔" → URL `#/visit/leela`; h1 "Ammachi Leela's kitchen"; the dialogue box shows `intro[0]` of `content/cooks/leela.yaml`; Enter advances to `intro[1]`.
    - After the last line, "See the recipe: Parippu" → the card dialog with the title. "Cook it" → `#/cook/india/kerala/parippu`.
    - Seed the severe coconut rule: the visit card's Cook button is disabled. The pin is still on the map (blocked dishes stay visible, §4.4).
    - Block the phaser chunk → map pins and the visit flow still work.
    - Tapping "Talk to the Pan" on the map → a `travel.map_remark` line.
    - UI chrome text (outside `[data-content]`) on the map and visit screens never matches `/\b(unlock(ed)?|loot(ed)?|discovered|exotic|acquired)\b/i`. Content footnotes such as "never found, looted or discovered" are writer-reviewed and sit inside `[data-content]`.
    - At width 400 there is no horizontal scroll on the map, and the pins stay inside the backdrop.
    - `expectNoA11yViolations` on the map, the open permit, the visit dialogue and the visit card.
- [ ] **9.2 Run** `npm test -w @kitchenquest/game -- world` and `npm run test:e2e -w @kitchenquest/game -- e2e/world.e2e.test.ts` → FAIL.
- [ ] **9.3 Implement**, and register the screens.
- [ ] **9.4 Run** both → PASS.
- [ ] **9.5 Commit** `feat(game): world map, Bureau travel permit, cook's kitchen visit`
