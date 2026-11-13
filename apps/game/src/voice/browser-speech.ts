// M7 Ruling 1: Web Speech as a development stand-in, on the dev server only. providers.ts reaches this module only
// under `import.meta.env.DEV`, and every build refuses VITE_VOICE_PROVIDER=browser, so no build ever holds it: Chrome's
// recogniser sends audio to an unreviewed processor that the CSP does not govern.
import type { VoiceMode, VoiceState } from '@kitchenquest/core/engine';
import type { Speech, Utterance, VoiceProvider } from './providers';

interface Recognition {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string } | undefined>> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type SpeechWin = Window & { SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance; SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };

export function browserSpeechProvider(win: Window): VoiceProvider {
  const w = win as SpeechWin;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  let nextId = 1;
  return {
    kind: 'browser',
    hello: (): Promise<VoiceState> => Promise.resolve({ kind: 'available' }),
    listen(_mode: VoiceMode): Utterance {
      const id = nextId++;
      let text = '';
      let done = false;
      let resolve!: (r: { text: string; tooLong: boolean }) => void;
      const answer = new Promise<{ text: string; tooLong: boolean }>((r) => { resolve = r; });
      const finish = () => { if (!done) { done = true; resolve({ text: text.trim(), tooLong: false }); } };
      const rec = Ctor ? new Ctor() : null;
      if (rec === null) finish();
      else {
        rec.lang = 'en-GB';
        rec.interimResults = false;
        rec.continuous = true;
        rec.onresult = (e) => { text = Array.from(e.results, (r) => r[0]?.transcript ?? '').join(' '); };
        rec.onend = finish;
        rec.onerror = finish;
        rec.start();
      }
      return {
        id,
        push: () => undefined, // the browser listens for itself
        end: () => { rec?.stop(); return answer; },
        cancel: () => { text = ''; rec?.abort(); finish(); },
      };
    },
    speak(_items, said): Speech {
      const synth = win.speechSynthesis;
      let resolve!: () => void;
      const done = new Promise<void>((r) => { resolve = r; });
      const lines = said.filter((t) => t.trim() !== '');
      if (lines.length === 0) { resolve(); return { done, stop: () => undefined }; }
      lines.forEach((t, i) => {
        const u = new w.SpeechSynthesisUtterance(t);
        if (i === lines.length - 1) { u.onend = () => resolve(); u.onerror = () => resolve(); }
        synth.speak(u);
      });
      return { done, stop: () => { synth.cancel(); resolve(); } };
    },
    onEvent: () => () => undefined,
    close: () => { win.speechSynthesis.cancel(); },
  };
}
