import type { MarginNote, SharedEntry } from '@kitchenquest/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { countSelfRead } from '../audit/self-reads.js';
import { SlidingWindowLimiter, sweepPeriodically } from '../auth/rate-limit.js';
import { requireUser } from '../auth/session.js';
import type { Catalog, LoopContent } from '../catalog.js';
import type { Tx } from '../consent/ledger.js';
import { ApiError } from '../errors.js';
import type { RecipeIndexSource } from '../recipes/recipe-index.js';
import { localToday } from '../week/local-date.js';
import { createNoteIn, deleteNoteIn, loadNotes } from './notes-service.js';
import { deleteSharedIn, recordSharedIn, sharedTally } from './shared-table-service.js';

/** Book requests per player per minute: far above any real use (abuse only). */
export const BOOK_REQUESTS_PER_MINUTE = 60;

export interface BookRouteDeps {
  catalog: Catalog;
  loop: LoopContent;
  recipes: RecipeIndexSource;
}

/** `today`: the player's local date (Step 6 I2), checked by `localToday`; optional, the UTC date when absent. */
const today = z.string().max(10).optional();
const NoteWrite = z.object({ note: z.unknown(), confirmed: z.unknown(), today }).strict();
const SharedWrite = z.object({ entry: z.unknown(), confirmed: z.unknown(), today }).strict();

/**
 * The body in its strict shape, or 400 naming only the fields (M2, fix round 1): zod's own message for an unknown key
 * quotes the key, which may be a name, so it is never sent back (R-19).
 */
function bodyOf<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((i) => `body: ${i.path.map(String).join('.') || '(root)'} is not allowed`);
  throw new ApiError(400, 'bad_request', 'Invalid request', { problems: [...new Set(problems)] });
}

const needsYes = (body: unknown, what: string) => {
  if (typeof body !== 'object' || body === null || (body as { confirmed?: unknown }).confirmed !== true) {
    throw new ApiError(400, 'confirmation_required', `${what} needs your confirmation (confirmed: true)`);
  }
};

/**
 * The Recipe Book's private pages (M5 Step 7). Margin notes (H-12, Ruling 9) are health data: sealed per user and row,
 * written only with `health_data` (403 `consent_required`) and `confirmed: true`, read and deleted without it (kept data
 * stays readable and deletable after a "keep" withdrawal). `GET /notes` returns every note the player has (at most
 * MAX_NOTES_PER_RECIPE per recipe) and takes no query at all (400): no recipe slug, and nothing about food, is ever in
 * a notes URL (P-5, Ruling 26, C32); the client filters by recipe and runs core `checkWithNotes` itself.
 * Cooked for Someone (H-13, Ruling 10) holds fixed values only, contract basis: `confirmed: true` on a write, and the
 * tally is counts only (C21). Neither feeds a reward, a trust change or a gate. Writes take the player's local date as
 * `today` (within a day of UTC) and the M4 daily write cap; every route is limited per player (429 `rate_limited`).
 * Nothing about a note or an entry is logged (C-9): the logger writes the route pattern only.
 *
 * Family Table (C31, Ruling 25): the server cannot tell a Family Table session (it is a mode of the game on the
 * player's own account), so the game skips these writes there (Step 11).
 */
export async function bookRoutes(app: FastifyInstance, deps: BookRouteDeps): Promise<void> {
  const { db, config, now } = app.deps;
  const limiter = new SlidingWindowLimiter(BOOK_REQUESTS_PER_MINUTE, 60_000);
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

  app.get('/notes', pre, async (req) => {
    // C32: any query string at all is refused, so nothing about a recipe ever rides in a notes URL.
    if (req.url.includes('?')) throw new ApiError(400, 'bad_request', 'GET /notes takes no query; filter by recipe on your device');
    const at = now();
    const notes = await loadNotes(db, config.keyring, req.user.id);
    await countSelfRead(db, req.user.id, 'notes', at);
    return { notes };
  });

  app.post('/notes', pre, async (req, reply) => {
    const at = now();
    needsYes(req.body, 'Keeping a margin note');
    const { note, today: t } = bodyOf(NoteWrite, req.body);
    const local = localToday(t, at);
    const saved = await db.transaction(async (tx: Tx) =>
      createNoteIn(tx, { keyring: config.keyring, catalog: deps.catalog, recipes: await deps.recipes.current(tx) }, req.user.id, note as MarginNote, at, req.id, local),
    );
    return reply.status(201).send({ note: saved });
  });

  app.delete<{ Params: { id: string } }>('/notes/:id', pre, async (req, reply) => {
    const at = now();
    await db.transaction((tx: Tx) => deleteNoteIn(tx, req.user.id, req.params.id, at, req.id));
    return reply.status(204).send();
  });

  app.post('/shared-table', pre, async (req, reply) => {
    const at = now();
    needsYes(req.body, 'Recording who you cooked for');
    const { entry, today: t } = bodyOf(SharedWrite, req.body);
    const local = localToday(t, at);
    const saved = await db.transaction(async (tx: Tx) =>
      recordSharedIn(tx, { keyring: config.keyring, loop: deps.loop, recipes: await deps.recipes.current(tx) }, req.user.id, entry as SharedEntry, at, req.id, local),
    );
    return reply.status(201).send(saved);
  });

  app.get('/shared-table/tally', pre, async (req) => sharedTally(db, config.keyring, req.user.id));

  app.delete<{ Params: { id: string } }>('/shared-table/:id', pre, async (req, reply) => {
    const at = now();
    await db.transaction((tx: Tx) => deleteSharedIn(tx, req.user.id, req.params.id, at, req.id));
    return reply.status(204).send();
  });
}
