// M7 C-18: the voice service logs only enums and numbers. A field that is not a finite number or a boolean is a type
// error, and is dropped at runtime as well (D3), so no transcript, hint, text or audio can reach a log line.

/** `fatal` (fix round 1, I1): an error escaped a handler or the process; its message, stack and data are never read. */
export type LogKind = 'conn_open' | 'conn_close' | 'stt_done' | 'tts_done' | 'engine_error' | 'bad_message' | 'auth_fail' | 'fatal';
export type Logger = (kind: LogKind, fields?: Record<string, number | boolean>) => void;

const KINDS: ReadonlySet<string> = new Set<LogKind>(['conn_open', 'conn_close', 'stt_done', 'tts_done', 'engine_error', 'bad_message', 'auth_fail', 'fatal']);
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
