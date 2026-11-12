// M7 Step 3: the Python worker's stdio contract, with its stdlib-only `echo` engine run as `python3 -I -S` (D4). CI has
// no GPU and no weights, so this is the whole worker path CI can prove: framing, cancel, errors, a crash mid-job, a
// hung job (F5), and that the worker writes nothing and prints nothing but fixed words (C-18, Review Focus 2). It fails,
// never skips, when python3 is missing.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrame, type UpstreamServerMsg } from '@kitchenquest/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { encodeWorkerFrame, FrameReader, START_ATTEMPTS, WORKER_SCRIPT, workerEnv, WorkerPool, workerStt, workerTts, type WorkerPoolOptions } from '../src/engines/worker';
import type { LogKind } from '../src/log';
import { createVoiceServer } from '../src/server';
import { connect, testConfig, type Client } from './helpers';
import { PCM_WORD, pcmChecks, WORKER_SOURCE, type DetectorName } from './leak-detectors';

const PYTHON = 'python3';
const FAULT_LINE = /^kq-voice-worker: (args|model|crash|protocol|stt|tts)$/;
const HINT = ['sesame', 'kiwi-hint-8'];

let root = '';
let dirs: { tmp: string; cwd: string; home: string };
const saved = { cwd: process.cwd(), TMPDIR: process.env.TMPDIR, HOME: process.env.HOME };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kq-voice-worker-'));
  dirs = { tmp: join(root, 'tmp'), cwd: join(root, 'cwd'), home: join(root, 'home') };
  for (const d of Object.values(dirs)) mkdirSync(d);
});
afterEach(() => {
  process.chdir(saved.cwd);
  for (const k of ['TMPDIR', 'HOME'] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

function snapshot(dir: string, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) Object.assign(out, { [`${prefix}${name}/`]: 0 }, snapshot(p, `${prefix}${name}/`));
    else out[`${prefix}${name}`] = st.size;
  }
  return out;
}

// --- a raw worker: the stdio contract without the pool -----------------------------------------------------------------

interface Raw {
  child: ChildProcessWithoutNullStreams;
  next(timeoutMs?: number): Promise<{ header: Record<string, unknown>; payload: Buffer }>;
  send(header: Record<string, unknown>, payload?: Uint8Array): void;
  stderr(): string;
  exited: Promise<number | null>;
}

function raw(extra: string[] = []): Raw {
  const child = spawn(PYTHON, ['-I', '-S', '-B', WORKER_SCRIPT, '--engine', 'echo', '--model', 'echo', '--models-dir', dirs.home, ...extra], {
    cwd: dirs.cwd,
    env: { PATH: process.env.PATH, TMPDIR: dirs.tmp, HOME: dirs.home },
  });
  const reader = new FrameReader();
  const got: { header: Record<string, unknown>; payload: Buffer }[] = [];
  let err = '';
  child.stdout.on('data', (d: Buffer) => got.push(...reader.push(d)));
  child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return {
    child,
    exited,
    stderr: () => err,
    send: (h, p) => child.stdin.write(encodeWorkerFrame(h, p)),
    next: async (timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (got.length === 0) {
        if (Date.now() > deadline) throw new Error('worker: nothing received in time');
        await new Promise((r) => setTimeout(r, 5));
      }
      return got.shift()!;
    },
  };
}

const pcm = (n: number) => new Uint8Array(new Int16Array(n).fill(PCM_WORD).buffer);

test('python3 is installed (the contract tests fail, never skip, without it)', () => {
  expect(spawnSync(PYTHON, ['--version']).status).toBe(0);
});

test('ping → pong; stt echoes "echo <n samples>"; tts streams pcm then done; cancel stops a "__kq_long__" tts; an error carries a kind and no text', async () => {
  const w = raw();
  w.send({ op: 'ping' });
  expect((await w.next()).header).toEqual({ op: 'pong', engines: ['echo'], sampleRate: 22_050 });

  w.send({ op: 'stt', id: 1, sampleRate: 16_000, hint: HINT }, pcm(320));
  expect(await w.next()).toEqual({ header: { op: 'stt', id: 1, text: 'echo 320' }, payload: Buffer.alloc(0) });

  w.send({ op: 'tts', id: 2, voice: 'pan', text: 'two words' });
  const pieces: Buffer[] = [];
  for (;;) {
    const m = await w.next();
    if (m.header.op === 'done') {
      expect(m.header).toEqual({ op: 'done', id: 2 });
      break;
    }
    expect(m.header).toEqual({ op: 'pcm', id: 2, sampleRate: 22_050 });
    pieces.push(m.payload);
  }
  expect(pieces.map((p) => p.length)).toEqual([2204, 2204]); // 50 ms per word at 22 050 Hz, PCM16

  w.send({ op: 'tts', id: 3, voice: 'pan', text: '__kq_long__' });
  expect((await w.next()).header).toEqual({ op: 'pcm', id: 3, sampleRate: 22_050 });
  w.send({ op: 'cancel', id: 3 });
  let n = 1;
  for (;;) {
    const m = await w.next();
    if (m.header.op === 'done') break;
    n++;
  }
  expect(n).toBeLessThan(100); // 10 s is 100 pieces: the cancel stopped it early

  // Fix round 1 (M7): a cancel for an id that is neither queued nor running is dropped, so it cannot cancel a later job.
  w.send({ op: 'cancel', id: 9 });
  w.send({ op: 'stt', id: 9, sampleRate: 16_000, hint: [] }, pcm(16));
  expect((await w.next()).header).toEqual({ op: 'stt', id: 9, text: 'echo 16' });

  // A wrong sample rate is an engine error: the kind, and nothing else.
  w.send({ op: 'stt', id: 4, sampleRate: 8000, hint: ['zebrapeanut71'] }, pcm(160));
  const e = await w.next();
  expect(e.header).toEqual({ op: 'error', id: 4, kind: 'stt' });
  expect(e.payload.length).toBe(0);

  w.child.stdin.end();
  expect(await w.exited).toBe(0);
  expect(w.stderr()).toBe('');
});

test('the -I -S run proves the echo path needs no site-packages: it starts and answers ping (D4); the worker imports only the stdlib and nothing from the repo', async () => {
  const w = raw();
  w.send({ op: 'ping' });
  expect((await w.next()).header.op).toBe('pong');
  w.child.stdin.end();
  expect(await w.exited).toBe(0);
  const src = readFileSync(WORKER_SOURCE, 'utf8');
  const topLevel = [...src.matchAll(/^(?:import (\w+)|from (\w+) import)/gm)].map((m) => m[1] ?? m[2]);
  expect(topLevel.sort()).toEqual(['array', 'json', 'os', 'struct', 'sys', 'threading', 'time']);
  expect(src).not.toMatch(/kitchenquest|@kitchenquest|\.\.\/src/i);
  expect(src.split('\n').slice(0, 3).join('\n')).toMatch(/SPDX-License-Identifier: GPL-3\.0-or-later/);
});

// --- the pool -----------------------------------------------------------------------------------------------------------

const pools: WorkerPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

function pool(extraArgs: string[] = [], deadlines?: WorkerPoolOptions['deadlines'], over: Partial<WorkerPoolOptions> = {}): WorkerPool {
  const p = new WorkerPool({ python: PYTHON, engine: 'echo', model: 'echo', modelsDir: dirs.home, size: 1, extraArgs, deadlines, ...over });
  pools.push(p);
  return p;
}

/** Fix round 1 (I2): an empty pool fails jobs at once, so a test that crashes a worker waits for its replacement. */
async function ready(p: WorkerPool, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!p.ready) {
    if (Date.now() > deadline) throw new Error('the pool did not become ready');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const never = new AbortController().signal;
const samples = (n: number) => new Int16Array(n).fill(PCM_WORD);

describe('WorkerPool', () => {
  test('"__kq_crash__" kills the worker mid-job: that job fails with kind upstream, the pool restarts it and serves the next job; stderr is counted, not logged (Review Focus 2)', async () => {
    const p = pool();
    await p.start();
    const stt = workerStt(p, 'echo-stt');
    expect(await stt.transcribe(samples(160), [], never)).toBe('echo 160');
    await expect(stt.transcribe(samples(160), ['__kq_crash__'], never)).rejects.toThrow();
    expect(p.counters.crashes).toBe(1);
    await ready(p);
    expect(await stt.transcribe(samples(480), [], never)).toBe('echo 480');
    expect(p.counters.restarts).toBe(1);
    expect(p.counters.stderrBytes).toBe('kq-voice-worker: crash\n'.length);

    // Through the real server: the upstream client gets `failed` stt for the crash, then a transcript; the service's
    // own output holds log lines only, never the worker's words.
    const logs: [LogKind, Record<string, number | boolean> | undefined][] = [];
    const server = createVoiceServer({ config: testConfig(), stt, tts: workerTts(p, 'echo-tts', 22_050), log: (k, f) => logs.push([k, f]) });
    const port = await server.listen(0);
    const c = await connect(port);
    c.send({ t: 'hello', v: 1 });
    await waitFor(c, (m) => m.t === 'ready');
    await utter(c, 1, ['__kq_crash__']);
    expect(await waitFor(c, hasId(1))).toEqual({ t: 'failed', id: 1, kind: 'stt' });
    await ready(p);
    await utter(c, 2, []);
    expect(await waitFor(c, hasId(2))).toEqual({ t: 'transcript', id: 2, text: 'echo 3200' });
    c.ws.close();
    await c.closed;
    await server.close();
    expect(p.counters.crashes).toBe(2);
    expect(logs).toContainEqual(['engine_error', { stt: true }]);
  });

  test('F5: a hung STT job fails at its deadline and the worker is replaced; a hung TTS stream fails at its gap deadline; neither hangs the caller', async () => {
    const p = pool([], { sttMs: 400, ttsFirstMs: 400, ttsGapMs: 400 });
    await p.start();
    const stt = workerStt(p, 'echo-stt');
    const t0 = Date.now();
    await expect(stt.transcribe(samples(160), ['__kq_hang__'], never)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(p.counters.deadlines).toBe(1);
    await ready(p);
    expect(await stt.transcribe(samples(160), [], never)).toBe('echo 160');
    expect(p.counters.restarts).toBe(1);

    const tts = workerTts(p, 'echo-tts', 22_050);
    const pieces: Int16Array[] = [];
    await expect(
      (async () => {
        for await (const piece of tts.synthesize('__kq_hang__', 'pan', never)) pieces.push(piece);
      })(),
    ).rejects.toThrow();
    expect(p.counters.deadlines).toBe(2);
    await ready(p);
    expect(await stt.transcribe(samples(320), [], never)).toBe('echo 320');

    // An aborted STT that the worker is running settles only when the worker answers: the engine is never asked twice
    // at once (review M2). One that is still queued is dropped at once.
    const ac = new AbortController();
    const running = stt.transcribe(samples(160), ['__kq_hang__'], ac.signal);
    const queued = new AbortController();
    const behind = stt.transcribe(samples(160), [], queued.signal);
    await new Promise((r) => setTimeout(r, 50));
    queued.abort();
    await expect(behind).rejects.toThrow(/aborted/);
    ac.abort();
    await expect(running).rejects.toThrow(); // at the deadline: the hung worker never answers the cancel
    expect(p.counters.deadlines).toBe(3);
  });

  test('a TTS stream through the pool yields PCM16 at the declared rate; a cancelled "__kq_long__" stops early; a rate mismatch is an error', async () => {
    const p = pool();
    await p.start();
    expect(p.sampleRate).toBe(22_050);
    const tts = workerTts(p, 'echo-tts', 22_050);
    const got: number[] = [];
    for await (const piece of tts.synthesize('one two three', 'pan', never)) got.push(piece.length);
    expect(got).toEqual([1102, 1102, 1102]);

    const ac = new AbortController();
    let n = 0;
    for await (const _ of tts.synthesize('__kq_long__', 'pan', ac.signal)) if (++n === 3) ac.abort();
    expect(n).toBe(3);
    // The worker is free again straight after the cancel.
    expect(await workerStt(p, 'echo-stt').transcribe(samples(10), [], never)).toBe('echo 10');

    const wrong = workerTts(p, 'echo-tts', 24_000);
    await expect(
      (async () => {
        for await (const _ of wrong.synthesize('hello', 'pan', never));
      })(),
    ).rejects.toThrow(/sample rate/);
  });

  test('the worker environment is an allowlist: no token or other variable passes; models offline and onnxruntime telemetry off', () => {
    const env = workerEnv({ PATH: '/bin', HOME: '/h', TMPDIR: '/t', VOICE_SERVICE_TOKEN: 'secret', OPENROUTER_API_KEY: 'k', NODE_OPTIONS: '--x', PYTHONPATH: '/evil' });
    // Fix round 1 (M4): HOME points nowhere, so a library that writes under it fails instead of writing.
    expect(env).toEqual({ PATH: '/bin', HOME: '/nonexistent/kq-voice-worker', TMPDIR: '/t', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', ORT_DISABLE_TELEMETRY: '1', OMP_NUM_THREADS: '1', LANG: 'C.UTF-8' });
  });

  test('start() refuses a worker whose engine cannot load, naming only the engine and model', async () => {
    // Fix round 1 (M12): an empty models directory, so the model fails to load whatever the host's Python has installed.
    const p = new WorkerPool({ python: PYTHON, engine: 'whisper', model: 'faster-whisper-base.en', modelsDir: dirs.home, size: 1, deadlines: { startMs: 20_000 } });
    await expect(p.start()).rejects.toThrow(/voice worker \(whisper faster-whisper-base\.en\) did not start/);
    expect(p.size).toBe(0);
    // Each attempt failed with the `model` fault word and nothing else (START_ATTEMPTS of them, I2).
    const word = 'kq-voice-worker: model\n'.length;
    expect(p.counters.stderrBytes % word).toBe(0);
    expect(p.counters.stderrBytes / word).toBe(p.counters.spawnFailures + p.counters.startFailures);
  });

  test('fix round 1 (I1): the STT deadline counts from submission: a job that waited in the queue gets only what is left of it', async () => {
    const p = pool([], { sttMs: 700 });
    await p.start();
    const stt = workerStt(p, 'echo-stt');
    const t0 = Date.now();
    const first = stt.transcribe(samples(160), ['__kq_slow__'], never); // runs 0–400 ms
    const second = stt.transcribe(samples(160), ['__kq_slow__'], never); // queued at 0, runs 400–800 ms: past 700
    expect(await first).toBe('echo 160');
    await expect(second).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(780); // failed at its deadline, not 700 ms after it reached a worker
    expect(p.counters.deadlines).toBe(1);
  });

  test('fix round 1 (I1): a job still queued past its deadline gets failed and is never dispatched', async () => {
    const p = pool([], { sttMs: 300, ttsFirstMs: 5000 });
    await p.start();
    const tts = workerTts(p, 'echo-tts', 22_050);
    const busy = (async () => {
      let n = 0;
      for await (const _ of tts.synthesize('__kq_slow__ one', 'pan', never)) n++;
      return n;
    })();
    const t0 = Date.now();
    await expect(workerStt(p, 'echo-stt').transcribe(samples(160), [], never)).rejects.toThrow();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect(Date.now() - t0).toBeLessThan(400);
    expect(await busy).toBe(2);
    expect(p.counters.dispatched).toBe(1); // only the TTS job ever reached the worker
  });

  test('fix round 1 (M9): a TTS stream has a first-message deadline from submission, then the gap deadline between messages', async () => {
    const p = pool([], { ttsGapMs: 200, ttsFirstMs: 2000 });
    await p.start();
    const tts = workerTts(p, 'echo-tts', 22_050);
    let n = 0;
    for await (const _ of tts.synthesize('__kq_slow__ two words', 'pan', never)) n++; // 400 ms before the first piece
    expect(n).toBe(3);
    expect(p.counters.deadlines).toBe(0);
  });

  test('fix round 1 (M5): before replacing a worker the pool re-runs its verify step; a failing one is a failed start, retried', async () => {
    let ok = true;
    let calls = 0;
    const p = pool([], undefined, {
      verify: async () => {
        calls++;
        if (!ok) throw new Error('pins');
      },
    });
    await p.start();
    expect(calls).toBe(0); // boot verified the pins already
    ok = false;
    await expect(workerStt(p, 'echo-stt').transcribe(samples(10), ['__kq_crash__'], never)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(p.ready).toBe(false);
    expect(p.counters.verifyFailures).toBe(calls);
    ok = true;
    await ready(p);
    expect(await workerStt(p, 'echo-stt').transcribe(samples(10), [], never)).toBe('echo 10');
  });
});

describe('fix round 1 (I2): a worker that cannot be spawned', () => {
  /** A python3 that can vanish and come back: a symlink the test removes and restores. */
  function vanishingPython(present: boolean): { path: string; restore(): void; remove(): void } {
    const path = join(root, 'bin', 'python3');
    mkdirSync(join(root, 'bin'), { recursive: true });
    const real = spawnSync(PYTHON, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
    const restore = () => symlinkSync(real, path);
    const remove = () => unlinkSync(path);
    if (present) restore();
    return { path, restore, remove };
  }

  test('at start: a missing python is retried with backoff, and start() resolves once it appears', async () => {
    const py = vanishingPython(false);
    const logs: [LogKind, Record<string, number | boolean> | undefined][] = [];
    const p = pool([], undefined, { python: py.path, log: (k, f) => logs.push([k, f]) });
    setTimeout(py.restore, 300);
    await p.start();
    expect(p.ready).toBe(true);
    expect(p.counters.spawnFailures).toBeGreaterThan(0);
    expect(logs).toContainEqual(['worker_down', { stt: true, spawn: true }]);
    expect(await workerStt(p, 'echo-stt').transcribe(samples(10), [], never)).toBe('echo 10');
  });

  test(`at start: no worker within START_ATTEMPTS attempts rejects start(), so boot fails and main exits non-zero`, async () => {
    const py = vanishingPython(false);
    const p = pool([], undefined, { python: py.path });
    const t0 = Date.now();
    await expect(p.start()).rejects.toThrow(/did not start/);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(p.counters.spawnFailures).toBe(START_ATTEMPTS);
  });

  test('at run time: the pool keeps retrying forever, fails utterances at once while empty, reports not ready, and recovers when python returns', async () => {
    const py = vanishingPython(true);
    const logs: [LogKind, Record<string, number | boolean> | undefined][] = [];
    const p = pool([], undefined, { python: py.path, log: (k, f) => logs.push([k, f]) });
    await p.start();
    expect(p.ready).toBe(true);
    py.remove();
    const stt = workerStt(p, 'echo-stt');
    await expect(stt.transcribe(samples(10), ['__kq_crash__'], never)).rejects.toThrow();
    // Empty: refused at once, not at the 20 s deadline.
    const t0 = Date.now();
    await expect(stt.transcribe(samples(10), [], never)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(100);
    expect(p.ready).toBe(false);
    expect(logs).toContainEqual(['pool_empty', { stt: true }]);
    // Retried with backoff, a content-free line each time; well past START_ATTEMPTS.
    await new Promise((r) => setTimeout(r, 6000));
    expect(p.counters.spawnFailures).toBeGreaterThan(START_ATTEMPTS);
    expect(logs.filter(([k, f]) => k === 'worker_down' && f?.spawn === true).length).toBe(p.counters.spawnFailures);
    py.restore();
    await ready(p, 10_000);
    expect(logs.at(-1)).toEqual(['pool_ready', { stt: true }]);
    expect(await stt.transcribe(samples(20), [], never)).toBe('echo 20');
    for (const [, f] of logs) for (const v of Object.values(f ?? {})) expect(['number', 'boolean']).toContain(typeof v);
  });
});

// --- C-18: nothing written, nothing printed but fixed words (D1: with positive controls) --------------------------------

async function waitFor(c: Client, pred: (m: UpstreamServerMsg) => boolean): Promise<UpstreamServerMsg> {
  for (;;) {
    const r = await c.next(8000);
    if (r.kind === 'msg' && pred(r.msg)) return r.msg;
  }
}
const hasId = (id: number) => (m: UpstreamServerMsg) => 'id' in m && m.id === id;

async function utter(c: Client, id: number, hint: string[]): Promise<void> {
  c.send({ t: 'listen', id, hint });
  for (let i = 0; i < 10; i++) c.send(encodeFrame(id, samples(320)));
  c.send({ t: 'end', id });
}

/** A whole session through the real server and an echo pool, in fresh cwd, TMPDIR and HOME. */
type Snaps = Record<'tmp' | 'cwd' | 'home', Record<string, number>>;

async function session(extraArgs: string[]): Promise<{ reached: boolean[]; before: Snaps; after: Snaps; stderrBytes: number }> {
  process.env.TMPDIR = dirs.tmp;
  process.env.HOME = dirs.home;
  process.chdir(dirs.cwd);
  const before = { tmp: snapshot(dirs.tmp), cwd: snapshot(dirs.cwd), home: snapshot(dirs.home) };
  const p = pool(extraArgs);
  await p.start();
  const server = createVoiceServer({ config: testConfig(), stt: workerStt(p, 'echo-stt'), tts: workerTts(p, 'echo-tts', 22_050), log: () => {} });
  const port = await server.listen(0);
  const c = await connect(port);
  c.send({ t: 'hello', v: 1 });
  await waitFor(c, (m) => m.t === 'ready');
  await utter(c, 1, HINT);
  const t = await waitFor(c, hasId(1));
  c.send({ t: 'speak', id: 2, voice: 'pan', chunks: [{ text: 'quagga lentil', cache: false }] });
  const a = await waitFor(c, hasId(2));
  c.send({ t: 'listen', id: 3, hint: HINT });
  for (let i = 0; i < 5; i++) c.send(encodeFrame(3, samples(320)));
  c.ws.terminate();
  await c.closed;
  await server.close();
  await p.close();
  const after = { tmp: snapshot(dirs.tmp), cwd: snapshot(dirs.cwd), home: snapshot(dirs.home) };
  return { reached: [t.t === 'transcript' && t.text === 'echo 3200', a.t === 'audio_end'], before, after, stderrBytes: p.counters.stderrBytes };
}

/** The worker's stderr, raw, for one STT job with these leak formats. */
async function rawStderr(formats: string[]): Promise<string> {
  const w = raw(formats.flatMap((f) => ['--leak-for-test', f]));
  w.send({ op: 'stt', id: 1, sampleRate: 16_000, hint: HINT }, pcm(320));
  expect((await w.next()).header).toEqual({ op: 'stt', id: 1, text: 'echo 320' });
  w.child.stdin.end();
  await w.exited;
  return w.stderr();
}

function stderrChecks(err: string): Record<string, boolean> {
  return {
    onlyFaultWords: err.split('\n').every((l) => l === '' || FAULT_LINE.test(l)),
    noHint: !HINT.some((h) => err.includes(h)),
    ...pcmChecks(err),
  };
}

test('cwd and TMPDIR snapshots are identical after a session; positive control: an echo run with --leak-for-test writes a file and the check fails (D1)', async () => {
  const clean = await session([]);
  expect(clean.reached).toEqual([true, true]);
  expect(clean.after).toEqual(clean.before);
  expect(clean.stderrBytes).toBe(0);

  const leaky = await session(['--leak-for-test', 'file', '--leak-for-test', 'text']);
  expect(leaky.reached).toEqual([true, true]);
  expect(leaky.after.tmp).toHaveProperty('kq-leak.pcm');
  expect(leaky.after.cwd).toHaveProperty('kq-leak.pcm');
  expect(leaky.after).not.toEqual(leaky.before);
  expect(leaky.stderrBytes).toBeGreaterThan(0); // counted, and never surfaced
});

test('the worker stderr is content-free: only fixed fault words, no hint, no PCM in any encoding (F3: the worker\'s own float conversion included)', async () => {
  expect(stderrChecks(await rawStderr([]))).toEqual(Object.fromEntries(Object.keys(stderrChecks('')).map((k) => [k, true])));
});

const WORKER_LEAKS: [string, (DetectorName | 'onlyFaultWords' | 'noHint')[]][] = [
  ['text', ['onlyFaultWords', 'noHint']],
  ['int16-hex', ['onlyFaultWords', 'noPcmHex']],
  ['float64-repr', ['onlyFaultWords', 'noFloatPcm']],
  ['float32-str', ['onlyFaultWords', 'noFloatPcm']],
  ['float32-hex', ['onlyFaultWords', 'noFloatHex']],
  ['float32-b64', ['onlyFaultWords', 'noFloatPcmBase64']],
  ['float64-hex', ['onlyFaultWords', 'noFloatHex']],
  ['float64-b64', ['onlyFaultWords', 'noFloatPcmBase64']],
];

test.each(WORKER_LEAKS)('positive control (F3): the worker leaking its converted PCM as %s fails its check', async (format, fails) => {
  const got = stderrChecks(await rawStderr([format]));
  for (const k of fails) expect(got[k], k).toBe(false);
});
