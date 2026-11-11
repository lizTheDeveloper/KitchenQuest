import type { MentorBackend, MentorInput } from './backend';
import type { PanReply, TurnContext } from './reply';

export type LazyFallback = (input: MentorInput, ctx: TurnContext) => Promise<PanReply>;

/**
 * A backend whose code loads on its first reply (the AI backend is not needed for first paint). A late reply and
 * `dispose` reach the real backend once it exists. If the code can't load (offline with no worker, a removed
 * chunk), the turn is answered by `fallback`, the script, never left without an answer; the load is tried again next turn.
 */
export function lazyBackend(kind: MentorBackend['kind'], fallback: LazyFallback, load: () => Promise<MentorBackend>): MentorBackend {
  let real: MentorBackend | null = null;
  let loading: Promise<MentorBackend> | null = null;
  let disposed = false;
  const listeners = new Set<(r: PanReply) => void>();
  const get = (): Promise<MentorBackend> => {
    loading ??= load().then((b) => {
      real = b;
      if (disposed) b.dispose?.();
      else b.onLate?.((r) => { for (const fn of listeners) fn(r); });
      return b;
    }, (err: unknown) => { loading = null; throw err; });
    return loading;
  };
  return {
    kind,
    async reply(input, ctx) {
      let backend: MentorBackend;
      try {
        backend = await get();
      } catch (err) {
        console.error(err);
        return fallback(input, ctx);
      }
      return backend.reply(input, ctx);
    },
    onLate(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    dispose() {
      disposed = true;
      real?.dispose?.();
      listeners.clear();
    },
  };
}
