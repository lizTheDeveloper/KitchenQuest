/**
 * M6 Step 10 fix round 1 (I2): the most any market-day lookup may hold up an errand or cook mode. A lookup that
 * hasn't answered by then counts as no answer, and the screen goes on exactly as it did before M6.
 */
export const LOOKUP_TIMEOUT_MS = 3000;

/** `p`, or `fallback` once `ms` pass first or `p` rejects. Never rejects. The late answer is ignored. */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(fallback); }, ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}
