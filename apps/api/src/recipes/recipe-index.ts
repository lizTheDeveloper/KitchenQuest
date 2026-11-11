import { parseRecipe, type ParsedRecipe } from '@kitchenquest/core';
import { sql } from 'drizzle-orm';
import { canonRecipes } from '../db/schema.js';
import type { Db } from '../types.js';
import type { Tx } from '../consent/ledger.js';

/** C7: every canon recipe, canon slug → `canon_recipes.source` parsed. Shared by progress (Step 5) and Steps 6, 7 and 8. */
export type RecipeIndex = ReadonlyMap<string, ParsedRecipe>;

export interface RecipeIndexSource {
  /** The index as `canon_recipes` holds it now; the same object while the table is unchanged. */
  current(db: Db | Tx): Promise<RecipeIndex>;
}

/**
 * A source that re-parses `canon_recipes` only when it has changed since the last call: when `max(synced_at)` or the
 * row count differs (a sync stamps `synced_at` on every row it adds or updates; the count catches a removal). So a
 * recipe sync is picked up by the next request without a restart, and a quiet table costs one small query.
 * The sync parses every file before it writes, so a row that fails to parse here is a bug, and it throws.
 */
export function createRecipeIndexSource(): RecipeIndexSource {
  let stamp: string | null = null;
  let index: RecipeIndex = new Map();
  return {
    async current(db) {
      const [row] = await db
        .select({ latest: sql<string | null>`max(${canonRecipes.syncedAt})::text`, n: sql<number>`count(*)::int` })
        .from(canonRecipes);
      const now = `${row?.latest ?? ''}|${row?.n ?? 0}`;
      if (now === stamp) return index;
      const rows = await db.select({ slug: canonRecipes.slug, source: canonRecipes.source }).from(canonRecipes);
      const next = new Map<string, ParsedRecipe>();
      for (const r of [...rows].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
        try {
          next.set(r.slug, parseRecipe(r.source));
        } catch (e) {
          throw new Error(`RecipeIndex: canon recipe ${r.slug} does not parse: ${(e as Error).message}`);
        }
      }
      index = next;
      stamp = now;
      return index;
    },
  };
}
