// M7 Step 8: the game's voice seam (Ruling 1). `service` is the API's voice socket (the self-hosted STT/TTS behind it);
// `browser` is Web Speech, a development stand-in reachable only on the dev server (`import.meta.env.DEV`), and refused
// by every build (build/voice-provider.ts). Replies are matched by id, and every listen and speak gets a fresh one.
import { MAX_SPEAK_ITEMS, type ServerMsg, type VoiceState } from '@kitchenquest/core/engine';
import type { PlayerStore } from '../state/store';
import { createPlayer, type Player } from './playback';
import type { ProviderEvent, VoiceProvider } from './provider-types';
import { openVoiceSocket, VoiceSocketClosed, type VoiceSocket } from './socket';

export type { ProviderEvent, Speech, Utterance, VoiceProvider } from './provider-types';

/** An utterance's answer may take this long after `end` before it is given up (an answer the API never sends). */
const END_TIMEOUT_MS = 20_000;
/** A speech that never ends is given up after this long. */
const SPEAK_TIMEOUT_MS = 60_000;

const EMPTY = { text: '', tooLong: false } as const;
const pad = (n: number) => String(n).padStart(2, '0');
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

interface PendingUtterance { id: number; tooLong: boolean; serverEnded: boolean; ended: boolean; finish(r: { text: string; tooLong: boolean }): void }
interface PendingSpeech { id: number; rate: number | null; audioEnded: boolean; finish(): void }

export function serviceProvider(
  win: Window,
  store: PlayerStore,
  opts: { player?: Player; open?: typeof openVoiceSocket; now?: () => Date } = {},
): VoiceProvider {
  const player = opts.player ?? createPlayer(win);
  const open = opts.open ?? openVoiceSocket;
  const now = opts.now ?? (() => new Date());
  const events = new Set<(e: ProviderEvent) => void>();
  const emit = (e: ProviderEvent) => { for (const fn of [...events]) fn(e); };
  let socket: VoiceSocket | null = null;
  let opening: Promise<VoiceState> | null = null;
  let state: VoiceState = { kind: 'available' };
  let closed = false;
  /** Never reused, for a listen or a speak (carry 2). */
  let nextId = 1;
  const utterances = new Map<number, PendingUtterance>();
  let speech: PendingSpeech | null = null;

  const endAll = () => {
    for (const u of [...utterances.values()]) u.finish({ text: '', tooLong: u.tooLong });
    speech?.finish();
  };

  const onMsg = (m: ServerMsg) => {
    switch (m.t) {
      case 'transcript': return utterances.get(m.id)?.finish({ text: m.text, tooLong: utterances.get(m.id)!.tooLong });
      case 'too_long': {
        const u = utterances.get(m.id);
        if (u) { u.tooLong = true; u.serverEnded = true; }
        return;
      }
      case 'failed': {
        const u = utterances.get(m.id);
        if (u) return u.finish({ text: '', tooLong: u.tooLong });
        if (speech?.id === m.id) speech.finish();
        return;
      }
      case 'state':
        state = m.state;
        // A listen or speak the allowance refused is never answered: both end here (the one in flight was answered).
        if (m.state.kind !== 'available') endAll();
        return emit({ kind: 'state', state: m.state });
      case 'audio_start':
        if (speech?.id === m.id) speech.rate = m.sampleRate;
        return;
      case 'audio_end':
        if (speech?.id !== m.id) return;
        speech.audioEnded = true;
        if (!player.speaking) speech.finish();
        return;
      case 'ready':
      case 'closed':
        return; // the socket handles both
    }
  };
  player.onIdle(() => { if (speech?.audioEnded) speech.finish(); });

  const attach = (s: VoiceSocket) => {
    socket = s;
    state = s.state;
    s.on(onMsg);
    s.onAudio((id, pcm) => {
      if (speech?.id === id && speech.rate !== null) player.play(id, pcm, speech.rate);
    });
    void s.closed.then((reason) => {
      if (socket !== s) return; // closed by us
      socket = null;
      opening = null;
      player.stop();
      // Review Focus 5: the reason first, then every pending answer ends empty. Nothing is retried.
      emit({ kind: 'closed', reason });
      endAll();
    });
  };

  const live = () => (closed ? null : socket);

  return {
    kind: 'service',
    hello(conversationId, localDate) {
      if (closed) return Promise.reject(new VoiceSocketClosed('network'));
      if (socket !== null) return Promise.resolve(state);
      opening ??= open(win, {
        t: 'hello', v: 1, conversationId, localDate, localTime: localTime(now()), familyTable: store.get().settings.familyTable,
      }).then(
        (s) => {
          if (closed) { s.close(); throw new VoiceSocketClosed('network'); }
          attach(s);
          return s.state;
        },
        (e: unknown) => {
          opening = null;
          throw e;
        },
      );
      return opening;
    },

    listen(mode) {
      const id = nextId++;
      const s = live();
      let resolve!: (r: { text: string; tooLong: boolean }) => void;
      const answer = new Promise<{ text: string; tooLong: boolean }>((r) => { resolve = r; });
      let timer: ReturnType<typeof setTimeout> | null = null;
      const u: PendingUtterance = {
        id, tooLong: false, serverEnded: false, ended: false,
        finish: (r) => {
          if (u.ended) return;
          utterances.delete(id);
          u.ended = true;
          if (timer !== null) { clearTimeout(timer); timer = null; }
          resolve(r);
        },
      };
      if (s === null) u.finish(EMPTY);
      else {
        utterances.set(id, u);
        s.send({ t: 'listen', id, mode });
      }
      let endSent = false;
      return {
        id,
        push(pcm) {
          if (u.ended || u.serverEnded || endSent) return;
          live()?.frame(id, pcm);
        },
        end() {
          if (!endSent && !u.ended) {
            endSent = true;
            if (!u.serverEnded) live()?.send({ t: 'end', id });
            timer = setTimeout(() => { timer = null; u.finish({ text: '', tooLong: u.tooLong }); }, END_TIMEOUT_MS);
          }
          return answer;
        },
        cancel() {
          if (u.ended) return;
          live()?.send({ t: 'cancel', id });
          u.finish({ text: '', tooLong: u.tooLong });
        },
      };
    },

    speak(items) {
      const id = nextId++;
      const s = live();
      if (speech !== null) {
        const old = speech;
        player.stop();
        s?.send({ t: 'cancel', id: old.id });
        old.finish();
      }
      let resolve!: () => void;
      const done = new Promise<void>((r) => { resolve = r; });
      if (s === null || items.length === 0) {
        resolve();
        return { done, stop: () => undefined };
      }
      const timer = setTimeout(() => mine.finish(), SPEAK_TIMEOUT_MS);
      const mine: PendingSpeech = {
        id, rate: null, audioEnded: false,
        finish: () => {
          clearTimeout(timer);
          if (speech === mine) speech = null;
          resolve();
        },
      };
      speech = mine;
      s.send({ t: 'speak', id, items: items.slice(0, MAX_SPEAK_ITEMS) });
      return {
        done,
        stop: () => {
          if (speech !== mine) return;
          player.stop();
          live()?.send({ t: 'cancel', id });
          mine.finish();
        },
      };
    },

    onEvent(fn) { events.add(fn); return () => { events.delete(fn); }; },

    close() {
      if (closed) return;
      closed = true;
      const s = socket;
      socket = null;
      opening = null;
      player.stop();
      s?.close();
      endAll();
      events.clear();
    },
  };
}

/** Which provider this build uses: `browser` only on the dev server, when asked for; `service` always in a build. */
export function providerKind(): 'service' | 'browser' {
  return import.meta.env.DEV && import.meta.env.VITE_VOICE_PROVIDER === 'browser' ? 'browser' : 'service';
}

/** Web Speech, on the dev server only. Its module is reached only under `import.meta.env.DEV`, so no build holds it. */
export async function devBrowserProvider(win: Window): Promise<VoiceProvider> {
  if (import.meta.env.DEV) {
    const { browserSpeechProvider } = await import('./browser-speech');
    return browserSpeechProvider(win);
  }
  throw new Error('browser speech is for the dev server only (Ruling 1)');
}

/** Whether this build may show hands-free (C9: the build itself refuses the flag until the echo checklist passed). */
export function handsFreeBuild(): boolean {
  return import.meta.env.VITE_HANDS_FREE === 'on';
}
