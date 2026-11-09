import { check, nutritionPerServing, parseRecipe, type ParsedRecipe, type Rule } from '@kitchenquest/core';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/session.js';
import type { Catalog } from '../catalog.js';
import { canonRecipes } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { loadRules } from '../rules/routes.js';

/**
 * Canon recipes, checked for the signed-in player against their own stored
 * rules and today's date. The check is core's `check`; the API only supplies
 * the rules. Signed-in only, no consent needed: recipes are free forever, and
 * a player with no rules (or whose rules were deleted) gets `rules = []`.
 * After a "keep" withdrawal the stored rules are still used, so the check
 * never gets less careful than what the player told us.
 * Contributor ids are stored but not returned here.
 */
export async function recipeRoutes(app: FastifyInstance, catalog: Catalog): Promise<void> {
  const { db, config, now } = app.deps;

  const summary = (recipe: ParsedRecipe, rules: Rule[], today: string) => {
    const { status, severe, disclaimer } = check(recipe, rules, catalog.graph, [...catalog.substitutions], today);
    return { status, severe, disclaimer };
  };
  const today = () => now().toISOString().slice(0, 10);

  app.get('/recipes', { preHandler: requireUser }, async (req) => {
    const rules = await loadRules(db, config.keyring, req.user.id);
    const date = today();
    const rows = await db.select().from(canonRecipes).orderBy(asc(canonRecipes.country), asc(canonRecipes.title));
    return {
      recipes: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        country: r.country,
        region: r.region,
        status: r.status,
        check: summary(parseRecipe(r.source), rules, date),
      })),
    };
  });

  app.get<{ Params: { '*': string } }>('/recipes/*', { preHandler: requireUser }, async (req) => {
    const slug = req.params['*'];
    const [row] = await db.select().from(canonRecipes).where(eq(canonRecipes.slug, slug));
    if (!row) throw new ApiError(404, 'not_found', 'Recipe not found');
    const recipe = parseRecipe(row.source);
    const rules = await loadRules(db, config.keyring, req.user.id);
    const { contributors: _contributors, ...meta } = recipe.meta;
    return {
      slug: row.slug,
      title: recipe.meta.title,
      meta,
      source: recipe.source,
      ingredients: recipe.ingredients,
      check: check(recipe, rules, catalog.graph, [...catalog.substitutions], today()),
      nutrition: nutritionPerServing(recipe, catalog.graph),
    };
  });
}
