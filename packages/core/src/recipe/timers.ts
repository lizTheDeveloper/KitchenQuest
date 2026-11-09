import { RecipeError } from './types';
import type { RecipeTimer } from './types';

const UNIT_SECONDS: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
};

/** A timer's length in seconds. Throws (naming the timer) rather than guessing at an unusable one. */
export function timerSeconds(timer: RecipeTimer): number {
  const label = `timer${timer.name ? ` "${timer.name}"` : ''}`;
  if (timer.quantity === null || !(timer.quantity > 0))
    throw new RecipeError([`${label}: needs a duration greater than 0`]);
  const factor = timer.unit === null ? undefined : UNIT_SECONDS[timer.unit.toLowerCase()];
  if (factor === undefined) throw new RecipeError([`${label}: unknown time unit "${timer.unit ?? ''}"`]);
  return timer.quantity * factor;
}
