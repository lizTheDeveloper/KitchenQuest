import { isValidDate, type Plan } from '@kitchenquest/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { countSelfRead } from '../audit/self-reads.js';
import { lockLiveUser } from '../auth/live-user.js';
import { SlidingWindowLimiter, sweepPeriodically } from '../auth/rate-limit.js';
import { requireUser } from '../auth/session.js';
import type { Catalog, LoopContent } from '../catalog.js';
import { ApiError } from '../errors.js';
import type { RecipeIndexSource } from '../recipes/recipe-index.js';
import { finishRunIn, openRunIn, tickIn } from './market-service.js';
import { checksFor, currentWeekStart, deletePlanIn, savePlanIn, type WeekDeps } from './plan-service.js';
import { loadPlan, type Tx } from './store.js';

/** Week requests per player per minute: a whole market list ticked in a minute is well under it (abuse only). */
export const WEEK_REQUESTS_PER_MINUTE = 120;

export interface WeekRouteDeps {
  catalog: Catalog;
  loop: LoopContent;
  recipes: RecipeIndexSource;
}

const WeekParam = z.object({ weekStart: z.string().max(10) }).strict();
const RunParam = z.object({ id: z.uuid() }).strict();
const PlanWrite = z.object({ plan: z.unknown(), confirmed: z.unknown() }).strict();
const OpenBody = z.object({ weekStart: z.string().max(10) }).strict();
const TickBody = z.object({ key: z.string().min(1).max(200), ticked: z.boolean() }).strict();
const FinishBody = z.object({ confirmed: z.unknown() }).strict();

const needsYes = (body: unknown, what: string) => {
  if (typeof body !== 'object' || body === null || (body as { confirmed?: unknown }).confirmed !== true) {
    throw new ApiError(400, 'confirmation_required', `${what} needs your confirmation (confirmed: true)`);
  }
};

/** A plan-week date from a URL or a body: a real YYYY-MM-DD date, or 400. */
const weekDate = (v: string): string => {
  if (!isValidDate(v)) throw new ApiError(400, 'bad_request', 'weekStart must be a real date, YYYY-MM-DD');
  return v;
};

/**
 * The week's records (H-11, Step 6): the player's plan per plan week, and the market run built from it. Sealed per
 * user and row; health data (Step 6 ruling): writes need `health_data` (403 `consent_required`), reads and deletes
 * don't (kept data stays readable and deletable after a withdrawal). A plan save and a run's finish need
 * `confirmed: true`; a tick doesn't (§7.0 "None (undoable)"). Nothing about food is ever in a URL (P-5) or a log
 * (C-9): only a plan-week date and a run id are. Every route is limited per player (429 `rate_limited`).
 * These are also the scripted engine's write path (Step 10) and the write behind Step 8's plan card.
 */
export async function weekRoutes(app: FastifyInstance, deps: WeekRouteDeps): Promise<void> {
  const { db, config, now } = app.deps;
  const limiter = new SlidingWindowLimiter(WEEK_REQUESTS_PER_MINUTE, 60_000);
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
  const pre = { preHandler: [requireUser, limited] };
  const weekDeps = async (tx: Tx): Promise<WeekDeps> => ({ keyring: config.keyring, catalog: deps.catalog, loop: deps.loop, recipes: await deps.recipes.current(tx) });

  /** `{ plan | null, weekStart, checks }`: the current plan week, from the profile's market days and the clock. */
  app.get('/plans/current', pre, async (req) => {
    const at = now();
    const userId = req.user.id;
    const out = await db.transaction(async (tx: Tx) => {
      await lockLiveUser(tx, userId);
      const weekStart = await currentWeekStart(tx, userId, at);
      const wd = await weekDeps(tx);
      const found = await loadPlan(tx, config.keyring, userId, weekStart);
      // Checked now, with the player's rules as they are now: a rule added since shows the dish as ⛔.
      const checks = found === null ? [] : await checksFor(tx, wd, userId, found);
      return { plan: found, weekStart, checks };
    });
    await countSelfRead(db, userId, 'plans', at);
    return out;
  });

  app.put('/plans/:weekStart', pre, async (req) => {
    const at = now();
    const { weekStart } = WeekParam.parse(req.params);
    needsYes(req.body, 'Saving your plan');
    const { plan } = PlanWrite.parse(req.body);
    weekDate(weekStart);
    if (typeof plan !== 'object' || plan === null || (plan as { weekStart?: unknown }).weekStart !== weekStart) {
      throw new ApiError(400, 'plan_invalid', 'The plan is not valid', { problems: ['plan: weekStart does not match the URL'] });
    }
    return db.transaction(async (tx: Tx) => {
      const wd = await weekDeps(tx);
      const saved = await savePlanIn(tx, wd, req.user.id, plan as Plan, at, req.id);
      return { plan: saved.plan, checks: await checksFor(tx, wd, req.user.id, saved.plan) };
    });
  });

  app.delete('/plans/:weekStart', pre, async (req, reply) => {
    const at = now();
    const weekStart = weekDate(WeekParam.parse(req.params).weekStart);
    await db.transaction((tx: Tx) => deletePlanIn(tx, req.user.id, weekStart, at, req.id));
    return reply.status(204).send();
  });

  app.post('/market-runs', pre, async (req) => {
    const at = now();
    const weekStart = weekDate(OpenBody.parse(req.body).weekStart);
    return db.transaction(async (tx: Tx) => openRunIn(tx, await weekDeps(tx), req.user.id, weekStart, at, req.id));
  });

  app.post('/market-runs/:id/ticks', pre, async (req) => {
    const at = now();
    const { id } = RunParam.parse(req.params);
    const { key, ticked } = TickBody.parse(req.body);
    return db.transaction(async (tx: Tx) => tickIn(tx, await weekDeps(tx), req.user.id, id, key, ticked, at, req.id));
  });

  app.post('/market-runs/:id/finish', pre, async (req) => {
    const at = now();
    const { id } = RunParam.parse(req.params);
    needsYes(req.body, 'Finishing the shop');
    FinishBody.parse(req.body);
    return db.transaction(async (tx: Tx) => finishRunIn(tx, await weekDeps(tx), req.user.id, id, at, req.id));
  });
}
