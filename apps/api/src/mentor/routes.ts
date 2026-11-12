import { isValidDate, parseTurnInput, type TurnRequest } from '@kitchenquest/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import { SlidingWindowLimiter, sweepPeriodically } from '../auth/rate-limit.js';
import { requireUser } from '../auth/session.js';
import type { Catalog } from '../catalog.js';
import type { Tx } from '../consent/ledger.js';
import { ApiError } from '../errors.js';
import type { BudgetGuard } from './allowance.js';
import { MAX_TEXT, TURNS_PER_MINUTE } from './constants.js';
import { forgetConversations } from './conversations.js';
import { loadPanBank } from './lines.js';
import type { MemoryFlags, MemoryHistory } from './memory.js';
import { loadPanPrompt } from './prompt.js';
import { runTurn, type TurnDeps } from './turn.js';
import { localToday } from '../week/local-date.js';
import { recentReplies } from '../voice/recent-replies.js';
import { confirmProposal, rejectProposalIn, undoWriteIn } from './writes.js';
import type { WeekSource } from './plan-turn.js';

const DAY_MS = 86_400_000;
const INTAKE_STEPS = ['market_day', 'meals_per_week', 'region', 'allergies', 'pantry'] as const;
/** M7 Step 6: a heard card confirms at most this many words, each at most HEARD_WORD_MAX characters. */
const HEARD_WORDS_MAX = 12;
const HEARD_WORD_MAX = 40;

const turnText = z.string().trim().min(1).max(MAX_TEXT);
/**
 * What the player said (M7 Step 6): typed text, or a speech-to-text transcript with, after a tap on its heard card, the
 * words that tap confirmed (Ruling 4, §7.6b.4: a structured field, never user text). Both strict: a text turn with a
 * heard field is a 400. Core `parseTurnInput` checks it again (bounded, never truncated).
 */
const TurnInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: turnText }).strict(),
  z
    .object({
      kind: z.literal('transcript'),
      text: turnText,
      heard: z.object({ words: z.array(z.string().min(1).max(HEARD_WORD_MAX)).max(HEARD_WORDS_MAX) }).strict().optional(),
    })
    .strict(),
]);

/** The turn body (zod-strict). Text only in the POST body, never in a URL (P-5). */
const TurnBody = z
  .object({
    conversationId: z.string().max(64).nullable(),
    input: TurnInput,
    localDate: z.string(),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'localTime must be HH:MM'),
    screen: z.object({ route: z.string().max(100), slug: z.string().max(200).optional() }).strict().nullable(),
    intakeStep: z.enum(INTAKE_STEPS).nullable(),
    /** I-1: the proposal a plain yes or no answers. */
    answering: z.string().max(64).optional(),
    /** J2: one id per player turn, the same on its retry. */
    turnKey: z.uuid().optional(),
  })
  .strict();

/**
 * The confirm body (zod-strict). `channel` is only ever a tap here: a typed
 * yes exists only inside `runTurn`, so `'typed_yes'` (or anything else) is a 400.
 */
const ConfirmBody = z
  .object({
    channel: z.literal('tap'),
    edits: z.object({ severity: z.enum(['anaphylactic', 'allergy', 'intolerance', 'preference']).optional() }).strict().optional(),
    conversationId: z.string().max(64).nullable().optional(),
    /** M5 Step 8: the player's local date, for a plan card's week window (Step 6 I2). */
    today: z.string().max(10).optional(),
  })
  .strict();
/** Reject and undo take no body; an empty object at most. */
const EmptyBody = z.object({}).strict();

/** The in-memory state the mentor shares with the account and consent routes, which clear it. */
export interface MentorState {
  memory: MemoryHistory;
  childFlags: MemoryFlags;
  budget: BudgetGuard | null;
}

/**
 * The Pan's turn endpoint and "forget this conversation" (C-12). The line bank
 * and prompt are read at boot, so a missing or broken file stops the server.
 */
export async function mentorRoutes(app: FastifyInstance, catalog: Catalog, state: MentorState, week: WeekSource): Promise<void> {
  const { db, config, now, ai } = app.deps;
  const bank = loadPanBank();
  const deps: TurnDeps = {
    db,
    keyring: config.keyring,
    catalog,
    ai,
    budget: state.budget,
    memory: state.memory,
    childFlags: state.childFlags,
    bank,
    prompt: loadPanPrompt(bank),
    week,
    now,
  };
  // Per app instance, in memory only (N-2).
  const limiter = new SlidingWindowLimiter(TURNS_PER_MINUTE, 60_000);
  const stopSweeping = sweepPeriodically([limiter], () => now().getTime());
  app.addHook('onClose', (_app, done) => {
    stopSweeping();
    done();
  });

  app.post('/mentor/turn', { preHandler: requireUser }, async (req, reply) => {
    const t = now().getTime();
    const wait = limiter.waitMs(req.user.id, t);
    if (wait > 0) {
      reply.header('retry-after', String(Math.ceil(wait / 1000)));
      throw new ApiError(429, 'rate_limited', 'Too many turns; try again shortly');
    }
    limiter.hit(req.user.id, t);
    const body = TurnBody.parse(req.body);
    // The player's local date (M2's recipe ruling): a real date within a day of the server's UTC date.
    const utc = new Date(t).toISOString().slice(0, 10);
    const offDays = isValidDate(body.localDate) ? Math.abs(Date.parse(`${body.localDate}T00:00:00Z`) - Date.parse(`${utc}T00:00:00Z`)) / DAY_MS : Infinity;
    if (offDays > 1) throw new ApiError(400, 'bad_request', 'localDate must be a valid YYYY-MM-DD within a day of today');
    // Core's own reading of the input (M7 carry): blank once invisible characters go, or over MAX_TEXT code points, is a 400.
    const input = parseTurnInput(body.input);
    if (input === null) throw new ApiError(400, 'bad_request', 'input is not a valid turn input');
    const turn: TurnRequest = {
      conversationId: body.conversationId,
      input,
      localDate: body.localDate,
      localTime: body.localTime,
      screen: body.screen === null ? null : { route: body.screen.route, ...(body.screen.slug === undefined ? {} : { slug: body.screen.slug }) },
      intakeStep: body.intakeStep,
      ...(body.answering === undefined ? {} : { answering: body.answering }),
      ...(body.turnKey === undefined ? {} : { turnKey: body.turnKey }),
    };
    return runTurn(deps, req.user.id, turn, req.id);
  });

  // The write guard (Step 8): a card becomes a write only by a tap here, or by a typed yes inside runTurn.
  app.post<{ Params: { id: string } }>('/mentor/proposals/:id/confirm', { preHandler: requireUser }, async (req) => {
    const body = ConfirmBody.parse(req.body);
    const at = now();
    const today = localToday(body.today, at);
    // A plan card the rules now refuse is closed and answered 400 plan_invalid with its lines (M5 Step 8).
    return confirmProposal(db, deps, req.user.id, req.params.id, body.channel, body.edits, at, req.id, body.conversationId, today);
  });

  app.post<{ Params: { id: string } }>('/mentor/proposals/:id/reject', { preHandler: requireUser }, async (req) => {
    EmptyBody.parse(req.body ?? {});
    const at = now();
    return db.transaction((tx: Tx) => rejectProposalIn(tx, deps, req.user.id, req.params.id, at, req.id));
  });

  app.post<{ Params: { id: string } }>('/mentor/writes/:id/undo', { preHandler: requireUser }, async (req) => {
    EmptyBody.parse(req.body ?? {});
    const at = now();
    // `undone` is false when nothing was reversed (vanished card, full pantry): the client keeps or drops its trail entry by it.
    const { parts, undone } = await db.transaction((tx: Tx) => undoWriteIn(tx, deps, req.user.id, req.params.id, at, req.id));
    return { parts, undone };
  });

  const forget = async (userId: string, requestId: string, conversationId?: string): Promise<number> =>
    db.transaction(async (tx: Tx) => {
      await lockLiveUser(tx, userId);
      const n = await forgetConversations(tx, state.memory, userId, conversationId);
      if (n > 0 || conversationId === undefined) {
        await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'mentor.forget', target: 'conversations', requestId }, now());
      }
      // M7 Step 6: the Pan's recent replies go too (all of the user's: they are not kept per conversation).
      recentReplies.clear(userId, now().getTime());
      return n;
    });

  app.delete('/mentor/conversations', { preHandler: requireUser }, async (req, reply) => {
    await forget(req.user.id, req.id);
    return reply.status(204).send();
  });

  app.delete<{ Params: { id: string } }>('/mentor/conversations/:id', { preHandler: requireUser }, async (req, reply) => {
    if ((await forget(req.user.id, req.id, req.params.id)) === 0) throw new ApiError(404, 'not_found', 'Conversation not found');
    return reply.status(204).send();
  });
}
