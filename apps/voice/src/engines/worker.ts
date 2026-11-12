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
// F5 (Step 2 fix round 3): every request has a deadline. STT: STT_DEADLINE_MS from submission, queue time included.
// TTS: TTS_GAP_MS between messages. A request past its deadline fails (the session answers `failed`), and a worker
// still holding it is killed and restarted, so a hung engine can never hang an utterance. A worker that crashes
// mid-job fails that job the same way and is restarted.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SttEngine, TtsEngine } from './types.js';

export type WorkerEngineName = 'echo' | 'whisper' | 'kokoro' | 'piper';

export const WORKER_SCRIPT = fileURLToPath(new URL('../../worker/kq_voice_worker.py', import.meta.url));
/** Model loading can take a while on a cold box; a worker that has not answered `ping` by then is refused. */
const START_TIMEOUT_MS = 120_000;
/** One utterance (at most MAX_UTTERANCE_MS of audio) from submission to transcript, queue time included. */
const STT_DEADLINE_MS = 20_000;
/** The longest silence between two messages of one TTS job. */
const TTS_GAP_MS = 10_000;
const MAX_HEADER = 64 * 1024;
const MAX_PAYLOAD = 4 * 1024 * 1024;
const RESTART_MIN_MS = 100;
const RESTART_MAX_MS = 5000;
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
 */
export function workerEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', ORT_DISABLE_TELEMETRY: '1', OMP_NUM_THREADS: '1', LANG: 'C.UTF-8' };
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LD_LIBRARY_PATH'] as const) if (parent[k] !== undefined) env[k] = parent[k];
  return env;
}

interface Job {
  header: Header & { op: 'stt' | 'tts' };
  payload: Uint8Array | null;
  /** A message for this job; returns true when it was the job's last. */
  onMessage(header: Header, payload: Buffer): boolean;
  /** The worker crashed or hung, the deadline passed, or the pool closed. Called at most once, never after the last message. */
  onFail(): void;
  deadlineMs: number;
  /** TTS: the deadline restarts with every message. */
  gap: boolean;
}

interface Handle {
  /** Drops a queued job, or asks the worker to stop a running one (which still ends with its last message). */
  cancel(): void;
  /** Whether a worker holds the job now. */
  running(): boolean;
}

interface Running {
  id: number;
  job: Job;
  timer: NodeJS.Timeout;
  cancelSent: boolean;
}

class Worker {
  readonly child: ChildProcessWithoutNullStreams;
  running: Running | null = null;
  ready = false;
  dead = false;
  sampleRate: number | null = null;
  onReady: (() => void) | null = null;
  /** Killed: never ready again. */
  retired = false;
  /** Answered its first ping: a worker that dies after this is replaced. */
  everReady = false;
  private readonly reader = new FrameReader();

  constructor(
    private readonly pool: WorkerPool,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: process.cwd() });
    this.child.stdin.on('error', () => {});
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
    this.child.once('exit', () => {
      this.dead = true;
      this.pool.onExit(this);
    });
    this.child.once('error', () => {
      this.dead = true;
    });
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
  /** TTS: the cast voice (kokoro serves one language per process and warms up with it). */
  voice?: string;
  /** Extra worker arguments: tests only (`--leak-for-test`). */
  extraArgs?: string[];
  /** Deadlines in ms; tests shorten them. */
  deadlines?: { sttMs?: number; ttsGapMs?: number; startMs?: number };
}

/** A fixed number of worker processes for one engine and model, with a queue, deadlines and restarts. */
export class WorkerPool {
  /** Counts only (C-18): what the workers wrote to stderr, and why workers were replaced. */
  readonly counters = { stderrBytes: 0, restarts: 0, crashes: 0, deadlines: 0, protocol: 0 };
  private readonly workers = new Set<Worker>();
  private readonly queue: { id: number; job: Job; timer: NodeJS.Timeout }[] = [];
  private nextId = 1;
  private closed = false;
  private started = false;
  private failures = 0;
  private sampleRateSeen: number | null = null;
  private readonly sttMs: number;
  private readonly ttsGapMs: number;
  private readonly startMs: number;

  constructor(private readonly opts: WorkerPoolOptions) {
    if (!Number.isInteger(opts.size) || opts.size < 1) throw new Error('WorkerPool: size must be a positive whole number');
    this.sttMs = opts.deadlines?.sttMs ?? STT_DEADLINE_MS;
    this.ttsGapMs = opts.deadlines?.ttsGapMs ?? TTS_GAP_MS;
    this.startMs = opts.deadlines?.startMs ?? START_TIMEOUT_MS;
  }

  /** The TTS sample rate the workers reported in `pong` (null for STT). */
  get sampleRate(): number | null {
    return this.sampleRateSeen;
  }

  get deadlines(): { sttMs: number; ttsGapMs: number } {
    return { sttMs: this.sttMs, ttsGapMs: this.ttsGapMs };
  }

  /** Live workers, for tests. */
  get size(): number {
    return [...this.workers].filter((w) => !w.dead).length;
  }

  /** Spawns every worker and waits for each one's `pong`; rejects (and stops them all) if any fails to load. */
  async start(): Promise<void> {
    try {
      await Promise.all(Array.from({ length: this.opts.size }, () => this.spawnOne()));
    } catch (e) {
      await this.close();
      throw e;
    }
    this.started = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const q of this.queue.splice(0)) {
      clearTimeout(q.timer);
      dropPayload(q.job);
      q.job.onFail();
    }
    const exits: Promise<void>[] = [];
    for (const w of this.workers) {
      if (w.running) this.failRunning(w);
      if (w.dead) continue;
      exits.push(new Promise<void>((resolve) => w.child.once('exit', () => resolve())));
      w.child.stdin.end();
      setTimeout(() => w.kill(), CLOSE_GRACE_MS).unref();
    }
    await Promise.all(exits);
  }

  /** Queues a job; it runs on the next idle worker. */
  submit(job: Job): Handle {
    const id = this.nextId++;
    if (this.nextId > 0xffffffff) this.nextId = 1;
    if (this.closed) {
      dropPayload(job);
      queueMicrotask(() => job.onFail());
      return { cancel: () => {}, running: () => false };
    }
    const timer = setTimeout(() => {
      const i = this.queue.findIndex((q) => q.id === id);
      if (i < 0) return;
      this.queue.splice(i, 1);
      this.counters.deadlines++;
      dropPayload(job);
      job.onFail();
    }, job.deadlineMs);
    timer.unref();
    this.queue.push({ id, job, timer });
    this.dispatch();
    return {
      running: () => [...this.workers].some((w) => w.running?.id === id),
      cancel: () => {
        const i = this.queue.findIndex((q) => q.id === id);
        if (i >= 0) {
          const [q] = this.queue.splice(i, 1);
          clearTimeout(q.timer);
          dropPayload(job);
          return;
        }
        for (const w of this.workers) {
          if (w.running?.id === id && !w.running.cancelSent) {
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

  private spawnOne(): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = new Worker(this, this.opts.python, this.args(), workerEnv(process.env));
      this.workers.add(w);
      let settled = false;
      const timer = setTimeout(() => fail(), this.startMs);
      timer.unref();
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        w.kill();
        reject(new Error(`voice worker (${this.opts.engine} ${this.opts.model}) did not start: the engine or its model failed to load`));
      };
      w.child.once('error', fail);
      w.child.once('exit', fail);
      const ping = encodeWorkerFrame({ op: 'ping' });
      w.write(ping);
      w.onReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** @internal */
  onMessage(w: Worker, header: Header, payload: Buffer): void {
    if (header.op === 'pong') {
      if (w.ready || w.retired) return;
      w.ready = true;
      w.everReady = true;
      if (typeof header.sampleRate === 'number') {
        w.sampleRate = header.sampleRate;
        this.sampleRateSeen ??= header.sampleRate;
      }
      w.onReady?.();
      this.dispatch();
      return;
    }
    if (header.op === 'error' && header.id === null) return; // a model that failed to load; the exit follows
    const r = w.running;
    if (r === null || header.id !== r.id) {
      payload.fill(0); // a late message for a job already failed: dropped
      return;
    }
    if (r.job.gap) r.timer.refresh();
    const last = r.job.onMessage(header, payload);
    if (last) {
      clearTimeout(r.timer);
      w.running = null;
      this.failures = 0;
      this.dispatch();
    }
  }

  /** @internal */
  onExit(w: Worker): void {
    this.workers.delete(w);
    if (w.running) {
      this.counters.crashes++;
      this.failRunning(w);
    }
    // Replace it, backing off while workers keep dying: once the pool has started, or for a worker that had loaded
    // (a model that fails to load during start() fails start() instead).
    if (this.closed || (!this.started && !w.everReady)) return;
    this.counters.restarts++;
    const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** this.failures);
    this.failures++;
    setTimeout(() => {
      if (!this.closed) this.spawnOne().catch(() => this.onRespawnFailed());
    }, delay).unref();
  }

  private onRespawnFailed(): void {
    // spawnOne killed it; its exit already scheduled the next attempt (onExit), with a longer delay.
  }

  private failRunning(w: Worker): void {
    const r = w.running;
    if (r === null) return;
    w.running = null;
    clearTimeout(r.timer);
    r.job.onFail();
  }

  private dispatch(): void {
    if (this.closed) return;
    for (const w of this.workers) {
      if (this.queue.length === 0) return;
      if (!w.ready || w.dead || w.running !== null) continue;
      const q = this.queue.shift()!;
      clearTimeout(q.timer);
      const timer = setTimeout(() => {
        if (w.running?.id !== q.id) return;
        this.counters.deadlines++;
        this.failRunning(w);
        w.kill(); // a hung worker: replaced by onExit
      }, q.job.deadlineMs);
      timer.unref();
      w.running = { id: q.id, job: q.job, timer, cancelSent: false };
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
          deadlineMs: pool.deadlines.sttMs,
          gap: false,
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
        deadlineMs: pool.deadlines.ttsGapMs,
        gap: true,
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
