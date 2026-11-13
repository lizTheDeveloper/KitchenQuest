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
  /**
   * M7 Step 7 (M6 fix review N1): the account's current erasure id (`users.health_erasure`, new on every `health_data`
   * delete; null before the first). Both routes return it as `healthErasure`, so a signed-in device that sees a new one
   * erases its own copy of the stall rounds and meal-log events (the game's `applyServerErasure`).
   */
  healthErasureFor: (tx: Tx, userId: string) => Promise<string | null>;
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
    // One snapshot (M1): the events and the grants come from the same moment. The sealed progress snapshot (M6 Step 7)
    // and the events after it are read in that same transaction.
    const { view, healthErasure } = await db.transaction(
      async (tx: Tx) => ({
        view: await progressViewOf(tx, config.keyring, req.user.id, catalogueFor(await deps.recipes.current(tx), deps.loop), {
          rewards: deps.loop.rewards,
          thresholds: deps.loop.thresholds,
          log: req.log,
        }),
        // N1: read in the same snapshot as the view, so a view without the erased rounds always comes with its id.
        healthErasure: await deps.healthErasureFor(tx, req.user.id),
      }),
      { isolationLevel: 'repeatable read' },
    );
    await countSelfRead(db, req.user.id, 'progress', now());
    return { view, healthErasure };
  });

  /**
   * `{ events, upload?: true, erasure?: string | null }`, at most 100 events (more → 400). 200 `{ accepted, duplicate,
   * rejected, warnings, view, healthErasure }`; a stall round from a device whose `erasure` is not the account's current
   * one is rejected `erased` (M7 Step 7 fix round 1, I1; fix round 2, R1: stall rounds only),
   * also when some events are rejected (the daily event cap is a per-event problem, C14). `upload: true` marks the
   * sign-in upload of the device log (Ruling 8): older dates are accepted, and so are `imported` events.
   */
  app.post('/progress/events', { preHandler: [requireUser, limited] }, async (req) => {
    const at = now();
    // M7 Step 7 fix round 1 (I1): `erasure`, the erasure id the posting device last acted on (null or absent if none),
    // is read here and taken off before the body is parsed (EventsBody is strict).
    const { erasure: seen, ...rest } = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    if (seen !== undefined && seen !== null && typeof seen !== 'string') throw new ApiError(400, 'bad_request', 'erasure must be a string or null');
    const { events: posted, upload } = EventsBody.parse(rest);
    const userId = req.user.id;
    const today = at.toISOString().slice(0, 10);
    return db.transaction(async (tx: Tx) => {
      // I1: a device that has not seen the account's current erasure id may still hold stall rounds recorded before that
      // `health_data` delete. They are refused (`erased`, content-free) and never stored; the answer carries the current
      // id, so the device erases its copy too (it keeps their grants, and re-posts a live round once under the new id).
      // Fix round 2 (R1): meal-log events are not refused here: a pre-erasure one names a meal log the delete removed
      // (`unknown_meal_log`), and one after a withdrawal needs consent. Other kinds go on as before.
      const current = await deps.healthErasureFor(tx, userId);
      const stale = current !== null && seen !== current;
      const erased = (e: unknown): e is { id: unknown } => stale && typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === 'stall_round';
      const refused = posted.filter(erased).flatMap((e) => (typeof e.id === 'string' ? [{ clientId: e.id, problems: ['erased'] }] : []));
      const events = posted.filter((e) => !erased(e));
      const recipes = await deps.recipes.current(tx);
      const progressDeps = {
        keyring: config.keyring,
        catalogue: catalogueFor(recipes, deps.loop),
        rewards: deps.loop.rewards,
        thresholds: deps.loop.thresholds,
        rules: () => deps.rulesFor(tx, userId, today, recipes),
        healthConsent: () => deps.healthConsentFor(tx, userId, at),
        writeCap: () => deps.writeCapFor(tx, userId, at),
        log: req.log,
      };
      const recorded = await recordEventsIn(tx, progressDeps, userId, events, today, at, { upload: upload === true }, req.id);
      return { ...recorded, rejected: [...refused, ...recorded.rejected], healthErasure: current };
    });
  });
}
