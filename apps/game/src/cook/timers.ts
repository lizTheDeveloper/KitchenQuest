export interface RunningTimer { id: string; label: string; step: number; durationMs: number; endsAt: number; done: boolean }

/** A timer ends at an absolute time, so a throttled or sleeping tab only delays the display, never the count. */
export function startTimer(t: { id: string; label: string; step: number; seconds: number }, now: number): RunningTimer {
  const durationMs = t.seconds * 1000;
  return { id: t.id, label: t.label, step: t.step, durationMs, endsAt: now + durationMs, done: false };
}

export function remainingMs(t: RunningTimer, now: number): number {
  return Math.max(0, t.endsAt - now);
}

/** Marks every due timer done. `finished` holds the newly done ones only, so each is reported exactly once. */
export function tick(timers: RunningTimer[], now: number): { timers: RunningTimer[]; finished: RunningTimer[] } {
  const finished: RunningTimer[] = [];
  const next = timers.map((t) => {
    if (t.done || now < t.endsAt) return t;
    const d = { ...t, done: true };
    finished.push(d);
    return d;
  });
  return { timers: next, finished };
}

/** Rounds UP to whole seconds: '0:30', '20:00', '1:05:00'. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** '30 seconds', '1 minute 30 seconds', '1 hour 5 minutes', '2 hours'. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const parts: string[] = [];
  const unit = (n: number, word: string) => { if (n > 0) parts.push(`${n} ${word}${n === 1 ? '' : 's'}`); };
  unit(Math.floor(total / 3600), 'hour');
  unit(Math.floor((total % 3600) / 60), 'minute');
  unit(total % 60, 'second');
  return parts.length > 0 ? parts.join(' ') : '0 seconds';
}

/** M7 Step 10: the longest an alarm is marked sounding when its sound never reports its end (the beep is 300 ms). */
export const ALARM_MAX_MS = 2_000;

/**
 * The cook timer's alarm, marked sounding for exactly as long as it plays (B9, carry 1). `onAlarm(true)` is told before
 * the sound starts, so hands-free's VAD threshold is already raised when it reaches the microphone, and `onAlarm(false)`
 * once the last overlapping sound ends (the VAD's own TIMER_TAIL_MS then covers the room's echo). `play` starts one
 * sound, calls `ended` when it stops and returns false when nothing could play. The hook can be set later (hands-free
 * starts mid-cook: `sounding` says whether to raise it at once).
 */
export function createAlarm(play: (ended: () => void) => boolean, onAlarm: ((on: boolean) => void) | null) {
  let hook = onAlarm;
  let playing = 0;
  return {
    get sounding(): boolean { return playing > 0; },
    setHook(fn: ((on: boolean) => void) | null): void { hook = fn; },
    sound(): void {
      if (++playing === 1) hook?.(true);
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        clearTimeout(safety);
        if (--playing === 0) hook?.(false);
      };
      const safety = setTimeout(end, ALARM_MAX_MS);
      let started = false;
      try { started = play(end); } catch { /* sound is a nicety */ }
      if (!started) end();
    },
  };
}
