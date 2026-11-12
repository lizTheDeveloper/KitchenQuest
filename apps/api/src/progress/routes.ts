import type { RulesContext } from '@kitchenquest/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { countSelfRead } from '../audit/self-reads.js';
import { SlidingWindowLimiter, sweepPeriodically } from '../auth/rate-limit.js';
import { requireUser } from '../auth/session.js';
import type { LoopContent } from '../catalog.js';
import { ApiError } from '../errors.js';
import type { RecipeIndex, RecipeIndexSource } from '../recipes/recipe-index.js';
import { catalogueFor } from './catalogue.js';
import { EventsBody, progressViewOf, recordEventsIn } from './service.js';
import type { Tx } from './store.js';

/** Progress requests per player per minute (I4 ruling): a 2000-event sign-in upload is 20; one ledger fold each. */
export const PROGRESS_REQUESTS_PER_MINUTE = 60;

export interface ProgressRouteDeps {
  loop: LoopContent;
  recipes: RecipeIndexSource;
  /**
   * The player's rules and content for a `standsInFor` claim (I3), built by the app from their stored rules and
   * pantry: progress/ reads no rules itself (it imports nothing from rules/ or consent/).
   */
  rulesFor: (tx: Tx, userId: string, today: string, recipes: RecipeIndex) => Promise<RulesContext>;
  /** The app's `consentHeldIn(tx, userId, 'health_data', at)`: share-locks the grant, says whether there is one. */
  healthConsentFor: (tx: Tx, userId: string, at: Date) => Promise<boolean>;
  /** The app's M4 daily write cap on 'progress.record' (429 `rate_limited` with `retryAfterSeconds`). */
  writeCapFor: (tx: Tx, userId: string, at: Date) => Promise<void>;
}

/**
 * The player's progress (U-5, Ruling 7). The game posts progress events, the content-free facts of play; the server
 * validates each against the catalogue and computes what it earned with core `grantsForBatch`, and stores both. No
 * route lets the client name an amount, a level, trust or a grant, and none reads an entitlement (never rule 3).
 * Events are not player data entry, so there is no `confirmed` flag: only the game's own flow posts them, never the
 * mentor. Slugs and quest ids are only in bodies, never in a URL or a log (C-9). Both routes are limited per player
 * (429 `rate_limited`, `retry-after`); a refused request changes nothing already stored.
 * A meal-log undo needs no route here: deleting the meal log erases its event (I1 ruling).
 * M6 Step 6: a `stall_round` is judged by core against the stall files loaded at boot (`Catalogue.market`) with the
 * player's rules, sealed per row with their key (`config.keyring`), and needs `health_data` only when it is a Protein
 * Counter round; no stall, question or pick is ever in a URL or a log.
 */
export async function progressRoutes(app: FastifyInstance, deps: ProgressRouteDeps): Promise<void> {
  const { db, now, config } = app.deps;
  // Per app instance, in memory only (N-2).
  const limiter = new SlidingWindowLimiter(PROGRESS_REQUESTS_PER_MINUTE, 60_000);
  const stopSweeping = sweepPeriodically([limiter], () => now().getTime());
  app.addHook('onClose', (_app, done) => {
    stopSweeping();
    done();
  });
  const limited = async (req: FastifyRequest, reply: FastifyReply) => {
    const t = now().getTime();
    const wait = limiter.waitMs(req.user.id, t);
    if (wait > 0) {
      reply.header('retry-after', String(Math.ceil(wait / 1000)));
      throw new ApiError(429, 'rate_limited', 'Too many requests; try again shortly', { retryAfterSeconds: Math.ceil(wait / 1000) });
    }
    limiter.hit(req.user.id, t);
  };

  app.get('/progress', { preHandler: [requireUser, limited] }, async (req) => {
    // One snapshot (M1): the events and the grants come from the same moment.
    const view = await db.transaction(
      async (tx: Tx) => progressViewOf(tx, config.keyring, req.user.id, catalogueFor(await deps.recipes.current(tx), deps.loop)),
      { isolationLevel: 'repeatable read' },
    );
    await countSelfRead(db, req.user.id, 'progress', now());
    return { view };
  });

  /**
   * `{ events, upload?: true }`, at most 100 events (more → 400). 200 `{ accepted, duplicate, rejected, warnings, view }`,
   * also when some events are rejected (the daily event cap is a per-event problem, C14). `upload: true` marks the
   * sign-in upload of the device log (Ruling 8): older dates are accepted, and so are `imported` events.
   */
  app.post('/progress/events', { preHandler: [requireUser, limited] }, async (req) => {
    const at = now();
    const { events, upload } = EventsBody.parse(req.body);
    const userId = req.user.id;
    const today = at.toISOString().slice(0, 10);
    return db.transaction(async (tx: Tx) => {
      const recipes = await deps.recipes.current(tx);
      const progressDeps = {
        keyring: config.keyring,
        catalogue: catalogueFor(recipes, deps.loop),
        rewards: deps.loop.rewards,
        thresholds: deps.loop.thresholds,
        rules: () => deps.rulesFor(tx, userId, today, recipes),
        healthConsent: () => deps.healthConsentFor(tx, userId, at),
        writeCap: () => deps.writeCapFor(tx, userId, at),
      };
      return recordEventsIn(tx, progressDeps, userId, events, today, at, { upload: upload === true }, req.id);
    });
  });
}
