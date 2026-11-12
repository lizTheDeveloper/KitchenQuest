import { ZodError } from 'zod';

/**
 * An error the API returns to the client as `{ error: { code, message, details? } }`
 * with `status` (M2's body shape). Every code the API returns:
 *
 * - 400 `bad_request`: the body, query or params fail their shape or a check
 *   (zod issues, or `details.problems` from core or a service). Also Fastify's
 *   own 4xx (malformed JSON, payload too large, 415), which keep their status.
 * - 400 `confirmation_required`: a write needs the player's explicit yes
 *   (`confirmed: true`; `confirm: "delete my account"` for `DELETE /me`).
 * - 400 `too_many_rules`: at the 200-rule cap (`details.max`).
 * - 400 `too_many_items`: the pantry change would pass the 300-item cap (`details.max`).
 * - 400 `too_many_notes`: a margin note past MAX_NOTES_PER_RECIPE (20) on one recipe (`details.max`) (M5 Step 7).
 * - 400 `plan_invalid`: a weekly plan the server won't store (`details.problems`): its shape, more than
 *   MAX_PLAN_ITEMS items, a sacred or unknown slug, a `weekStart` that is not the player's plan-week start, or an
 *   item the player's rules block on its date (`blocked: <slug>`) (M5 Step 6).
 * - 400 `stock_invalid`: a stall swap the core doesn't offer now with the player's rules, a row that can't be marked
 *   out of stock, ticked or undone that way, or a run already at MAX_STOCK_SWAPS_PER_RUN (M6 Step 6). Stall-round
 *   problems are not errors: they are per event in the 200 `rejected` list of POST /progress/events (`bad_event`,
 *   `consent_required`, `rules_unknown`), as M5's C14.
 * - 400 `tap_required`: a severe card (anaphylactic or allergy) is confirmed
 *   only by a tap on it, never by a typed yes (spec §7.6).
 * - 401 `unauthorized`: no live session, or the account is gone.
 * - 403 `consent_required`: the write needs a current grant (`details.purpose`). `PUT /voice/accessibility` needs
 *   `health_data` (M7 Step 4, C-19); the game then shows the consent form inline. The voice allowance is never an error:
 *   `GET /voice/status` reports it as a state (`available`, `resting` until a date, `resting_today`), never 402 or 403.
 * - 404 `not_found`: no such route, or a row that is not the player's.
 * - 409 `rules_need_review`: saved rules no longer validate against the catalog.
 * - 409 `proposal_closed`: the mentor card is no longer open (confirmed,
 *   rejected, undone or expired), or an undo of a write that is not confirmed.
 * - 409 `rule_changed`: `PUT /rules/:id` with `If-Match` found another version of
 *   the rule (`details.version`, the current one); nothing was written.
 * - 409 `plan_changed`: a plan card's week changed since it was shown; the card is closed and, in `details`, offered
 *   again on the week as it is now (`card`, a new proposal, and its `parts`) (M5 Step 8 fix round 1, M2).
 * - 409 `run_closed`: a tick on a market run that is already done (M5 Step 6).
 * - 409 `undo_window_closed`: the confirmed write is older than UNDO_WINDOW_MS.
 * - 429 `rate_limited`: with a `retry-after` header. The daily write cap on meal logs and
 *   loosening rule edits (usage/write-cap.ts) also puts it in `details.retryAfterSeconds`, with `details.scope: 'day'`
 *   (M5 final m2); the per-minute limiters (book, week, progress) put `retryAfterSeconds` but never a scope.
 * - 500 `internal`: anything unexpected (logged scrubbed, never sent). On `GET /voice` (the voice socket's upgrade)
 *   it is logged as a kind and a status only (Review Focus 2).
 *
 * M7 Step 5, the voice socket `GET /voice` (core `VoiceCloseReason`, `VOICE_CLOSE_CODES`). The upgrade always
 * succeeds unless the server fails (500 above); a refusal is a `closed { reason }` message, then the close code:
 * - 4400 `bad_message`: a message core `parseClientMsg` refuses, a frame or any message before `hello`, a second
 *   `hello`, a clock (`localDate`, `localTime`) `GET /voice/status` would refuse, or a client flooding the queue.
 * - 4401 `signed_out`: no live session.
 * - 4403 `bad_origin`: no Origin header, or not the game's (APP_ORIGIN); checked before the cookie is read.
 * - 4409 `another_tab`: the player opened a newer voice socket.
 * - 4412 `consent_required`: no current `voice` grant.
 * - 4451 `child`, 4452 `family_table`: the per-user voice block (Ruling 17); sent at `hello`, `listen` or `speak`,
 *   and to every open socket of the player the moment the block is set.
 * - 4503 `unavailable`: voice is off, or the voice service refuses this server's credentials or address.
 * The voice service's own codes (core `UPSTREAM_CLOSE`, `UPSTREAM_REFUSAL`), which the API maps and never forwards:
 * socket 4400 (the API sent a bad message: `failed upstream`), 4408 (idle: reconnect on the next need), 1011 and 1001
 * (down: `failed upstream`, the player's socket stays open); HTTP before the upgrade 401 and 403 (`unavailable`), 503
 * (busy: `failed upstream`), 426 (a wrong URL: `unavailable`); and `GET /ready` 503 (not ready: fail fast,
 * `failed upstream`). `PUT /voice/family-table` uses 204, 400 `bad_request`, 401 and 429 above.
 *
 * Extend this list with every new code.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// A dotted domain is required, so scoped package paths like `/@fastify/cookie` are left alone.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * Drops drizzle's bound values and masks email addresses. Drizzle appends
 * `params: ...` last, and a bound value can span lines (a bytea with 0x0a in
 * it), so everything from `params:` to the end of the text goes. For a query
 * error that also drops the stack frames after it; the query text survives.
 */
function scrub(text: string): string {
  return text.replace(/(^|\n)params:[\s\S]*$/, '$1params: [redacted]').replace(EMAIL, '[email]');
}

interface LoggableError {
  name: string;
  code?: string;
  message: string;
  stack?: string;
  cause?: LoggableError;
}

/** pino serializer: scrubs Errors; leaves values already made loggable untouched. */
export function scrubForLog(value: unknown): unknown {
  return value instanceof Error ? loggableError(value) : value;
}

/**
 * A copy of an unexpected error that is safe for the log: name, code, and
 * message and stack with query parameters and email addresses removed. Other
 * properties (a Postgres error's `detail`, drizzle's `params`) are left out.
 */
export function loggableError(err: unknown, depth = 0): LoggableError {
  if (!(err instanceof Error)) return { name: 'NonError', message: scrub(String(err)) };
  // A ZodError's message (and so its stack) quotes the rejected input; keep only issue codes and paths.
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => `${i.code} at ${i.path.map((p) => (typeof p === 'number' ? '[n]' : String(p))).join('.') || '(root)'}`);
    return { name: 'ZodError', message: `${err.issues.length} validation issue(s): ${scrub(issues.join('; '))}` };
  }
  // Core's rule and substitution errors list the offending ingredient ids, which can be health data.
  if (/^Invalid (rules|substitutions):/.test(err.message)) {
    return { name: err.name === 'Error' ? err.constructor.name : err.name, message: 'Invalid rules or substitutions (details withheld)' };
  }
  const code = (err as { code?: unknown }).code;
  return {
    // Some classes (drizzle's DrizzleQueryError) leave `name` as plain "Error".
    name: err.name === 'Error' ? err.constructor.name : err.name,
    ...(typeof code === 'string' ? { code } : {}),
    message: scrub(err.message),
    ...(err.stack ? { stack: scrub(err.stack) } : {}),
    ...(err.cause !== undefined && depth < 3 ? { cause: loggableError(err.cause, depth + 1) } : {}),
  };
}
