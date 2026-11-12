# Step 10 — Game: hands-free cook mode (VAD loop, commands, step reading, barge-in)

Spec §7.7: "a hands-free mode with voice activity detection for cook mode (hands are messy)". With `settings.voice.on` and `settings.voice.handsFree` on, cook mode gets a "Hands-free" toggle. While it is on:
- the VAD listens continuously;
- a closed command ("next", "back", "repeat", "what do I need", "start the timer", "stop listening") drives the step runner;
- the Pan reads a canon step aloud when the API says it is safe to (Ruling 11);
- anything else goes to the Pan through Step 9's `transcriptTurn`, heard check included;
- the player can talk over the Pan (barge-in, Ruling 7).

It turns itself off when idle, on leaving and on hiding. A "Listening" pill is always visible while the mic is open.

**Files:**
- Create: `apps/game/src/cook/hands-free.ts` (+ test).
- Modify:
  - `apps/game/src/cook/cook-mode.ts`: the toggle, the pill, and the command hooks into the existing step, timer and ingredient actions;
  - `apps/game/src/cook/{cook-screen,frame-cook}.ts`: canon sources pass `speakStep: { slug }`; frames pass `null`, so commands work and steps are not read (Ruling 11);
  - `apps/game/src/cook/wake-lock.ts`: hands-free holds the wake lock while on;
  - `apps/game/src/cook/cook-screen.test.ts`.

**Interfaces:**
- Consumes: `createVoiceController` (`startHandsFree` / `stopHandsFree`), `createVad`, `speakPlan` (Step 8); core `cookCommand`, `HANDS_FREE_IDLE_MS`, `BARGE_IN_MIN_MS`, `SpeakItem` `step`; `transcriptTurn` (Step 9); the mentor's `getMentor()` to show non-command turns in the panel; `CookModeSource`.
- Produces:
```ts
// hands-free.ts
export interface HandsFreeHooks {
  next(): void; back(): void; ingredients(): void; timerStart(): void; timerStop(): void;
  currentStep(): number;
  speakStep: { slug: string } | null;              // null: Pantry Frames (Ruling 11)
}
export function startHandsFree(deps: { win: Window; controller: VoiceController; hooks: HandsFreeHooks; localDate: () => string;
  toPan(text: string): Promise<void>; say(trigger: string): SpeakItem }): { stop(reason: 'user' | 'idle' | 'left' | 'hidden'): void };
//   command → the hook, then (next/back/repeat) speak { kind: 'step', slug, step, localDate } when speakStep is set;
//   'stop_listening' → stop('user'); no speech for HANDS_FREE_IDLE_MS → stop('idle') + voice.hands_free_idle;
//   visibilitychange hidden → stop('hidden'); cook mode teardown → stop('left');
//   non-command → toPan(text) (the panel opens; the heard check runs there)
```
- **The loop.** Speech start → `listen('handsFree')` with the pre-roll → frames while speaking → end at the hangover → transcript. While the Pan speaks, the VAD threshold is raised (`setPanSpeaking(true)`). Speech held for `BARGE_IN_MIN_MS` above it stops playback and starts a new utterance.

- [ ] **10.1 Write the failing tests.**
```ts
// hands-free.test.ts (fake controller, scripted VAD frames, fake timers)
test('"next" advances one step and speaks { kind: "step", slug, step: 1 } for a canon dish; a frame dish advances but speaks nothing', ...);
test('"start the timer" starts the step timer through the existing hook; "stop listening" stops and says voice.hands_free_off', ...);
test('a non-command ("how thin should the onions be") goes to toPan, so the heard check and the Pan answer it', ...);
test('Pan audio fed back at playback level never triggers a barge-in; louder speech ≥ BARGE_IN_MIN_MS does (Review Focus 3)', ...);
test('no speech for HANDS_FREE_IDLE_MS → stopped, every mic track ended, voice.hands_free_idle once', ...);
test('page hidden, leaving cook mode, Family Table turned on, or the child flag → stopped at once, nothing more sent (Review Focus 4)', ...);
test('only frames from pre-roll to end are sent; a minute of kitchen hiss sends nothing', ...);
// cook-screen.test.ts (extended)
test('the Hands-free toggle shows only with voice on + handsFree on, signed in, standard mode; never in Family Table', ...);
test('the Listening pill is visible exactly while the mic is open, is announced politely once, and has no timer or countdown', ...);
test('keyboard and touch controls keep working while hands-free is on', ...);
```
- [ ] **10.2 Run** `npm test -w @kitchenquest/game -- hands-free cook-screen` → FAIL.
- [ ] **10.3 Implement.**
- [ ] **10.4 Run** `npm test -w @kitchenquest/game`, `npm run typecheck`, `npm run build -w @kitchenquest/game` → PASS. Check the README's echo checklist by hand in Chromium with speakers, if a browser with a microphone is available; otherwise say so in the report. `git diff --stat` since Step 7 shows no `EVAL_FILES` path.
- [ ] **10.5 Commit** `feat(cook): hands-free cook mode — VAD loop, commands, safe step reading, barge-in, idle off`
