import type { Dialogue, Said } from './dialogue';

export type MentorInput = { kind: 'text'; text: string } | { kind: 'voice' };
export interface MentorBackend { readonly kind: 'scripted' | 'ai'; reply(input: MentorInput): Promise<Said> }

const THANKS = /\b(thanks|thank you|cheers|ta)\b/i;

/** M3's only backend: written lines, no network. */
export function createScriptedBackend(dialogue: Dialogue): MentorBackend {
  return {
    kind: 'scripted',
    async reply(input) {
      if (input.kind === 'voice') return dialogue.say('voice.not_yet');
      return dialogue.say(THANKS.test(input.text) ? 'thanks' : 'ai_unavailable');
    },
  };
}
