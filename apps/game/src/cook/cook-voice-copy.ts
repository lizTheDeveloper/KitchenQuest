// M7 Step 10 fix round 1 (first paint): hands-free cook mode's spoken cues (`voice.cook.*` in content/dialogue/pan.yaml)
// ship in the lazy `virtual:kq-cook-voice` module, which only the lazy cook-voice.ts imports.
import cookVoice from 'virtual:kq-cook-voice';
import type { CookVoiceContent } from '../content/types';
import type { Said } from '../mentor/dialogue';

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- virtual module, typed in virtual.d.ts
const data: CookVoiceContent = cookVoice;

/** The cues as a trigger map (the content scans read it). */
export const cookVoiceTriggers: CookVoiceContent['copy'] = data.copy;

/** A cue, as said: a var-free line and its variant index (the API says it by index, Ruling 15). Throws on an unknown id. */
export function cookCue(trigger: string, pick: (n: number) => number = (n) => Math.floor(Math.random() * n)): Said {
  const t = data.copy[trigger] as CookVoiceContent['copy'][string] | undefined;
  if (t === undefined || t.lines.length === 0) throw new Error(`no cook voice line ${trigger}`);
  const index = pick(t.lines.length);
  return { trigger, text: t.lines[index], ai: 'never', index };
}
