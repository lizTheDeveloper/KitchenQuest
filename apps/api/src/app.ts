import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { accountRoutes } from './account/routes.js';
import type { AiProvider } from './ai/provider.js';
import { authRoutes } from './auth/routes.js';
import { requireUser } from './auth/session.js';
import { defaultCatalog, type Catalog } from './catalog.js';
import { consentRoutes } from './consent/routes.js';
import { mealRoutes } from './meals/routes.js';
import { pantryRoutes } from './pantry/routes.js';
import { profileRoutes } from './profile/routes.js';
import { recipeRoutes } from './recipes/routes.js';
import { rulesRoutes } from './rules/routes.js';
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
}

function body(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  // First, so bad safety data stops the server before anything else starts.
  const catalog = deps.catalog ?? defaultCatalog();
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
  await accountRoutes(app);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
  }
}
