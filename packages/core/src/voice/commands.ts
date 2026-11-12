// M7 cook mode (Ruling 9, Step 10): spoken cook commands as a whole-utterance closed grammar. The utterance must be
// exactly one command (a leading "ok" or "Pan" and a trailing "please" or "thanks" allowed); anything more is not a
// command and goes the normal way, through the heard check. Designed for on-device use in M13 too. Browser-safe.
import { normalizeTurn } from '../mentor/intents';

export type CookCommand = 'next' | 'back' | 'repeat' | 'ingredients' | 'timer_start' | 'timer_stop' | 'stop_listening';

const PHRASES: Readonly<Record<CookCommand, readonly string[]>> = {
  next: ['next', 'next step', 'next one', 'go on', 'carry on', 'continue', 'move on', 'whats next', 'what is next', 'what now', 'and then', 'done next'],
  back: ['back', 'go back', 'previous', 'previous step', 'last step', 'step back', 'back one', 'go back one', 'back a step', 'go back a step'],
  repeat: ['repeat', 'repeat that', 'repeat the step', 'say that again', 'say again', 'say it again', 'again', 'come again', 'what was that', 'pardon', 'read that again', 'read it again'],
  ingredients: ['ingredients', 'what do i need', 'what do i need again', 'ingredient list', 'the ingredients', 'list the ingredients', 'read the ingredients', 'what goes in', 'what goes in it'],
  timer_start: ['start the timer', 'start timer', 'start a timer', 'start the clock', 'timer start', 'set the timer', 'set timer'],
  timer_stop: ['stop the timer', 'stop timer', 'cancel the timer', 'cancel timer', 'timer stop', 'turn off the timer', 'turn the timer off', 'stop the alarm', 'silence the timer'],
  stop_listening: ['stop listening', 'stop listening now', 'turn off the mic', 'turn the mic off', 'mic off', 'microphone off'],
};

const BY_PHRASE: ReadonlyMap<string, CookCommand> = new Map(
  (Object.entries(PHRASES) as [CookCommand, readonly string[]][]).flatMap(([command, phrases]) => phrases.map((p) => [p, command] as const)),
);
const LEAD = /^(?:(?:ok|okay|right|alright|hey|pan|um|uh|so)\s+)+/;
const TRAIL = /(?:\s+(?:please|thanks|thank you|pan|now then))+$/;

/** The cook command the whole utterance is, or null. Case, punctuation and the polite words around it don't matter. */
export function cookCommand(transcript: string): CookCommand | null {
  const t = normalizeTurn(transcript)
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(LEAD, '')
    .replace(TRAIL, '');
  return BY_PHRASE.get(t) ?? null;
}
