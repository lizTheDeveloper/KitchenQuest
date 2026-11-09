# Step 5 — Pan dialogue engine and mentor panel shell (with Family Table mode)

The engine implements `content/README.md` §"How the game uses this content" rules 1–3. The panel is the UI the mentor milestone will later connect to real AI. In M3 it runs entirely on scripted lines. The Family Table mode flag exists from day one (spec §19).

**Files:**
- Create: `apps/game/src/mentor/dialogue.ts` (+ `dialogue.test.ts`), `apps/game/src/mentor/backend.ts` (+ `backend.test.ts`), `apps/game/src/mentor/panel.ts` (+ `panel.test.ts`), `apps/game/src/mentor/index.ts`, `apps/game/src/ui/dialogue-box.ts`
- Modify: `apps/game/src/shell/app.ts` (mount the panel once; `#pan-button` on every screen), `apps/game/src/styles/components.css`
- Test: `apps/game/e2e/mentor.e2e.test.ts`

**Interfaces:**
- Consumes: `LineBank`, `LineTrigger` (Step 4); `PlayerStore` (Step 3).
- Produces:
```ts
// mentor/dialogue.ts
export type Vars = Record<string, string | number>;
export interface Said { trigger: string; text: string; ai: 'never' | 'allowed' }   // trigger = the resolved id actually used
export class DialogueError extends Error {}
export const COMMON_DEFAULTS: Readonly<Record<string, string>>;   // { name: 'apprentice' } (pan.yaml header)
export function resolveTrigger(bank: LineBank, id: string): string | null;   // id, else drop the last dotted segment, repeat
export function fillLine(line: string, vars: Vars): string | null;            // null when any {var} is missing
export function defaultFor(trigger: LineTrigger, name: string): string | null; // from vars[name] "(default: X)" or "(default: 'X')", else COMMON_DEFAULTS
export interface Dialogue { say(id: string, vars?: Vars): Said }
export function createDialogue(bank: LineBank, opts?: { random?: () => number; history?: Record<string, number[]>; onHistory?: (h: Record<string, number[]>) => void }): Dialogue;
// mentor/backend.ts
export type MentorInput = { kind: 'text'; text: string } | { kind: 'voice' };
export interface MentorBackend { readonly kind: 'scripted' | 'ai'; reply(input: MentorInput): Promise<Said> }
export function createScriptedBackend(dialogue: Dialogue): MentorBackend;
// mentor/panel.ts
export type MentorMode = 'standard' | 'familyTable';
export interface MentorPanel { readonly mode: MentorMode; open(): void; close(): void; isOpen(): boolean; say(id: string, vars?: Vars): Said }
export function mountMentorPanel(root: HTMLElement, opts: { mode: MentorMode; backend: MentorBackend; dialogue: Dialogue; reducedMotion: () => boolean }): MentorPanel;
// mentor/index.ts
export function getMentor(): MentorPanel;   // the app's single panel; throws before mountApp ran
// ui/dialogue-box.ts
export function showDialogue(root: HTMLElement, opts: { speaker: string; portrait: string | null; lines: string[]; reducedMotion: boolean }): Promise<void>;
```
- Pick algorithm for `say(id, vars)`. First resolve `id` (unknown with no parent → `DialogueError` naming `id`). With `n` = line count and `recent` = the last `min(3, n-1)` indices used for the resolved trigger:
  1. Candidates are fillable lines not in `recent`. Pick one with `random()`.
  2. If there are none, take fillable lines other than the last index used (all fillable lines when n = 1).
  3. If there are still none, use line 0 with each missing var replaced by `defaultFor`. A var with no default → `DialogueError` naming the trigger and the var.

  `vars` values are stringified. History is kept per resolved trigger, and `onHistory` fires after each pick (the app persists it into `store.dialogueHistory`).
- Scripted backend: text matching `/\b(thanks|thank you|cheers|ta)\b/i` → `say('thanks')`. Any other text → `say('ai_unavailable')`. Voice → `say('voice.not_yet')`. The backend makes no network call.
- Panel DOM: `<aside id="pan-panel" role="dialog" aria-labelledby="pan-title">`. A heading "The Pan" with portrait. `<ol class="bubbles" aria-live="polite">` holds `li.bubble.pan` and `li.bubble.you`. Standard mode adds a `<form>` with `<label>` + `<textarea id="pan-text">` and a send button, plus a `<button id="pan-talk" aria-pressed="false">Hold to talk</button>`.
  - Hold-to-talk: pointerdown, or Space/Enter keydown (ignore auto-repeat), sets `aria-pressed="true"` and the label "Listening…". Pointerup, pointerleave or keyup releases it, which calls `backend.reply({ kind: 'voice' })`.
  - `#pan-button` (`aria-expanded`, `aria-controls="pan-panel"`) opens the panel. Escape closes it and returns focus to `#pan-button`.
  - Bubbles type in (click to finish), and appear instantly when `reducedMotion()` is true.
  - Bubbles are not persisted in any mode. M3 stores no transcript.
- **Family Table mode** (`store.settings.familyTable`; no UI toggle in M3; Family Mode is M13): `mountMentorPanel` throws `Error('Family Table mode requires the scripted backend')` **before touching `root`** if `backend.kind !== 'scripted'`. The panel renders **no** `textarea`, `input`, form or `#pan-talk`. Scenes still call `panel.say(...)`.
- Dialogue box (intros and greetings): parchment box with a nameplate tab in `--display` and a 2× pixelated portrait. Lines type in. Next button or Enter → next line; on the last line the promise resolves. Instant when motion is reduced. `aria-live="polite"` on the text.

- [ ] **5.1 Tests:**
```ts
// dialogue.test.ts: a fixture bank plus the real content
test('six-line trigger never repeats within 3', () => {
  const d = createDialogue(bank6, { random: () => 0 });
  const picks = Array.from({ length: 12 }, () => idx(d.say('six').text));
  picks.forEach((p, i) => expect(picks.slice(Math.max(0, i - 3), i)).not.toContain(p));
});
test('two-line trigger alternates', ...);              // 0,1,0,1 with random () => 0
test('one-line trigger repeats', ...);                  // real 'rule.emergency' twice → same text
test('fills vars', ...);                                // 'Morning, {name}.' + {name:'Sam'} → 'Morning, Sam.'
test('skips lines missing a var', ...);                 // ['Hi {name}.', 'Hello.'] no vars, 20 says → always 'Hello.'
test('documented default when every line needs a var', ...); // vars.hours "(default: 'a while')", lines all {hours} → line 0 with 'a while'
test('common default for name', ...);                   // only line 'Morning, {name}.' → 'Morning, apprentice.'
test('missing var without default throws', ...);        // DialogueError message contains trigger id and 'dish'
test('falls back to the parent trigger', ...);          // real say('reminder.hours_since_meal.h7', {hours: 7}).trigger === 'reminder.hours_since_meal'
test('unknown trigger throws', ...);
test('history survives a new engine', ...);             // pass history from onHistory into a second createDialogue: no repeat across them
test('every required trigger renders', () => {          // real pan.yaml, sample vars {dish:'Parippu', cook:'Ammachi Leela', place:'Kochi', time:'20 minutes', step:'step 2', technique:'Tempering'}
  for (const id of REQUIRED_PAN_TRIGGERS) expect(createDialogue(content.pan).say(id, sample).text).not.toMatch(/[{}]/);
});
// backend.test.ts
test('thanks → thanks; other text → ai_unavailable; voice → voice.not_yet', ...);  // check Said.trigger
// panel.test.ts
test('family table refuses a non-scripted backend before touching the DOM', () => {
  const root = new Proxy({}, { get() { throw new Error('touched'); } }) as unknown as HTMLElement;
  expect(() => mountMentorPanel(root, { mode: 'familyTable', backend: { kind: 'ai', reply: async () => x }, dialogue, reducedMotion: () => true }))
    .toThrow('Family Table mode requires the scripted backend');
});
```
`mentor.e2e.test.ts`:
  - `#pan-button` exists on `/`, `#/map` and `#/settings`, and opens the panel.
  - Typing "thank you" + send → the last Pan bubble's text is one of `pan.yaml`'s `thanks` lines (the test loads the YAML with `yaml`). "what's for dinner" → one of `ai_unavailable`.
  - Focus `#pan-talk`, keydown Space: `aria-pressed="true"`. Keyup: the reply is one of `voice.not_yet`.
  - Escape closes and focuses `#pan-button`.
  - Seed `settings.familyTable: true`: the count of `#pan-panel textarea, #pan-panel input, #pan-panel form, #pan-talk` is 0. (Step 7 adds the matching check that scripted lines still appear in this mode.)
  - The panel makes no request (`requests` gains nothing after interacting).
  - `expectNoA11yViolations` with the panel open, in both modes.
- [ ] **5.2 Run** `npm test -w @kitchenquest/game -- mentor` → FAIL; `npm run test:e2e -w @kitchenquest/game -- e2e/mentor.e2e.test.ts` → FAIL.
- [ ] **5.3 Implement.** The app mounts the panel with `mode` from settings and a `createScriptedBackend(createDialogue(content.pan, { history: state.dialogueHistory, onHistory: (h) => store.update((s) => ({ ...s, dialogueHistory: h })) }))`.
- [ ] **5.4 Run** both → PASS.
- [ ] **5.5 Commit** `feat(game): scripted Pan dialogue engine and mentor panel shell with Family Table mode`
