// The market's lazy content (M6 Step 5): the four stalls and The Season's Table, in their own chunk so first paint
// never carries them. The one dynamic import of `virtual:kq-market`; only the market screens (Steps 9–10) call it.
import { STALL_IDS } from '@kitchenquest/core/engine';
import type { MarketContent } from '../content/types';

type Importer = () => Promise<{ default: MarketContent }>;

/** Freezes every object and array in the tree (the Step 2 carry: no screen can change a season or a question). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The whole bank or nothing: a module missing a stall, the table or its version is refused, never half-used. */
function checked(module: unknown): MarketContent {
  const m = (typeof module === 'object' && module !== null ? module : {}) as { stalls?: unknown; seasonality?: unknown; version?: unknown };
  const stalls = (typeof m.stalls === 'object' && m.stalls !== null ? m.stalls : {}) as Record<string, unknown>;
  const isMap = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
  // Each stall whole (fix round 1, M7): its banks and line maps, not just an object.
  const whole = (v: unknown): boolean => {
    if (!isMap(v)) return false;
    const s = v as Record<string, unknown>;
    return Array.isArray(s.questions) && Array.isArray(s.faq) && isMap(s.triggers) && isMap(s.games) && isMap(s.item_tips);
  };
  const missing = STALL_IDS.filter((id) => id !== 'general' && !whole(stalls[id]));
  if (missing.length > 0 || typeof m.seasonality !== 'object' || m.seasonality === null || typeof m.version !== 'string') {
    throw new Error(`market content is incomplete${missing.length > 0 ? ` (missing or partial: ${missing.join(', ')})` : ''}`);
  }
  return deepFreeze(m as MarketContent);
}

/**
 * A memoised loader around `importer`. Concurrent and later calls share one import. A failed import (offline before
 * the chunk was ever cached, or an incomplete module) rejects, and the next call tries again: the screen shows its
 * offline line, never a partial bank.
 */
export function marketLoader(importer: Importer): () => Promise<MarketContent> {
  let pending: Promise<MarketContent> | null = null;
  return () => {
    pending ??= importer()
      .then((m) => checked(m.default))
      .catch((e: unknown) => {
        pending = null;
        throw e;
      });
    return pending;
  };
}

// typescript-eslint sees the `virtual:` module as an error type even though tsc resolves it via src/virtual.d.ts.
/** The market's content: the stalls (client shape) and The Season's Table, frozen. Imported once, then memoised. */
export const loadMarket: () => Promise<MarketContent> = marketLoader(() => import('virtual:kq-market'));
