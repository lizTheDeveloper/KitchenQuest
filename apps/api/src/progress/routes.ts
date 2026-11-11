import type { RulesContext } from '@kitchenquest/core';
import type { FastifyInstance } from 'fastify';
import { countSelfRead } from '../audit/self-reads.js';
import { requireUser } from '../auth/session.js';
import type { LoopContent } from '../catalog.js';
import type { RecipeIndex, RecipeIndexSource } from '../recipes/recipe-index.js';
import { catalogueFor } from './catalogue.js';
import { eraseMealEventFor, EventsBody, progressViewOf, recordEventsIn } from './service.js';
import type { Tx } from './store.js';

export interface ProgressRouteDeps {
  loop: LoopContent;
  recipes: RecipeIndexSource;
  /**
   * The player's rules and content for a `standsInFor` claim (I3), built by the app from their stored rules and
   * pantry: progress/ reads no rules itself (it imports nothing from rules/ or consent/).
   */
  rulesFor: (tx: Tx, userId: string, today: string, recipes: RecipeIndex) => Promise<RulesContext>;
}

/**
 * The player's progress (U-5, Ruling 7). The game posts progress events, the content-free facts of play; the server
 * validates each against the catalogue and computes what it earned with core `grantsForBatch`, and stores both. No
 * route lets the client name an amount, a level, trust or a grant, and none reads an entitlement (never rule 3).
 * Events are not player data entry, so there is no `confirmed` flag: only the game's own flow posts them, never the
 * mentor. Slugs and quest ids are only in bodies, never in a URL or a log (C-9).
 */
export async function progressRoutes(app: FastifyInstance, deps: ProgressRouteDeps): Promise<void> {
  const { db, now } = app.deps;

  app.get('/progress', { preHandler: requireUser }, async (req) => {
    const recipes = await deps.recipes.current(db);
    const view = await progressViewOf(db, req.user.id, catalogueFor(recipes, deps.loop));
    await countSelfRead(db, req.user.id, 'progress', now());
    return { view };
  });

  /**
   * `{ events, upload?: true }`, at most 100 events (more → 400). 200 `{ accepted, duplicate, rejected, warnings, view }`,
   * also when some events are rejected (the daily cap is a per-event problem, C14). `upload: true` marks the sign-in
   * upload of the device log (Ruling 8): older dates are accepted, and so are `imported` events.
   */
  app.post('/progress/events', { preHandler: requireUser }, async (req) => {
    const at = now();
    const { events, upload } = EventsBody.parse(req.body);
    const userId = req.user.id;
    const today = at.toISOString().slice(0, 10);
    return db.transaction(async (tx: Tx) => {
      const recipes = await deps.recipes.current(tx);
      const progressDeps = {
        catalogue: catalogueFor(recipes, deps.loop),
        rewards: deps.loop.rewards,
        thresholds: deps.loop.thresholds,
        rules: () => deps.rulesFor(tx, userId, today, recipes),
      };
      return recordEventsIn(tx, progressDeps, userId, events, today, at, { upload: upload === true }, req.id);
    });
  });

  /** A meal-log undo (spec §6): erases that log's `meal_logged` event, keeping what it earned. 204, or 404. */
  app.delete<{ Params: { clientId: string } }>('/progress/events/:clientId', { preHandler: requireUser }, async (req, reply) => {
    const at = now();
    await db.transaction((tx: Tx) => eraseMealEventFor(tx, req.user.id, req.params.clientId, at, req.id));
    return reply.status(204).send();
  });
}
