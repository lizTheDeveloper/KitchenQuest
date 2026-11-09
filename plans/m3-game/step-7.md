# Step 7 — Cook mode

`#/cook/<slug>` is pure HTML and never loads Phaser (§3.4). It offers big text, one step at a time, Cooklang timers, and a screen wake lock (§3.2). Finishing records "cooked" Toolkit events and shows the Bureau's Certificate of a Dish Cooked. The photo and the cook's reaction come later.

**Files:**
- Create: `apps/game/src/cook/timers.ts` (+ `timers.test.ts`), `apps/game/src/cook/wake-lock.ts` (+ `wake-lock.test.ts`), `apps/game/src/cook/cook-screen.ts`, `apps/game/src/cook/finish.ts` (+ `finish.test.ts`)
- Modify: `apps/game/src/styles/components.css`
- Test: `apps/game/e2e/cook.e2e.test.ts`

**Interfaces:**
- Consumes: `timerSeconds`, `stepPlainText`, `recordTechnique` (Steps 1–2); `buildRecipeCard`, `activeRules`, `localDate` (Step 6); `getMentor` (Step 5); `showBureauForm` (Step 3); `content`, `techniqueName` (Step 4).
- Produces:
```ts
// cook/timers.ts
export interface RunningTimer { id: string; label: string; step: number; durationMs: number; endsAt: number; done: boolean }
export function startTimer(t: { id: string; label: string; step: number; seconds: number }, now: number): RunningTimer;
export function remainingMs(t: RunningTimer, now: number): number;                   // max(0, endsAt - now)
export function tick(timers: RunningTimer[], now: number): { timers: RunningTimer[]; finished: RunningTimer[] };   // finished = newly done only
export function formatClock(ms: number): string;      // rounds UP to whole seconds: '0:30', '20:00', '1:05:00'
export function formatDuration(seconds: number): string;   // '30 seconds', '1 minute', '1 minute 30 seconds', '20 minutes', '1 hour 5 minutes', '2 hours'
// cook/wake-lock.ts
export type WakeState = 'on' | 'off' | 'unsupported' | 'denied';
export function createWakeLock(nav: Navigator, doc: Document): { enable(): Promise<WakeState>; disable(): Promise<void>; readonly state: WakeState };
// cook/finish.ts
export function cookedEvents(slug: string, recipe: ParsedRecipe, today: string): TechniqueEvent[];   // one 'cooked' event per meta.skills entry
```
- Timers are stored as absolute `endsAt` values (`Date.now()`-based). The display re-renders every 250 ms through `setInterval`, and `tick` decides what finished, so a throttled or sleeping tab only delays the display, never the count. Timers keep running across step changes. They are kept in memory only, so a reload or leaving cook mode stops them.
- Wake lock: `enable()` calls `navigator.wakeLock.request('screen')`. It re-acquires on `visibilitychange` → visible while enabled, and `disable()` releases. With no `wakeLock` → `'unsupported'`, and the screen says "This browser can't keep the screen awake. Tap the screen now and then." A rejected request → `'denied'`, with the same note.

**Screen:**
- On mount: build the card (`buildRecipeCard`). If the slug is unknown → not found. If `!cookable` → render only an h1 with the title, "This dish isn't cookable with your rules." (or "Shared as a story only." for sacred) and a link back to the card. No steps render. This check also runs on resume (Review Focus 3).
- Header: h1 = title; "Draft recipe" badge when draft; "Step {n} of {N}"; wake toggle `<button aria-pressed>` "☀ Keep screen awake". The wake lock is enabled on mount.
- Body: the step in large text (≥ 1.75rem, line-height ≥ 1.5). Ingredients render as `<strong>` "{displayName ?? name}" with the amount when known ("100 g"). Any swap finding for that ingredient adds "(swapped: … )". Cookware renders as text.
- Each timer item renders a button "Start {formatClock} timer" (aria-label "Start {formatDuration} timer for step {n}").
- Timer tray: a `role="group"` labelled "Running timers". Each timer shows "Step {n} · {clock}". Tick text is **not** live; when a timer finishes, `#announcer` gets "Timer finished: {formatDuration} for step {n}". When supported, a short WebAudio beep plays and `navigator.vibrate(200)` fires.
- Controls: "◀ Previous" and "Next step ▶" buttons. ArrowLeft and ArrowRight do the same unless focus is in a text field. On the last step the next button reads "Done ▶". "Leave cook mode" reads "Leave cook mode (stops 1 timer)" or "Leave cook mode (stops {k} timers)" when timers are running.
- Progress: the current step is saved to `store.cookProgress = { slug, step }` on each change. Reopening the same slug resumes at that step. Finishing clears it.
- Pan:
  - mount → `cook.start` `{ dish: cook.dish }` (the cook file's dish name, falling back to the title)
  - every third forward step change → `cook.step_quip`
  - timer start → `cook.timer_start` `{ time: formatDuration }`
  - timer finish → `cook.timer_done` `{ step: 'step ' + n }`
  - done → `cook.done` `{ dish, cook: cook name }`
- Done:
  - fold `cookedEvents` into `store.get().toolkit` with `recordTechnique` (one `store.update`), then clear `cookProgress`
  - release the wake lock
  - show `showBureauForm` with `forms.certificate` and values: dish = title; taught_by = "{cook name}", with the hint's `{place}` filled from the cook file; rewards = "Techniques tried: {names joined ', '}"
  - confirm → `#/kitchen`
  - No XP or stamps (M5).

- [ ] **7.1 Tests:**
```ts
// timers.test.ts
test('formatClock', () => { expect(formatClock(30_000)).toBe('0:30'); expect(formatClock(1_200_000)).toBe('20:00');
  expect(formatClock(3_900_000)).toBe('1:05:00'); expect(formatClock(999)).toBe('0:01'); expect(formatClock(0)).toBe('0:00'); });
test('formatDuration', ...);   // the six examples above, plus 7200 → '2 hours'
test('finishes exactly once', () => { const t = startTimer({ id: 'a', label: 'x', step: 2, seconds: 60 }, 0);
  const a = tick([t], 60_000); expect(a.finished).toHaveLength(1); expect(tick(a.timers, 61_000).finished).toHaveLength(0); });
test('a 2-hour jump finishes every due timer once', ...);
test('remainingMs never negative', ...);
// wake-lock.test.ts (fake navigator/document objects)
test('unsupported without navigator.wakeLock', ...); test('denied when request rejects', ...);
test('re-acquires on visible while enabled, not after disable', ...);
// finish.test.ts
test('cookedEvents for parippu', () => expect(cookedEvents('india/kerala/parippu', parippu, '2026-11-09').map(e => e.technique))
  .toEqual(['legumes', 'heat-control', 'tempering']));
```
`cook.e2e.test.ts` (uses `page.clock.install()`):
  - Open `#/cook/india/kerala/parippu`: h1 contains "Parippu"; "Step 1 of 7"; ArrowRight → "Step 2 of 7".
  - Click "Start 20:00 timer"; the tray shows "Step 2 · 20:00"; `clock.runFor(60_000)` → "19:00".
  - ArrowRight to step 3: the tray still shows the timer. `runFor(19 * 60_000)` → `#announcer` contains "Timer finished: 20 minutes for step 2", and the newest Pan bubble is one of `cook.timer_done`'s lines with `{step}` filled.
  - Wake lock: `addInitScript` stubs `navigator.wakeLock.request` and records calls. Assert one call with `'screen'` on entry, and a sentinel release on "Leave cook mode". A second test deletes `navigator.wakeLock` → the note text is shown.
  - **No canvas:** `page.route('**/assets/phaser-*.js', r => r.abort())` and record requests. Complete all 7 steps → the certificate shows the stamp text "COOKED". No request matched `phaser`. `localStorage` toolkit has `tempering.tier === 'tried'`. Pressing confirm lands on `#/kitchen`.
  - With the 20:00 timer running, the leave button reads "Leave cook mode (stops 1 timer)" (Review Focus 4).
  - Resume: go to step 3, reload → "Step 3 of 7".
  - Deep link blocked: seed the severe coconut rule and open `#/cook/india/kerala/parippu` → "isn't cookable" is visible and "Step 1" is absent. Then seed `cookProgress` for parippu plus the same rule, reload → still refused.
  - Family Table: seed `familyTable: true` → the `cook.start` Pan bubble still appears and the panel has no text box.
  - `expectNoA11yViolations` on step 1, with a timer running, and on the certificate. At width 400 there is no horizontal scroll.
- [ ] **7.2 Run** `npm test -w @kitchenquest/game -- cook` and `npm run test:e2e -w @kitchenquest/game -- e2e/cook.e2e.test.ts` → FAIL.
- [ ] **7.3 Implement**, and register the screen.
- [ ] **7.4 Run** both → PASS.
- [ ] **7.5 Commit** `feat(game): HTML cook mode with Cooklang timers, wake lock and the dish certificate`
