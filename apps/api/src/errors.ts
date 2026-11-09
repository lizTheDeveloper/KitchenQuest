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

/** Drops drizzle's `params: ...` line (bound values) and masks email addresses. */
function scrub(text: string): string {
  return text.replace(/^params: .*$/gm, 'params: [redacted]').replace(EMAIL, '[email]');
}

interface LoggableError {
  name: string;
  code?: string;
  message: string;
  stack?: string;
  cause?: LoggableError;
}

/**
 * A copy of an unexpected error that is safe for the log: name, code, and
 * message and stack with query parameters and email addresses removed. Other
 * properties (a Postgres error's `detail`, drizzle's `params`) are left out.
 */
export function loggableError(err: unknown, depth = 0): LoggableError {
  if (!(err instanceof Error)) return { name: 'NonError', message: scrub(String(err)) };
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
