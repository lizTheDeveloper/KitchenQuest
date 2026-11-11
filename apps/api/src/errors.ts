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
 * - 400 `tap_required`: a severe card (anaphylactic or allergy) is confirmed
 *   only by a tap on it, never by a typed yes (spec §7.6).
 * - 401 `unauthorized`: no live session, or the account is gone.
 * - 403 `consent_required`: the write needs a current grant (`details.purpose`).
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
 * - 500 `internal`: anything unexpected (logged scrubbed, never sent).
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
