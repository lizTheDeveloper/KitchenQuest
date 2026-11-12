// M7 C-18: "Audio is processed in memory and never stored": no disk, no logging of audio or transcripts. A full session
// runs against the real server, then the service's filesystem and output are checked. D1: the same run with a
// deliberately leaking fake must fail every check, so a check that can never fail cannot pass here.
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrame, type UpstreamServerMsg } from '@kitchenquest/core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeStt, fakeTts } from '../src/engines/fake';
import type { SttEngine, TtsEngine } from '../src/engines/types';
import { createLogger } from '../src/log';
import { createVoiceServer } from '../src/server';
import { connect, testConfig, type Client } from './helpers';

const PCM_WORD = 0x4b51;
const STT_MARKER = 'zebrapeanut71';
const TTS_MARKER = 'quagga-lentil-42';
const pcmFrame = () => new Int16Array(320).fill(PCM_WORD);
const pcmBytes = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

type Snapshot = Record<string, number>;
interface Evidence {
  transcript: boolean;
  audioEnd: boolean;
  failedStt: boolean;
  failedTts: boolean;
  before: Snapshot[];
  after: Snapshot[];
  writeCalls: string[];
  output: string;
}

// --- the environment: fresh TMPDIR, HOME and cwd ---------------------------------------------------------------------

let root = '';
let dirs: string[] = [];
const saved = { cwd: process.cwd(), TMPDIR: process.env.TMPDIR, HOME: process.env.HOME };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kq-voice-c18-'));
  dirs = ['tmp', 'home', 'cwd'].map((d) => join(root, d));
  for (const d of dirs) mkdirSync(d);
  process.env.TMPDIR = dirs[0];
  process.env.HOME = dirs[1];
  process.chdir(dirs[2]!);
});

afterEach(() => {
  process.chdir(saved.cwd);
  for (const k of ['TMPDIR', 'HOME'] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

function snapshot(dir: string, prefix = ''): Snapshot {
  const out: Snapshot = {};
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) Object.assign(out, { [`${prefix}${name}/`]: 0 }, snapshot(p, `${prefix}${name}/`));
    else out[`${prefix}${name}`] = st.size;
  }
  return out;
}

// --- the second net: spies on every fs write API, and captured stdout, stderr and console ----------------------------

const WRITE_FLAGS = /[wa+]/;
const WRITE_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC;
const forWrite = (flags: unknown) => (typeof flags === 'string' ? WRITE_FLAGS.test(flags) : typeof flags === 'number' ? (flags & WRITE_BITS) !== 0 : false);

function installNets(): { writeCalls: string[]; output: string[]; restore(): void } {
  const writeCalls: string[] = [];
  const output: string[] = [];
  const restores: (() => void)[] = [];
  const always = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'write', 'writeSync', 'writev', 'writevSync', 'createWriteStream', 'cp', 'cpSync', 'copyFile', 'copyFileSync', 'mkdtemp', 'mkdtempSync'] as const;
  const target = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of always) {
    const orig = target[name]!;
    const spy = vi.spyOn(target, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      writeCalls.push(`fs.${name}`);
      return orig.apply(this, args);
    });
    restores.push(() => spy.mockRestore());
  }
  for (const name of ['open', 'openSync'] as const) {
    const orig = target[name]!;
    const spy = vi.spyOn(target, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (forWrite(args[1])) writeCalls.push(`fs.${name}`);
      return orig.apply(this, args);
    });
    restores.push(() => spy.mockRestore());
  }
  const promises = fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ['writeFile', 'appendFile', 'cp', 'copyFile', 'mkdtemp', 'open'] as const) {
    const orig = promises[name]!;
    const spy = vi.spyOn(promises, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (name !== 'open' || forWrite(args[1])) writeCalls.push(`fs.promises.${name}`);
      return orig.apply(this, args);
    });
    restores.push(() => spy.mockRestore());
  }
  syncBuiltinESMExports(); // named imports of node:fs see the spies too

  const capture = (chunk: unknown) => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return true;
  };
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  restores.push(() => out.mockRestore(), () => err.mockRestore());
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    const spy = vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void capture(args.map(String).join(' ')));
    restores.push(() => spy.mockRestore());
  }
  return {
    writeCalls,
    output,
    restore() {
      for (const r of restores.reverse()) r();
      syncBuiltinESMExports();
    },
  };
}

// --- the engines -----------------------------------------------------------------------------------------------------

/** Honest fakes. The hint word `boom` makes the STT throw, and the text `boom …` the TTS, each with a marker in the message. */
function engines(): { stt: SttEngine; tts: TtsEngine } {
  const base = fakeStt(() => STT_MARKER);
  const tts = fakeTts();
  return {
    stt: {
      model: base.model,
      transcribe: (pcm, hint, signal) => {
        if (hint.includes('boom')) return Promise.reject(new Error(`stt crashed on ${STT_MARKER} ${pcmBytes(pcm).toString('hex')}`));
        return base.transcribe(pcm, hint, signal);
      },
    },
    tts: {
      model: tts.model,
      sampleRate: tts.sampleRate,
      synthesize: (text, voice, signal) => {
        if (text.startsWith('boom')) throw new Error(`tts crashed on ${text}`);
        return tts.synthesize(text, voice, signal);
      },
    },
  };
}

/** The positive control: the same engines, except the STT writes the audio to TMPDIR and logs it and the transcript. */
function leakingEngines(): { stt: SttEngine; tts: TtsEngine } {
  const honest = engines();
  return {
    tts: honest.tts,
    stt: {
      model: honest.stt.model,
      transcribe: async (pcm, hint, signal) => {
        const text = await honest.stt.transcribe(pcm, hint, signal);
        const bytes = pcmBytes(pcm);
        writeFileSync(join(tmpdir(), 'utterance.pcm'), bytes);
        console.log(`heard: ${text}`);
        process.stderr.write(`debug pcm hex=${bytes.subarray(0, 16).toString('hex')} b64=${bytes.subarray(0, 24).toString('base64')} dec=${Array.from(pcm.subarray(0, 4)).join(',')}\n`);
        return text;
      },
    },
  };
}

// --- one full session ------------------------------------------------------------------------------------------------

async function waitFor(c: Client, pred: (m: UpstreamServerMsg) => boolean): Promise<UpstreamServerMsg> {
  for (;;) {
    const r = await c.next();
    if (r.kind === 'msg' && pred(r.msg)) return r.msg;
  }
}

async function runSession(e: { stt: SttEngine; tts: TtsEngine }): Promise<Evidence> {
  const before = dirs.map((d) => snapshot(d));
  const nets = installNets();
  const ev = { transcript: false, audioEnd: false, failedStt: false, failedTts: false };
  try {
    // The real logger, writing to the real (captured) stdout.
    const server = createVoiceServer({ config: testConfig(), stt: e.stt, tts: e.tts, log: createLogger() });
    const port = await server.listen(0);

    const a = await connect(port);
    a.send({ t: 'hello', v: 1 });
    await waitFor(a, (m) => m.t === 'ready');
    a.send({ t: 'listen', id: 1, hint: ['peanut', 'sesame'] });
    for (let i = 0; i < 50; i++) a.send(encodeFrame(1, pcmFrame()));
    a.send({ t: 'end', id: 1 });
    const t = await waitFor(a, (m) => m.t !== 'ready');
    ev.transcript = t.t === 'transcript' && t.text === STT_MARKER;
    a.send({ t: 'speak', id: 2, voice: 'pan', chunks: [{ text: TTS_MARKER, cache: false }] });
    ev.audioEnd = (await waitFor(a, (m) => m.id === 2)).t === 'audio_end';
    // speak, then cancel mid-chunk
    a.send({ t: 'speak', id: 3, voice: 'pan', chunks: [{ text: Array.from({ length: 60 }, () => TTS_MARKER).join(' '), cache: true }] });
    for (;;) if ((await a.next()).kind === 'frame') break;
    a.send({ t: 'cancel', id: 3 });
    // a second listen, closed mid-utterance
    a.send({ t: 'listen', id: 4, hint: [] });
    for (let i = 0; i < 10; i++) a.send(encodeFrame(4, pcmFrame()));
    a.ws.terminate();
    await a.closed;

    // the throwing engines, with markers in their messages
    const b = await connect(port);
    b.send({ t: 'hello', v: 1 });
    await waitFor(b, (m) => m.t === 'ready');
    b.send({ t: 'listen', id: 5, hint: ['boom'] });
    for (let i = 0; i < 5; i++) b.send(encodeFrame(5, pcmFrame()));
    b.send({ t: 'end', id: 5 });
    const f = await waitFor(b, (m) => m.id === 5);
    ev.failedStt = f.t === 'failed' && f.kind === 'stt';
    b.send({ t: 'speak', id: 6, voice: 'pan', chunks: [{ text: `boom ${TTS_MARKER}`, cache: false }] });
    const g = await waitFor(b, (m) => m.id === 6);
    ev.failedTts = g.t === 'failed' && g.kind === 'tts';
    b.ws.close();
    await b.closed;
    await server.close();
  } finally {
    nets.restore();
  }
  return { ...ev, before, after: dirs.map((d) => snapshot(d)), writeCalls: nets.writeCalls, output: nets.output.join('') };
}

// --- the checks ------------------------------------------------------------------------------------------------------

const sample = pcmBytes(new Int16Array(16).fill(PCM_WORD));
const PCM_HEX = [sample.subarray(0, 8).toString('hex'), sample.subarray(1, 9).toString('hex')];
const PCM_B64 = [sample.subarray(0, 12).toString('base64'), sample.subarray(1, 13).toString('base64')];
const PCM_DEC = String(PCM_WORD); // 19281

function checks(e: Evidence): Record<string, boolean> {
  const out = e.output.toLowerCase();
  return {
    identicalSnapshots: JSON.stringify(e.before) === JSON.stringify(e.after),
    noWriteSpyCall: e.writeCalls.length === 0,
    noMarker: !out.includes(STT_MARKER) && !out.includes(TTS_MARKER),
    noPcmHex: !PCM_HEX.some((h) => out.includes(h)),
    noPcmBase64: !PCM_B64.some((b) => e.output.includes(b.slice(0, 12))),
    noPcmDecimal: !out.includes(PCM_DEC),
  };
}

test('a full session (hello, listen, 50 frames, end, speak, cancel, a second listen closed mid-utterance, a throwing engine whose message holds "zebrapeanut71") reaches transcript and audio_end, then: identical snapshots, no write spy call, neither marker nor the PCM as hex/base64/decimal in captured output', async () => {
  const e = await runSession(engines());
  expect({ transcript: e.transcript, audioEnd: e.audioEnd, failedStt: e.failedStt, failedTts: e.failedTts }).toEqual({
    transcript: true,
    audioEnd: true,
    failedStt: true,
    failedTts: true,
  });
  // The logger did run (so output was captured), with numbers and enums only.
  expect(e.output).toContain('"kind":"stt_done"');
  expect(e.output).toContain('"kind":"engine_error"');
  expect(e.after).toEqual(e.before);
  expect(e.writeCalls).toEqual([]);
  expect(checks(e)).toEqual({ identicalSnapshots: true, noWriteSpyCall: true, noMarker: true, noPcmHex: true, noPcmBase64: true, noPcmDecimal: true });
});

test('positive control: the same run with a deliberately leaking fake (writes the PCM to TMPDIR and logs the transcript) FAILS each assertion', async () => {
  const e = await runSession(leakingEngines());
  // The flow still reaches the same places, so the failures below are the leak's alone.
  expect([e.transcript, e.audioEnd, e.failedStt, e.failedTts]).toEqual([true, true, true, true]);
  expect(e.after[0]).toHaveProperty('utterance.pcm');
  expect(checks(e)).toEqual({ identicalSnapshots: false, noWriteSpyCall: false, noMarker: false, noPcmHex: false, noPcmBase64: false, noPcmDecimal: false });
});
