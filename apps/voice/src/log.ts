// M7 C-18: the voice service logs only enums and numbers. A field that is not a finite number or a boolean is a type
// error, and is dropped at runtime as well (D3), so no transcript, hint, text or audio can reach a log line.

/**
 * `fatal` (fix round 1, I1): an error escaped a handler or the process; its message, stack and data are never read.
 * `warning` (fix round 2, N2): a process warning, by name only (warningFields).
 */
export type LogKind =
  | 'conn_open'
  | 'conn_close'
  | 'stt_done'
  | 'tts_done'
  | 'engine_error'
  | 'bad_message'
  | 'auth_fail'
  | 'fatal'
  | 'warning'
  /** Step 3 fix round 1 (I2): a worker went down or could not start ({stt|tts, spawn|exit|verify, code?|killed?}). */
  | 'worker_down'
  /** No worker of that pool is ready: utterances fail at once and GET /ready answers 503. */
  | 'pool_empty'
  | 'pool_ready';
export type Logger = (kind: LogKind, fields?: Record<string, number | boolean>) => void;

const KINDS: ReadonlySet<string> = new Set<LogKind>(['conn_open', 'conn_close', 'stt_done', 'tts_done', 'engine_error', 'bad_message', 'auth_fail', 'fatal', 'warning', 'worker_down', 'pool_empty', 'pool_ready']);
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** One JSON line per event. `write` is looked up per call, so a test can capture stdout. */
export function createLogger(write: (line: string) => void = (line) => void process.stdout.write(`${line}\n`)): Logger {
  return (kind, fields) => {
    if (!KINDS.has(kind)) return;
    const out: Record<string, number | boolean | string> = { kind };
    // The type already says numbers and booleans only; this holds at runtime too, for a caller that casts.
    for (const [k, v] of Object.entries(fields ?? {}) as [string, unknown][]) {
      if (k === 'kind' || !FIELD.test(k)) continue;
      if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    }
    write(JSON.stringify(out));
  };
}

/** Node's own warning names, as log fields. Any other name (a warning's `type` is free text) is just `other`. */
const WARNING_NAMES: Readonly<Record<string, string>> = {
  ExperimentalWarning: 'experimental',
  DeprecationWarning: 'deprecation',
  MaxListenersExceededWarning: 'maxListeners',
  TimeoutOverflowWarning: 'timeoutOverflow',
  UnsupportedWarning: 'unsupported',
  Warning: 'plain',
};

/** A process warning as log fields: its name as one known flag, never its message, detail, stack or free-text type. */
export function warningFields(w: unknown): Record<string, boolean> {
  const name = w instanceof Error ? w.name : '';
  return { [Object.hasOwn(WARNING_NAMES, name) ? WARNING_NAMES[name] : 'other']: true };
}

/**
 * A boot refusal, on stderr. Before boot there is no session, no audio and no transcript: the message names only
 * config (variables, model ids, a port in use). Only an Error's message, never its stack.
 */
export function writeBootRefusal(e: unknown): void {
  process.stderr.write(`voice: ${e instanceof Error ? e.message : 'boot failed'}\n`);
}
