import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { countSelfRead } from '../audit/self-reads.js';
import { SlidingWindowLimiter, sweepPeriodically } from '../auth/rate-limit.js';
import { requireUser } from '../auth/session.js';
import { ApiError } from '../errors.js';
import { voiceState } from './allowance.js';
import { localOffsetMinutes } from './local-clock.js';
import { setAccessibility } from './settings.js';

/** Voice status and setting requests per player per minute: far above any real use (abuse only). */
const VOICE_STATUS_REQUESTS_PER_MINUTE = 60;

const AccessibilityBody = z.object({ on: z.boolean() }).strict();
/** The player's clock, as the mentor turn takes it (`localDate`, `localTime`), checked by `localOffsetMinutes`. */
const StatusQuery = z.object({ localDate: z.string().max(10), localTime: z.string().max(5) }).strict();

/**
 * The account side of voice (M7 Step 4):
 * - `GET /voice/status?localDate=YYYY-MM-DD&localTime=HH:MM` (required, checked as the mentor turn checks them; 400
 *   `bad_request` otherwise) → `{ state, accessibility, enabled }`: the allowance as a state only, its date and "today"
 *   on the player's own calendar (fix round 1, I1) (`available`, `resting`
 *   until a date, `resting_today`; Ruling 5: no number, countdown or Guild mention), whether the accessibility need is
 *   on and counted (it is read only while `health_data` is in force, and that read is counted per day as a self-read,
 *   resource `voice`, C-5), and whether this server offers voice at all
 *   (`Deps.voiceEnabled`, false by default; Step 5 wires it, P6).
 * - `PUT /voice/accessibility { on: boolean }` (strict) → 204, or 403 `consent_required` without `health_data` (the
 *   game then shows Form 3-C inline, Ruling 6). The value is never logged or audited (C-19): the logger writes the
 *   route pattern only, and the 400 for a bad body names no key or value.
 * Both are limited per player (429 `rate_limited`).
 */
export async function voiceStatusRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, now } = app.deps;
  const limiter = new SlidingWindowLimiter(VOICE_STATUS_REQUESTS_PER_MINUTE, 60_000);
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

  app.get('/voice/status', pre, async (req) => {
    const at = now();
    const q = StatusQuery.safeParse(req.query);
    if (!q.success) throw new ApiError(400, 'bad_request', 'Invalid request', { problems: ['query: expected exactly localDate and localTime'] });
    const offset = localOffsetMinutes(q.data.localDate, q.data.localTime, at);
    // One read of the setting (fix round 1, m1): voiceState reports what it counted.
    const v = await voiceState(db, config.keyring, req.user.id, at, offset);
    // C-5: the player's own health data is read while health_data is in force; that read is counted per day.
    if (v.accessibilityRead) await countSelfRead(db, req.user.id, 'voice', at);
    return { state: v.state, accessibility: v.accessibility, enabled: app.deps.voiceEnabled ?? false };
  });

  app.put('/voice/accessibility', pre, async (req, reply) => {
    const parsed = AccessibilityBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'bad_request', 'Invalid request', { problems: ['body: expected exactly { on: boolean }'] });
    await setAccessibility(db, config.keyring, req.user.id, parsed.data.on, now(), req.id);
    return reply.status(204).send();
  });
}
