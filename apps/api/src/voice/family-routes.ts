import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SlidingWindowLimiter, sweepPeriodically } from '../auth/rate-limit.js';
import { requireUser } from '../auth/session.js';
import { ApiError } from '../errors.js';
import { voiceRegistry } from './registry.js';

/** Family Table reports per player per minute: the game sends one per change and one per start (abuse only). */
const FAMILY_TABLE_REQUESTS_PER_MINUTE = 30;

const FamilyTableBody = z.object({ on: z.boolean() }).strict();

/**
 * M7 Step 5, Ruling 17: `PUT /voice/family-table { on: boolean }` (strict, signed in) → 204. The game calls it whenever
 * the Family Table setting changes and at every signed-in start. `on` sets the server-held block, which closes every
 * voice socket of the player at once (`family_table`) and refuses `hello` and `listen` until `{ on: false }` clears it.
 * In memory only: never stored, logged or audited (§19). Registered only when voice is enabled.
 */
export async function voiceFamilyRoutes(app: FastifyInstance): Promise<void> {
  const { now } = app.deps;
  const limiter = new SlidingWindowLimiter(FAMILY_TABLE_REQUESTS_PER_MINUTE, 60_000);
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

  app.put('/voice/family-table', { preHandler: [requireUser, limited] }, async (req, reply) => {
    const parsed = FamilyTableBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'bad_request', 'Invalid request', { problems: ['body: expected exactly { on: boolean }'] });
    voiceRegistry.setFamilyTable(req.user.id, parsed.data.on);
    return reply.status(204).send();
  });
}
