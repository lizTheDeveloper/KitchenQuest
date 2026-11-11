import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { accountRoutes } from './account/routes.js';
import type { AiProvider } from './ai/provider.js';
import { sweepPeriodically } from './auth/rate-limit.js';
import { authRoutes } from './auth/routes.js';
import { bookRoutes } from './book/routes.js';
import { requireUser } from './auth/session.js';
import { frameOptions } from '@kitchenquest/core';
import { defaultCatalog, defaultLoopContent, type Catalog, type LoopContent } from './catalog.js';
import { consentHeldIn } from './consent/ledger.js';
import { consentRoutes } from './consent/routes.js';
import { mealRoutes } from './meals/routes.js';
import { BudgetGuard } from './mentor/allowance.js';
import { HISTORY_MESSAGES, MEMORY_TTL_MS } from './mentor/constants.js';
import { MemoryFlags, MemoryHistory } from './mentor/memory.js';
import { mentorRoutes, type MentorState } from './mentor/routes.js';
import { pantryRoutes } from './pantry/routes.js';
import { profileRoutes } from './profile/routes.js';
import { progressRoutes, type ProgressRouteDeps } from './progress/routes.js';
import { createRecipeIndexSource } from './recipes/recipe-index.js';
import { recipeRoutes } from './recipes/routes.js';
import { rulesRoutes } from './rules/routes.js';
import { loadRules } from './rules/store.js';
import { loadPantry } from './pantry/store.js';
import { assertUnderWriteCap } from './usage/write-cap.js';
import { weekRoutes } from './week/routes.js';
import type { Config } from './config.js';
import { ApiError, loggableError } from './errors.js';
import type { Db, Mailer } from './types.js';

export interface Deps {
  config: Config;
  db: Db;
  mailer: Mailer;
  /** The model behind the Pan; null means AI is off and the mentor runs scripted only. Tests pass fakeAi. */
  ai: AiProvider | null;
  now: () => Date;
  /** Fastify logger option: `false` in tests, pino options/stream in the server. */
  logger: FastifyServerOptions['logger'];
  /** Ingredient graph and substitutions; defaults to `data/`, loaded once (boot fails on bad data). */
  catalog?: Catalog;
  /** The weekly loop's data and content (C10); defaults to `data/` and `content/`, checked against the catalog at boot. */
  loop?: LoopContent;
}

function body(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  // First, so bad safety data stops the server before anything else starts.
  const catalog = deps.catalog ?? defaultCatalog();
  const loop = deps.loop ?? defaultLoopContent();
  const tp = deps.config.trustProxy;
  // A hop count works at runtime but is missing from Fastify's types; this is the function it builds.
  const trustProxy = typeof tp === 'number' ? (_addr: string, hop: number) => hop < tp : tp;
  const app = Fastify({ logger: deps.logger, trustProxy });
  // JSON bodies only. Fastify's default text/plain parser would let a cross-site
  // form or no-cors fetch (no preflight) reach the POST routes.
  app.removeContentTypeParser('text/plain');
  app.decorate('deps', deps);

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send(body('not_found', 'Route not found'));
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return reply.status(400).send(body('bad_request', 'Invalid request', details));
    }
    if (err instanceof ApiError) {
      // A service's 429 (the daily write cap) says when to come back in its details.
      const retry = (err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      if (err.status === 429 && typeof retry === 'number') reply.header('retry-after', String(retry));
      return reply.status(err.status).send(body(err.code, err.message, err.details));
    }
    // Fastify's own 4xx (malformed JSON, payload too large, ...): keep its status.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send(body('bad_request', (err as Error).message));
    }
    // Not under `err`: pino's err serializer would copy every property back in.
    req.log.error({ error: loggableError(err) }, 'request failed');
    return reply.status(500).send(body('internal', 'Internal server error'));
  });

  // The mentor's in-memory stores (history without health_data consent, child flags), never
  // written anywhere; swept every minute. Account delete, health_data withdraw and forget clear a user's.
  const mentor: MentorState = {
    memory: new MemoryHistory({ ttlMs: MEMORY_TTL_MS, max: HISTORY_MESSAGES }),
    childFlags: new MemoryFlags({ ttlMs: MEMORY_TTL_MS }),
    budget: deps.config.ai ? new BudgetGuard(deps.db, deps.config.ai.dailyBudgetMicroUsd) : null,
  };
  app.decorate('mentor', mentor);
  const stopSweeping = sweepPeriodically([mentor.memory, mentor.childFlags], () => deps.now().getTime());
  app.addHook('onClose', (_app, done) => {
    stopSweeping();
    done();
  });

  await app.register(cookie);
  app.decorate('requireUser', requireUser);
  app.decorateRequest('user', null as never);

  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify handlers return a promise or call reply; async is the idiom
  app.get('/health', async () => ({ ok: true }));
  await authRoutes(app);
  await profileRoutes(app);
  await consentRoutes(app);
  await rulesRoutes(app, catalog);
  await recipeRoutes(app, catalog);
  await mealRoutes(app);
  await pantryRoutes(app, catalog);
  await mentorRoutes(app, catalog, mentor);
  // C7: one recipe index for the app, re-read when a recipe sync changes canon_recipes.
  const recipes = createRecipeIndexSource();
  const progress: ProgressRouteDeps = {
    loop,
    recipes,
    // I3: a cook's standsInFor claim is judged with the player's stored rules, and their pantry for the frames.
    rulesFor: async (tx, userId, today, index) => {
      const rules = await loadRules(tx, deps.config.keyring, userId);
      const subs = [...catalog.substitutions];
      const pantry = await loadPantry(tx, deps.config.keyring, userId);
      const frames = frameOptions(loop.frames, pantry, { rules, graph: catalog.graph, subs, today, keeps: loop.keeps });
      return { rules, graph: catalog.graph, subs, recipes: index, frames };
    },
    // I1: a meal-log event needs health_data, as POST /meals does (share-locked, after the advisory locks).
    healthConsentFor: (tx, userId, at) => consentHeldIn(tx, userId, 'health_data', at),
    // I4: the M4 daily write cap, the same for every player and plan; it counts recorded progress posts.
    writeCapFor: (tx, userId, at) => assertUnderWriteCap(tx, userId, ['progress.record'], at),
  };
  await progressRoutes(app, progress);
  // Step 6: plans and market runs, on the same recipe index and loop content.
  await weekRoutes(app, { catalog, loop, recipes });
  // Step 7: margin notes and Cooked for Someone, on the same recipe index and loop content.
  await bookRoutes(app, { catalog, loop, recipes });
  await accountRoutes(app, progress);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
    /** The mentor's in-memory stores, shared with the routes that must clear them. */
    mentor: MentorState;
  }
}
