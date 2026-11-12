import { check, isValidDate, nutritionPerServing, parseRecipe, validateRules, type ParsedRecipe, type Rule } from '@kitchenquest/core';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { countSelfRead } from '../audit/self-reads.js';
import { SlidingWindowLimiter, sweepPeriodically } from '../auth/rate-limit.js';
import { requireUser } from '../auth/session.js';
import type { Catalog } from '../catalog.js';
import { canonRecipes } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { loadRules } from '../rules/store.js';

/** Recipe list and detail requests per player per minute (M-5): each decrypts every rule. */
export const RECIPE_READS_PER_MINUTE = 120;

/**
 * Canon recipes, checked for the signed-in player against their own stored
 * rules and today's date. The check is core's `check`; the API only supplies
 * the rules. Signed-in only, no consent needed: recipes are free forever, and
 * a player with no rules (or whose rules were deleted) gets `rules = []`.
 * After a "keep" withdrawal the stored rules are still used, so the check
 * never gets less careful than what the player told us.
 * `source` is the file as written, front matter included; any contributors
 * line in it is public CC BY-SA data. `meta` omits the parsed contributors.
 * Each request decrypts the player's rules, so it counts as a self-read of
 * them (`countSelfRead`, C-5), and is limited per player.
 */
export async function recipeRoutes(app: FastifyInstance, catalog: Catalog): Promise<void> {
  const { db, config, now } = app.deps;
  // Per app instance, in memory only (N-2).
  const limiter = new SlidingWindowLimiter(config.recipeReadsPerMinute ?? RECIPE_READS_PER_MINUTE, 60_000);
  const stopSweeping = sweepPeriodically([limiter], () => now().getTime());
  app.addHook('onClose', (_app, done) => {
    stopSweeping();
    done();
  });

  /** preHandler after requireUser: 429 `rate_limited` past the per-player limit. */
  const limited = async (req: FastifyRequest, reply: FastifyReply) => {
    const t = now().getTime();
    const wait = limiter.waitMs(req.user.id, t);
    if (wait > 0) {
      reply.header('retry-after', String(Math.ceil(wait / 1000)));
      throw new ApiError(429, 'rate_limited', 'Too many requests; try again shortly');
    }
    limiter.hit(req.user.id, t);
  };

  const summary = (recipe: ParsedRecipe, rules: Rule[], today: string) => {
    const { status, severe, disclaimer } = check(recipe, rules, catalog.graph, [...catalog.substitutions], today);
    return { status, severe, disclaimer };
  };
  const DAY_MS = 86_400_000;
  const DateQuery = z.object({ date: z.string().optional() }).strict();

  /**
   * The date to check against: the player's local date from `?date=` when
   * given (a real date within a day of the server's UTC date, which covers
   * every time zone), else the server's UTC date.
   */
  const checkDate = (req: FastifyRequest): string => {
    const at = now();
    const utc = at.toISOString().slice(0, 10);
    const { date } = DateQuery.parse(req.query);
    if (date === undefined) return utc;
    const offDays = isValidDate(date) ? Math.abs(Date.parse(`${date}T00:00:00Z`) - Date.parse(`${utc}T00:00:00Z`)) / DAY_MS : Infinity;
    if (offDays > 1) throw new ApiError(400, 'bad_request', 'date must be a valid YYYY-MM-DD within a day of today');
    return date;
  };

  /**
   * The player's rules, counted as a self-read (M-6), or 409 when they no
   * longer validate against the catalog. No core problem text is passed on:
   * it names the ingredients. A rule that cannot be opened throws (500): the
   * check never runs without it.
   */
  const playerRules = async (userId: string): Promise<Rule[]> => {
    const rules = await loadRules(db, config.keyring, userId);
    await countSelfRead(db, userId, 'rules', now());
    if (validateRules(rules, catalog.graph).length > 0) {
      throw new ApiError(409, 'rules_need_review', 'Some of your saved rules need review.');
    }
    return rules;
  };

  app.get('/recipes', { preHandler: [requireUser, limited] }, async (req) => {
    const date = checkDate(req);
    const rules = await playerRules(req.user.id);
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

  app.get<{ Params: { '*': string } }>('/recipes/*', { preHandler: [requireUser, limited] }, async (req) => {
    const date = checkDate(req);
    const slug = req.params['*'];
    const [row] = await db.select().from(canonRecipes).where(eq(canonRecipes.slug, slug));
    if (!row) throw new ApiError(404, 'not_found', 'Recipe not found');
    const recipe = parseRecipe(row.source);
    const rules = await playerRules(req.user.id);
    const { contributors: _contributors, ...meta } = recipe.meta;
    return {
      slug: row.slug,
      title: recipe.meta.title,
      meta,
      source: recipe.source,
      ingredients: recipe.ingredients,
      check: check(recipe, rules, catalog.graph, [...catalog.substitutions], date),
      nutrition: nutritionPerServing(recipe, catalog.graph),
    };
  });
}
