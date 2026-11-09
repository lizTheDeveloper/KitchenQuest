import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecipe, type IngredientGraph, type ParsedRecipe } from '@kitchenquest/core';
import { inArray } from 'drizzle-orm';
import { canonRecipes } from '../db/schema.js';
import type { Db } from '../types.js';

/** The repository's `recipes/` directory: the same canon the game compiles. */
export const RECIPES_DIR = fileURLToPath(new URL('../../../../recipes/', import.meta.url));

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

interface CanonFile {
  /** Path relative to the recipes dir, `/`-separated, with extension. */
  path: string;
  slug: string;
  source: string;
  hash: string;
  recipe: ParsedRecipe;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Reads and parses every `*.cook` under `dir`. Any problem throws, naming the
 * file: a recipe the checker cannot fully resolve must not reach the table.
 * Messages never repeat contributor ids (personal data).
 */
function readCanon(dir: string, graph: IngredientGraph): CanonFile[] {
  const paths = (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.split(sep).join('/'))
    .filter((f) => f.endsWith('.cook'))
    .sort();
  return paths.map((path) => {
    const source = readFileSync(join(dir, path), 'utf8');
    let recipe: ParsedRecipe;
    try {
      recipe = parseRecipe(source);
    } catch (e) {
      throw new Error(`Recipe sync: ${path}: ${(e as Error).message}`);
    }
    const unknown = recipe.ingredients.filter((i) => graph.resolve(i.name) === null).map((i) => i.name);
    if (unknown.length > 0) {
      throw new Error(`Recipe sync: ${path}: ingredients not in the ingredient graph: ${unknown.join(', ')}`);
    }
    return { path, slug: path.slice(0, -'.cook'.length), source, hash: createHash('sha256').update(source).digest('hex'), recipe };
  });
}

/**
 * Makes `canon_recipes` match the `*.cook` files under `recipesDir`, in one
 * transaction: any bad file aborts the whole sync with nothing changed. Rows
 * for deleted files are removed. A row counts as unchanged when both the
 * source hash and the stored contributor ids match.
 */
export async function syncCanon(db: Db, recipesDir: string, graph: IngredientGraph): Promise<SyncResult> {
  const files = readCanon(recipesDir, graph);
  const result: SyncResult = { added: 0, updated: 0, removed: 0, unchanged: 0 };
  await db.transaction(async (tx) => {
    const existing = new Map(
      (await tx.select({ path: canonRecipes.path, hash: canonRecipes.contentHash, contributors: canonRecipes.contributors }).from(canonRecipes)).map(
        (r) => [r.path, r] as const,
      ),
    );
    const keep = files.map((f) => f.path);
    // Removals first, so a renamed file's old row never holds its new slug.
    const gone = [...existing.keys()].filter((p) => !keep.includes(p));
    if (gone.length > 0) await tx.delete(canonRecipes).where(inArray(canonRecipes.path, gone));
    result.removed = gone.length;
    for (const f of files) {
      const prev = existing.get(f.path);
      const contributors = f.recipe.meta.contributors;
      if (prev && prev.hash === f.hash && sameList(prev.contributors, contributors)) {
        result.unchanged++;
        continue;
      }
      const row = {
        slug: f.slug,
        title: f.recipe.meta.title,
        country: f.recipe.meta.country,
        region: f.recipe.meta.region,
        status: f.recipe.meta.status,
        source: f.source,
        contentHash: f.hash,
        contributors,
        syncedAt: new Date(),
      };
      await tx.insert(canonRecipes).values({ path: f.path, ...row }).onConflictDoUpdate({ target: canonRecipes.path, set: row });
      if (prev) result.updated++;
      else result.added++;
    }
  });
  return result;
}
