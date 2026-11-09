import type { Dialogue, Said } from './dialogue';

type MentorInput = { kind: 'text'; text: string } | { kind: 'voice' };
export interface MentorBackend { readonly kind: 'scripted' | 'ai'; reply(input: MentorInput): Promise<Said> }

const THANKS = /\b(thanks|thank you|cheers|ta)\b/i;

/** M3's only backend: written lines, no network. */
export function createScriptedBackend(dialogue: Dialogue): MentorBackend {
  return {
    kind: 'scripted',
    reply(input) {
      // Deferred so a throw from dialogue.say still arrives as a rejection, as callers expect.
      return Promise.resolve().then(() =>
        input.kind === 'voice'
          ? dialogue.say('voice.not_yet')
          : dialogue.say(THANKS.test(input.text) ? 'thanks' : 'ai_unavailable'),
      );
    },
  };
}
