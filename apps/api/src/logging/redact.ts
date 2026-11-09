import type { FastifyRequest, FastifyReply, FastifyServerOptions } from 'fastify';
import { scrubForLog } from '../errors.js';

/**
 * C-9: what the request logger may write. A request is logged as its method,
 * route *pattern* (`/rules/:id`, never `/rules/abc?q=peanut`) and request id.
 * Unmatched routes log `(unmatched)`, since a raw path can carry health terms.
 * No query string, body, headers or client address.
 */
export function requestForLog(req: FastifyRequest): { method: string; url: string; id: string } {
  return { method: req.method, url: req.routeOptions?.url ?? '(unmatched)', id: String(req.id) };
}

export function replyForLog(reply: FastifyReply): { statusCode: number } {
  return { statusCode: reply.statusCode };
}

/** Paths pino censors even if something logs a raw request, headers or a body by mistake. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["set-cookie"]',
  'req.body',
  'req.query',
  'req.params',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  'body',
  'query',
  'params',
  'error.details',
  'err.details',
];

/** The Fastify logger options for the server (and for log tests): scrubbed serializers plus pino `redact`. */
export function loggerOptions(level: string): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      req: requestForLog as never,
      res: replyForLog as never,
      // Any `log.error({ err })` or `{ error }` goes through the same scrubber as the 500 handler.
      err: scrubForLog as never,
      error: scrubForLog,
    },
  };
}
