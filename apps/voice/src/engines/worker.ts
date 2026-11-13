// M7 Step 3: the Python worker behind the engine seam. Each worker is a `kq_voice_worker.py` process (GPL-3.0-or-later,
// Ruling 14) that Node talks to over stdio only, framed both ways as: u32 BE header length, JSON header, u32 BE
// payload length, payload (see the worker's header comment for the messages).
//
// C-18 and Review Focus 2:
// - A worker's stderr is counted, never read or forwarded: each chunk is zeroed on arrival.
// - The worker gets an allowlisted environment (no token, no secrets) and `-I -B` (and `-S` for echo): no user site,
//   no PYTHON* variables, no .pyc writes.
// - The PCM is sent as PCM16 little-endian bytes. The frame that carries it is zeroed once written; the session zeroes
//   its own buffer when the call settles.
//
// F5 (Step 2 fix round 3; fix round 1 I1 and M9): every request has a deadline counted from its submission, queue time
// included: STT_DEADLINE_MS for an STT answer, TTS_FIRST_MS for a TTS stream's first message and then TTS_GAP_MS
// between messages. A job still queued at its deadline fails and is never dispatched; one running fails, and its worker
// is killed and replaced, so a hung engine can never hang an utterance. A worker that crashes mid-job fails that job
// the same way. See WorkerPool for restarts and an empty pool (I2).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../log.js';
import type { SttEngine, TtsEngine } from './types.js';

export type WorkerEngineName = 'echo' | 'whisper' | 'kokoro' | 'piper';

export const WORKER_SCRIPT = fileURLToPath(new URL('../../worker/kq_voice_worker.py', import.meta.url));
/** Model loading can take a while on a cold box; a worker that has not answered `ping` by then is refused. */
const START_TIMEOUT_MS = 120_000;
/** One utterance (at most MAX_UTTERANCE_MS of audio) from submission to transcript, queue time included. */
const STT_DEADLINE_MS = 20_000;
/** A TTS job's first message, from submission (queue time included): Kokoro sends a whole chunk at once (M9). */
const TTS_FIRST_MS = 30_000;
/** The longest silence between two messages of one TTS job, after its first. */
const TTS_GAP_MS = 10_000;
/** I2: how many times start() tries each worker before it gives up on it (and rejects if none started). */
export const START_ATTEMPTS = 5;
const MAX_HEADER = 64 * 1024;
const MAX_PAYLOAD = 4 * 1024 * 1024;
const RESTART_MIN_MS = 100;
const RESTART_MAX_MS = 2000;
const CLOSE_GRACE_MS = 2000;

type Header = Record<string, unknown>;

/** One frame: u32 BE header length, JSON header, u32 BE payload length, payload. */
export function encodeWorkerFrame(header: Header, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.alloc(8 + head.length + payload.byteLength);
  out.writeUInt32BE(head.length, 0);
  head.copy(out, 4);
  out.writeUInt32BE(payload.byteLength, 4 + head.length);
  out.set(payload, 8 + head.length);
  head.fill(0);
  return out;
}

/** Incremental decoder for the worker's stdout. Throws on a frame over the limits (the worker is then killed). */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): { header: Header; payload: Buffer }[] {
    const joined = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    if (joined !== chunk) this.buf.fill(0);
    const out: { header: Header; payload: Buffer }[] = [];
    let at = 0;
    for (;;) {
      if (joined.length - at < 4) break;
      const hlen = joined.readUInt32BE(at);
      if (hlen > MAX_HEADER) throw new Error('worker frame header too long');
      if (joined.length - at < 8 + hlen) break;
      const plen = joined.readUInt32BE(at + 4 + hlen);
      if (plen > MAX_PAYLOAD) throw new Error('worker frame payload too long');
      if (joined.length - at < 8 + hlen + plen) break;
      const header = JSON.parse(joined.toString('utf8', at + 4, at + 4 + hlen)) as unknown;
      if (typeof header !== 'object' || header === null || Array.isArray(header)) throw new Error('worker frame header is not an object');
      out.push({ header: header as Header, payload: Buffer.from(joined.subarray(at + 8 + hlen, at + 8 + hlen + plen)) });
      at += 8 + hlen + plen;
    }
    this.buf = Buffer.from(joined.subarray(at));
    joined.fill(0, 0, at);
    if (joined !== chunk) chunk.fill(0);
    return out;
  }
}

/**
 * The worker's environment: an allowlist, so it never sees VOICE_SERVICE_TOKEN or any other secret. Models load
 * offline, and onnxruntime's telemetry is off (1.31 otherwise writes a device id under HOME and a .ses file in TMPDIR).
 * Fix round 1 (M4): HOME is a path that does not exist, so a library that writes under it fails instead of writing.
 * TMPDIR is passed through: Python's tempfile would fall back to /tmp anyway, so the C-18 tests snapshot the TMPDIR it
 * really uses, and in production the unit's private /tmp confines it.
 */
const WORKER_HOME = '/nonexistent/kq-voice-worker';
export function workerEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: WORKER_HOME, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', ORT_DISABLE_TELEMETRY: '1', OMP_NUM_THREADS: '1', LANG: 'C.UTF-8' };
  for (const k of ['PATH', 'TMPDIR', 'LD_LIBRARY_PATH'] as const) if (parent[k] !== undefined) env[k] = parent[k];
  return env;
}

interface Job {
  header: Header & { op: 'stt' | 'tts' };
  payload: Uint8Array | null;
  /** A message for this job; returns true when it was the job's last. */
  onMessage(header: Header, payload: Buffer): boolean;
  /**
   * The worker crashed or hung, the deadline passed, the pool is empty, or the pool closed. Called at most once, never
   * after the last message.
   */
  onFail(): void;
}

interface Handle {
  /** Drops a queued job, or asks the worker to stop a running one (which still ends with its last message). */
  cancel(): void;
  /** Whether a worker holds the job now. */
  running(): boolean;
}

interface Queued {
  id: number;
  job: Job;
  /** performance.now() by which the job must have its (first) answer: submission plus its deadline (I1). */
  due: number;
  timer: NodeJS.Timeout;
}

interface Running {
  id: number;
  job: Job;
  timer: NodeJS.Timeout;
  cancelSent: boolean;
}

/** One place in the pool: it always holds, or is about to hold, one worker process. */
interface Slot {
  worker: Worker | null;
  /** Consecutive failed starts, for the backoff. */
  failures: number;
  /** Attempts before the slot first became ready (START_ATTEMPTS at most count for start()). */
  attempts: number;
  initial: 'pending' | 'ready' | 'failed';
  launched: boolean;
  timer: NodeJS.Timeout | null;
}

class Worker {
  readonly child: ChildProcessWithoutNullStreams;
  running: Running | null = null;
  ready = false;
  dead = false;
  /** The process was created (its `spawn` event fired). An `error` before that is a spawn failure. */
  spawned = false;
  /** Killed: never ready again. */
  retired = false;
  /** Answered its ping at least once. */
  everReady = false;
  sampleRate: number | null = null;
  startTimer: NodeJS.Timeout | null = null;
  private gone = false;
  private readonly reader = new FrameReader();

  constructor(
    private readonly pool: WorkerPool,
    readonly slot: Slot,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: process.cwd() });
    this.child.stdin.on('error', () => {});
    this.child.stdout.on('error', () => {});
    this.child.stderr.on('error', () => {});
    this.child.once('spawn', () => (this.spawned = true));
    this.child.stdout.on('data', (chunk: Buffer) => {
      let msgs: { header: Header; payload: Buffer }[];
      try {
        msgs = this.reader.push(chunk);
      } catch {
        this.pool.counters.protocol++;
        this.kill();
        return;
      }
      for (const m of msgs) this.pool.onMessage(this, m.header, m.payload);
    });
    // Counted, never read: a byte count is all that leaves this handler.
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.pool.counters.stderrBytes += chunk.length;
      chunk.fill(0);
    });
    // I2 (fix round 1): a spawn failure (ENOENT, EACCES, EAGAIN, EMFILE…) emits `error` and never `exit`; it is an
    // exit like any other. An `error` after the spawn (a failed kill) is followed by the real exit.
    this.child.once('exit', (code, signal) => this.end({ spawn: false, code, signal }));
    this.child.once('error', () => {
      if (!this.spawned) this.end({ spawn: true, code: null, signal: null });
    });
  }

  private end(how: { spawn: boolean; code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.gone) return;
    this.gone = true;
    this.dead = true;
    this.ready = false;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.pool.onGone(this, how);
  }

  write(frame: Buffer): void {
    if (this.dead) {
      frame.fill(0);
      return;
    }
    this.child.stdin.write(frame, () => frame.fill(0));
  }

  /** SIGKILL. It takes no new job from now on, even before its exit arrives. */
  kill(): void {
    this.ready = false;
    this.retired = true;
    if (!this.dead) this.child.kill('SIGKILL');
  }
}

export interface WorkerPoolOptions {
  python: string;
  engine: WorkerEngineName;
  model: string;
  modelsDir: string;
  size: number;
  /** What the pool serves, for its log lines; default from the engine (whisper and echo: stt). */
  role?: 'stt' | 'tts';
  /** TTS: the cast voice (kokoro serves one language per process and warms up with it). */
  voice?: string;
  /** Extra worker arguments: tests only (`--leak-for-test`). */
  extraArgs?: string[];
  /** Deadlines in ms; tests shorten them. */
  deadlines?: { sttMs?: number; ttsFirstMs?: number; ttsGapMs?: number; startMs?: number };
  /** Content-free log lines: a worker that went down, the pool going empty and ready again. */
  log?: Logger;
  /** M5 (fix round 1): re-checks the model files (their sha256 pins) before every replacement worker starts. */
  verify?: () => Promise<void>;
}

/**
 * A fixed number of worker processes for one engine and model, with a queue, deadlines and restarts.
 *
 * I2 (fix round 1): each slot keeps one worker alive forever. A worker that dies, cannot be spawned or fails to load
 * is retried with capped backoff (RESTART_MIN_MS doubling to RESTART_MAX_MS), each failure logged as a content-free
 * `worker_down`. start() resolves once every slot has a worker or has failed START_ATTEMPTS times, and rejects when
 * none started, so boot fails and main exits non-zero for systemd to restart. Once started, a pool with no ready
 * worker is empty: it fails queued and new jobs at once (not at their deadline) and `ready` is false.
 */
export class WorkerPool {
  /** Counts only (C-18): what the workers wrote to stderr, and why workers were replaced. */
  readonly counters = { stderrBytes: 0, restarts: 0, crashes: 0, deadlines: 0, protocol: 0, dispatched: 0, spawnFailures: 0, startFailures: 0, verifyFailures: 0 };
  private readonly slots: Slot[];
  private readonly queue: Queued[] = [];
  private nextId = 1;
  private closed = false;
  private started = false;
  private empty = false;
  private sampleRateSeen: number | null = null;
  private readonly sttMs: number;
  private readonly ttsFirstMs: number;
  private readonly ttsGapMs: number;
  private readonly startMs: number;
  private readonly role: 'stt' | 'tts';
  private settleStart: (() => void) | null = null;
  private readonly exits = new Set<Promise<void>>();

  constructor(private readonly opts: WorkerPoolOptions) {
    if (!Number.isInteger(opts.size) || opts.size < 1) throw new Error('WorkerPool: size must be a positive whole number');
    this.sttMs = opts.deadlines?.sttMs ?? STT_DEADLINE_MS;
    this.ttsFirstMs = opts.deadlines?.ttsFirstMs ?? TTS_FIRST_MS;
    this.ttsGapMs = opts.deadlines?.ttsGapMs ?? TTS_GAP_MS;
    this.startMs = opts.deadlines?.startMs ?? START_TIMEOUT_MS;
    this.role = opts.role ?? (opts.engine === 'whisper' || opts.engine === 'echo' ? 'stt' : 'tts');
    this.slots = Array.from({ length: opts.size }, () => ({ worker: null, failures: 0, attempts: 0, initial: 'pending' as const, launched: false, timer: null }));
  }

  /** The TTS sample rate the workers reported in `pong` (null for STT). */
  get sampleRate(): number | null {
    return this.sampleRateSeen;
  }

  get deadlines(): { sttMs: number; ttsFirstMs: number; ttsGapMs: number } {
    return { sttMs: this.sttMs, ttsFirstMs: this.ttsFirstMs, ttsGapMs: this.ttsGapMs };
  }

  /** Live worker processes, for tests. */
  get size(): number {
    return this.slots.filter((s) => s.worker !== null && !s.worker.dead).length;
  }

  /** I2: at least one worker is loaded and taking jobs (the service's GET /ready). */
  get ready(): boolean {
    return !this.closed && this.readyCount() > 0;
  }

  /** Spawns every worker; resolves once each has answered `ping` or failed START_ATTEMPTS times; rejects if none started. */
  async start(): Promise<void> {
    const settled = new Promise<void>((resolve) => (this.settleStart = resolve));
    for (const slot of this.slots) void this.launch(slot);
    this.checkStart();
    await settled;
    if (this.closed) throw new Error(`voice worker (${this.opts.engine} ${this.opts.model}) did not start: the pool was closed`);
    if (!this.slots.some((s) => s.initial === 'ready')) {
      await this.close();
      throw new Error(`voice worker (${this.opts.engine} ${this.opts.model}) did not start after ${START_ATTEMPTS} attempts: the interpreter, the engine or its model failed to load`);
    }
    this.started = true;
    if (this.readyCount() === 0) this.goneEmpty();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.settleStart?.();
    for (const q of this.queue.splice(0)) {
      clearTimeout(q.timer);
      dropPayload(q.job);
      q.job.onFail();
    }
    for (const slot of this.slots) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      const w = slot.worker;
      if (w === null) continue;
      if (w.running) this.failRunning(w);
      if (w.dead) continue;
      w.child.stdin.end();
      setTimeout(() => w.kill(), CLOSE_GRACE_MS).unref();
    }
    await Promise.all([...this.exits]);
  }

  /** Queues a job; it runs on the next idle worker. An empty pool fails it at once (I2). */
  submit(job: Job): Handle {
    const id = this.nextId++;
    if (this.nextId > 0xffffffff) this.nextId = 1;
    if (this.closed || (this.started && this.readyCount() === 0)) {
      dropPayload(job);
      queueMicrotask(() => job.onFail());
      return { cancel: () => {}, running: () => false };
    }
    // I1: the deadline counts from now, queue time included. A job still queued when it passes fails, never dispatched.
    const ms = job.header.op === 'stt' ? this.sttMs : this.ttsFirstMs;
    const timer = setTimeout(() => {
      const i = this.queue.findIndex((q) => q.id === id);
      if (i < 0) return;
      this.queue.splice(i, 1);
      this.counters.deadlines++;
      dropPayload(job);
      job.onFail();
    }, ms).unref();
    this.queue.push({ id, job, due: performance.now() + ms, timer });
    this.dispatch();
    return {
      running: () => this.slots.some((s) => s.worker?.running?.id === id),
      cancel: () => {
        const i = this.queue.findIndex((q) => q.id === id);
        if (i >= 0) {
          const [q] = this.queue.splice(i, 1);
          clearTimeout(q.timer);
          dropPayload(job);
          return;
        }
        for (const s of this.slots) {
          const w = s.worker;
          if (w?.running?.id === id && !w.running.cancelSent) {
            w.running.cancelSent = true;
            w.write(encodeWorkerFrame({ op: 'cancel', id }));
          }
        }
      },
    };
  }

  // --- internals -----------------------------------------------------------------------------------------------------

  private args(): string[] {
    const { engine, model, modelsDir, voice, extraArgs = [] } = this.opts;
    // -I: isolated (no user site, no PYTHON* variables, no script directory on sys.path). -B: no .pyc writes.
    // -S for echo: no site-packages at all, which proves the echo path is stdlib only (D4).
    const flags = engine === 'echo' ? ['-I', '-S', '-B'] : ['-I', '-B'];
    return [...flags, WORKER_SCRIPT, '--engine', engine, '--model', model, '--models-dir', modelsDir, ...(voice === undefined ? [] : ['--voice', voice]), ...extraArgs];
  }

  private log(kind: 'worker_down' | 'pool_empty' | 'pool_ready', fields: Record<string, number | boolean> = {}): void {
    this.opts.log?.(kind, { [this.role]: true, ...fields });
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private readyCount(): number {
    return this.slots.filter((s) => s.worker !== null && s.worker.ready && !s.worker.retired && !s.worker.dead).length;
  }

  private async launch(slot: Slot): Promise<void> {
    slot.timer = null;
    if (this.closed) return;
    if (slot.launched && this.opts.verify) {
      try {
        await this.opts.verify();
      } catch {
        this.counters.verifyFailures++;
        this.log('worker_down', { verify: true });
        return this.retry(slot);
      }
      if (this.isClosed()) return; // close() may have run while verify was awaited
    }
    slot.launched = true;
    let w: Worker;
    try {
      w = new Worker(this, slot, this.opts.python, this.args(), workerEnv(process.env));
    } catch {
      this.counters.spawnFailures++;
      this.log('worker_down', { spawn: true });
      return this.retry(slot);
    }
    slot.worker = w;
    this.exits.add(new Promise<void>((resolve) => w.child.once('close', () => resolve())));
    w.startTimer = setTimeout(() => w.kill(), this.startMs);
    w.startTimer.unref();
    w.write(encodeWorkerFrame({ op: 'ping' }));
  }

  /** The slot failed to get a worker (or lost one): try again after the backoff, forever, until close(). */
  private retry(slot: Slot): void {
    if (this.closed) return;
    if (slot.initial === 'pending') {
      slot.attempts++;
      if (slot.attempts >= START_ATTEMPTS) {
        slot.initial = 'failed';
        this.checkStart();
      }
    }
    const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** slot.failures);
    slot.failures++;
    this.counters.restarts++;
    // Not unref'd: while start() waits on a retry, this timer is all that keeps the process alive. close() clears it.
    slot.timer = setTimeout(() => void this.launch(slot), delay);
  }

  private checkStart(): void {
    if (this.slots.every((s) => s.initial !== 'pending')) this.settleStart?.();
  }

  private goneEmpty(): void {
    if (this.empty || !this.started || this.closed) return;
    this.empty = true;
    this.log('pool_empty');
    for (const q of this.queue.splice(0)) {
      clearTimeout(q.timer);
      dropPayload(q.job);
      q.job.onFail();
    }
  }

  /** @internal */
  onGone(w: Worker, how: { spawn: boolean; code: number | null; signal: NodeJS.Signals | null }): void {
    const slot = w.slot;
    if (slot.worker === w) slot.worker = null;
    if (w.running) {
      if (!how.spawn) this.counters.crashes++;
      this.failRunning(w);
    }
    if (how.spawn) {
      this.counters.spawnFailures++;
      this.log('worker_down', { spawn: true });
    } else {
      if (!w.everReady) this.counters.startFailures++;
      this.log('worker_down', how.code === null ? { exit: true, killed: true } : { exit: true, code: how.code });
    }
    if (this.readyCount() === 0) this.goneEmpty();
    this.retry(slot);
  }

  private failRunning(w: Worker): void {
    const r = w.running;
    if (r === null) return;
    w.running = null;
    clearTimeout(r.timer);
    r.job.onFail();
  }

  /** @internal */
  onMessage(w: Worker, header: Header, payload: Buffer): void {
    if (header.op === 'pong') {
      if (w.ready || w.retired || w.dead) return;
      if (w.startTimer) clearTimeout(w.startTimer);
      w.ready = true;
      w.everReady = true;
      w.slot.failures = 0;
      if (typeof header.sampleRate === 'number') {
        w.sampleRate = header.sampleRate;
        this.sampleRateSeen ??= header.sampleRate;
      }
      if (w.slot.initial === 'pending') {
        w.slot.initial = 'ready';
        this.checkStart();
      }
      if (this.empty) {
        this.empty = false;
        this.log('pool_ready');
      }
      this.dispatch();
      return;
    }
    if (header.op === 'error' && header.id === null) return; // a model that failed to load; the exit follows
    const r = w.running;
    if (r === null || header.id !== r.id) {
      payload.fill(0); // a late message for a job already failed: dropped
      return;
    }
    // M9: a TTS stream gets its first message by its first deadline, then TTS_GAP_MS between messages.
    if (r.job.header.op === 'tts') {
      clearTimeout(r.timer);
      r.timer = this.hungAfter(w, r.id, this.ttsGapMs);
    }
    const last = r.job.onMessage(header, payload);
    if (last) {
      clearTimeout(r.timer);
      w.running = null;
      this.dispatch();
    }
  }

  /** A timer that fails the running job and kills its worker (replaced on exit) if it is still running then. */
  private hungAfter(w: Worker, id: number, ms: number): NodeJS.Timeout {
    return setTimeout(() => {
      if (w.running?.id !== id) return;
      this.counters.deadlines++;
      this.failRunning(w);
      w.kill();
      if (this.readyCount() === 0) this.goneEmpty();
    }, ms).unref();
  }

  private dispatch(): void {
    if (this.closed) return;
    for (const s of this.slots) {
      const w = s.worker;
      if (this.queue.length === 0) return;
      if (w === null || !w.ready || w.dead || w.retired || w.running !== null) continue;
      const q = this.queue.shift()!;
      clearTimeout(q.timer);
      // I1: only what is left of the job's deadline, never a fresh one.
      const left = q.due - performance.now();
      if (left <= 0) {
        this.counters.deadlines++;
        dropPayload(q.job);
        q.job.onFail();
        continue;
      }
      this.counters.dispatched++;
      w.running = { id: q.id, job: q.job, timer: this.hungAfter(w, q.id, left), cancelSent: false };
      const frame = encodeWorkerFrame({ ...q.job.header, id: q.id }, q.job.payload ?? undefined);
      q.job.payload = null; // the session owns (and zeroes) its buffer; our frame copy is zeroed once written
      w.write(frame);
    }
  }
}

function dropPayload(job: Job): void {
  job.payload = null;
}

const abortError = () => new DOMException('aborted', 'AbortError');

/** STT through the pool: one `stt` request per utterance. Rejects on an engine error, a crash, a deadline or an abort. */
export function workerStt(pool: WorkerPool, model: string): SttEngine {
  return {
    model,
    transcribe: (pcm, hint, signal) =>
      new Promise<string>((resolve, reject) => {
        if (signal.aborted) return reject(abortError());
        const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength); // PCM16 LE on every platform Node runs on here
        let settled = false;
        const settle = (f: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          f();
        };
        const handle = pool.submit({
          header: { op: 'stt', sampleRate: 16_000, hint: [...hint] },
          payload: bytes,
          onMessage: (h) => {
            if (h.op === 'stt' && typeof h.text === 'string') {
              const text = h.text;
              settle(() => (signal.aborted ? reject(abortError()) : resolve(text)));
              return true;
            }
            if (h.op === 'done' || h.op === 'error') {
              settle(() => reject(h.op === 'done' ? abortError() : new Error('stt failed')));
              return true;
            }
            return false;
          },
          onFail: () => settle(() => reject(new Error('stt worker failed'))),
        });
        // An abort while queued drops the job at once; a running one is told to stop, and this promise settles when
        // the worker answers (or its deadline passes), so the session never starts a second call into a busy engine.
        const onAbort = () => {
          handle.cancel();
          if (!handle.running()) settle(() => reject(abortError()));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
  };
}

/** TTS through the pool: one `tts` request per chunk, its `pcm` pieces yielded as they arrive. */
export function workerTts(pool: WorkerPool, model: string, sampleRate: number): TtsEngine {
  return {
    model,
    sampleRate,
    synthesize: async function* (text, voice, signal) {
      const items: (Int16Array | 'done' | Error)[] = [];
      let wake: (() => void) | null = null;
      const push = (x: Int16Array | 'done' | Error) => {
        items.push(x);
        wake?.();
        wake = null;
      };
      const state = { finished: false };
      const handle = pool.submit({
        header: { op: 'tts', voice, text },
        payload: null,
        onMessage: (h, payload) => {
          if (h.op === 'pcm') {
            if (h.sampleRate !== sampleRate || payload.byteLength % 2 !== 0) {
              push(new Error('tts sample rate'));
              return false;
            }
            const pcm = new Int16Array(payload.byteLength / 2);
            for (let i = 0; i < pcm.length; i++) pcm[i] = payload.readInt16LE(i * 2);
            payload.fill(0);
            push(pcm);
            return false;
          }
          if (h.op === 'done' || h.op === 'error') {
            state.finished = true;
            push(h.op === 'done' ? 'done' : new Error('tts failed'));
            return true;
          }
          return false;
        },
        onFail: () => {
          state.finished = true;
          push(new Error('tts worker failed'));
        },
      });
      const onAbort = () => {
        handle.cancel();
        wake?.();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        for (;;) {
          if (signal.aborted) return;
          const item = items.shift();
          if (item === undefined) {
            await new Promise<void>((r) => (wake = r));
            continue;
          }
          if (item === 'done') return;
          if (item instanceof Error) throw item;
          yield item;
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (!state.finished) handle.cancel();
      }
    },
  };
}
