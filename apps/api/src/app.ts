import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import type { Db, Mailer } from './types.js';

export interface Deps {
  config: Config;
  db: Db;
  mailer: Mailer;
  now: () => Date;
}

function body(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
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
    // Fastify's own 4xx (malformed JSON, payload too large, ...).
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(400).send(body('bad_request', 'Malformed request'));
    }
    req.log.error(err);
    return reply.status(500).send(body('internal', 'Internal server error'));
  });

  app.get('/health', async () => ({ ok: true }));

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
  }
}
