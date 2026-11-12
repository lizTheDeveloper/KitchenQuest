import { AsyncLocalStorage } from 'node:async_hooks';
import type { AiProvider } from '../src/ai/provider.js';

/**
 * M7 Step 7 (Ruling 18): the runner's model-call counter, per turn. A turn runs inside `countModelCalls`, and every
 * `complete` of the counting provider made while it runs (in that async context, so two turns in flight at once never
 * share a count) adds one to that turn's count. The judge reads the count against a case's `modelCalled`.
 */
const current = new AsyncLocalStorage<{ n: number }>();

/** `ai` with every call counted against the turn in flight (calls outside any turn are not counted). */
export function countingProvider(ai: AiProvider): AiProvider {
  return {
    model: ai.model,
    complete(req) {
      const counter = current.getStore();
      if (counter !== undefined) counter.n++;
      return ai.complete(req);
    },
  };
}

/** Runs `fn` as one turn and returns its result with the number of model calls it made. */
export async function countModelCalls<T>(fn: () => Promise<T>): Promise<{ result: T; modelCalls: number }> {
  const counter = { n: 0 };
  const result = await current.run(counter, fn);
  return { result, modelCalls: counter.n };
}
