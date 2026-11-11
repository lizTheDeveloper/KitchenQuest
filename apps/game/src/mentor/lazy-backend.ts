import type { MentorBackend, MentorInput } from './backend';
import type { PanReply, TurnContext } from './reply';

export type LazyFallback = (input: MentorInput, ctx: TurnContext) => Promise<PanReply>;
/** How long a turn waits for the code before the script answers it. */
export const LOAD_TIMEOUT_MS = 8000;

/**
 * A backend whose code loads on its first reply (the AI backend is not needed for first paint). A late reply and
 * `dispose` reach the real backend once it exists. If the code can't load (offline with no worker, a removed
 * chunk), the turn is answered by `fallback`, the script, never left without an answer; the load is tried again next turn.
 */
export function lazyBackend(
  kind: MentorBackend['kind'],
  { fallback, local, timeoutMs = LOAD_TIMEOUT_MS }: { fallback: LazyFallback; local?: (input: MentorInput, ctx: TurnContext) => PanReply | null; timeoutMs?: number },
  load: () => Promise<MentorBackend>,
): MentorBackend {
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
      // Fixed safety answers (emergency, medical, child) never wait on the code.
      const now = local?.(input, ctx) ?? null;
      if (now !== null) return now;
      let backend: MentorBackend;
      try {
        backend = await withTimeout(get(), timeoutMs);
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

/** The load keeps going after a timeout (a later turn may find it done); only this turn stops waiting. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error(`the AI backend did not load in ${ms} ms`)); }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}
