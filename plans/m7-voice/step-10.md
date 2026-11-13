# Step 10 — Game: hands-free cook mode (commands, step reading, barge-in, idle off)

Spec §7.7: "a hands-free mode with voice activity detection for cook mode (hands are messy)". It exists only in builds with `VITE_HANDS_FREE=on` (C9).

With `settings.voice.on` and `settings.voice.handsFree` on, cook mode gets a "Hands-free" toggle. **The controller (Step 8) owns capture, VAD and the socket** (P10). This step's `cook-voice.ts` only routes:
- a closed command drives the step runner;
- the Pan reads a canon step aloud when the API says it is safe (Ruling 11);
- anything else goes to the Pan through Step 9's `transcriptTurn`, heard check included. A food question therefore needs one tap (Ruling 4; the narrowing option is on the founder list, D6).

Hands-free turns off when idle, on leaving cook mode and when the page is hidden. While a cook timer's alarm sounds, the VAD threshold is raised (B9). A "Listening" pill shows whenever the mic is open.

**Files:**
- Create: `apps/game/src/cook/cook-voice.ts` (+ test).
- Modify:
  - `apps/game/src/cook/cook-mode.ts`: the toggle, the pill and the command hooks;
  - `apps/game/src/cook/{cook-screen,frame-cook}.ts`: canon sources pass `speakStep: { slug }`; frames pass `null`;
  - `apps/game/src/cook/timers.ts`: an `onAlarm(on)` hook that calls `controller.timerSounding`;
  - `apps/game/src/cook/wake-lock.ts`: the wake lock is held while hands-free is on;
  - `apps/game/src/cook/cook-screen.test.ts`.

**Interfaces:**
- Consumes: `VoiceController` (`startHandsFree`, `stopHandsFree`, `timerSounding`, `onTranscript`, `say`) (Step 8); core `cookCommand`, `HANDS_FREE_IDLE_MS`, `SpeakItem` `step` (0-based); `transcriptTurn` (Step 9); `getMentor()`; `CookModeSource`.
- Produces:
```ts
// cook-voice.ts
export interface CookVoiceHooks {
  next(): void; back(): void; ingredients(): void; timerStart(): void; timerStop(): void;
  currentStep(): number;                       // 0-based, as SpeakItem.step (P12)
  speakStep: { slug: string } | null;          // null: Pantry Frames (Ruling 11)
}
export function startCookVoice(deps: { controller: VoiceController; hooks: CookVoiceHooks; localDate: () => string; doc: Document;
  toPan(text: string, utteranceId: number): Promise<void> }): { stop(reason: 'user' | 'idle' | 'left' | 'hidden'): void };
//   calls controller.startHandsFree(); command → hook; next/back/repeat → say({ kind:'step', slug, step: currentStep(), localDate })
//   when speakStep; 'stop_listening' → stop('user') + voice.hands_free_off; HANDS_FREE_IDLE_MS without a transcript → stop('idle')
//   + voice.hands_free_idle; visibilitychange hidden → stop('hidden'); teardown → stop('left'); non-command → toPan
```

- [x] **10.1 Write the failing tests.**
```ts
// cook-voice.test.ts (fake controller, fake timers)
test('"next" on step index 0 of a canon dish shows index 1 and says { kind: "step", slug, step: 1 }; a frame dish advances and says nothing', ...);
test('"start the timer" / "stop the timer" call the existing hooks; "stop listening" stops and says voice.hands_free_off', ...);
test('a non-command non-food question ("how long do I keep stirring") goes to toPan with its utteranceId (D6)', ...);
test('while a timer alarm sounds, timerSounding(true) is called and cleared after; alarm-shaped audio opens no utterance (B9, Review Focus 3)', ...);
test('no transcript for HANDS_FREE_IDLE_MS → stopped, stopHandsFree called, voice.hands_free_idle once', ...);
test('page hidden, leaving cook mode, Family Table on, or the child flag → stopped at once (Review Focus 4)', ...);
// cook-screen.test.ts (extended)
test('the Hands-free toggle shows only with VITE_HANDS_FREE on, voice on, handsFree on, signed in, standard mode; never in Family Table', ...);
test('the Listening pill is visible exactly while the mic is open, is announced politely once, and has no timer or countdown', ...);
test('keyboard and touch controls keep working while hands-free is on', ...);
```
- [x] **10.2 Run** `npm test -w @kitchenquest/game -- cook-voice cook-screen timers` → FAIL.
- [x] **10.3 Implement.**
- [x] **10.4 Run** `npm test -w @kitchenquest/game`, `npm run typecheck`, the game build → PASS.
  - Run the README echo checklist by hand in each browser available, and record the results in `bench/latest.json` `manual[]` (operator). Without a browser that has a microphone, say so in the report; `VITE_HANDS_FREE` then stays off.
  - Check that no `EVAL_FILES` path changed since Step 7.
- [x] **10.5 Commit** `feat(cook): hands-free cook mode — commands, safe step reading, barge-in, idle off`
