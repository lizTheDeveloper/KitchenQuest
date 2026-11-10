import { isValidDate, type MealEntry } from '@kitchenquest/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { countSelfRead } from '../audit/self-reads.js';
import { requireUser } from '../auth/session.js';
import type { Tx } from '../consent/ledger.js';
import { ApiError } from '../errors.js';
import { addDays, createMealLogIn, deleteMealLogIn } from './service.js';
import { loadMeals } from './store.js';

/** The widest range `GET /meals` returns, in days, both ends included. */
const MEAL_RANGE_DAYS = 31;

const RangeQuery = z.object({ from: z.string().max(10), to: z.string().max(10) }).strict();

/** The body of POST /meals: the meal (checked by the service's `validateMeal`, which owns its shape) and the player's yes. */
const MealWrite = z.object({ meal: z.unknown(), confirmed: z.unknown() }).strict();

/**
 * The player's meal logs (H-7). Health data: sealed per user and row
 * (C-3/C-4, C-23), written only with `health_data` consent and
 * `confirmed: true`. Writes are audited by action and row id only (C-5);
 * reads are counted per day (`countSelfRead`). Nothing the player ate is
 * ever in a URL or a log (C-9).
 */
export async function mealRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, now } = app.deps;
  const deps = { keyring: config.keyring };

  /** `from` ≤ `to`, both real dates, at most `MEAL_RANGE_DAYS` days apart counting both. */
  const range = (req: FastifyRequest) => {
    const { from, to } = RangeQuery.parse(req.query);
    if (!isValidDate(from) || !isValidDate(to)) throw new ApiError(400, 'bad_request', 'from and to must be real dates, YYYY-MM-DD');
    if (from > to) throw new ApiError(400, 'bad_request', 'from must not be after to');
    if (to > addDays(from, MEAL_RANGE_DAYS - 1)) throw new ApiError(400, 'bad_request', `The range is at most ${MEAL_RANGE_DAYS} days`);
    return { from, to };
  };

  // Reading needs no consent: after a "keep" withdrawal the logs stay readable.
  app.get('/meals', { preHandler: requireUser }, async (req) => {
    const r = range(req);
    const meals = (await loadMeals(db, config.keyring, req.user.id, r)).map(({ eatenOn, slot, item, id }) => ({ eatenOn, slot, item, id }));
    await countSelfRead(db, req.user.id, 'meals', now());
    return { meals };
  });

  app.post('/meals', { preHandler: requireUser }, async (req, reply) => {
    const at = now();
    const body = req.body;
    if (typeof body !== 'object' || body === null || (body as { confirmed?: unknown }).confirmed !== true) {
      throw new ApiError(400, 'confirmation_required', 'Logging a meal needs your confirmation (confirmed: true)');
    }
    const { meal } = MealWrite.parse(body);
    const saved = await db.transaction((tx: Tx) => createMealLogIn(tx, deps, req.user.id, meal as MealEntry, at, req.id));
    return reply.status(201).send({ meal: saved });
  });

  // No consent and no `confirmed` needed, as for rules: the UI asks first, and
  // kept data must stay deletable after consent is withdrawn.
  app.delete<{ Params: { id: string } }>('/meals/:id', { preHandler: requireUser }, async (req, reply) => {
    const at = now();
    await db.transaction((tx: Tx) => deleteMealLogIn(tx, req.user.id, req.params.id, at, req.id));
    return reply.status(204).send();
  });
}
