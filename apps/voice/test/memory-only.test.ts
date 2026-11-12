// M7 C-18: "Audio is processed in memory and never stored": no disk, no logging of audio or transcripts. A full session
// runs against the real server, then the service's filesystem and output are checked. D1: the same run with a
// deliberately leaking fake must fail every check, so a check that can never fail cannot pass here.
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
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
  syncFailedStt: boolean;
  badFrameClosed: boolean;
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
  process.chdir(dirs[2]);
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
    const orig = target[name];
    const spy = vi.spyOn(target, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      writeCalls.push(`fs.${name}`);
      return orig.apply(this, args);
    });
    restores.push(() => spy.mockRestore());
  }
  for (const name of ['open', 'openSync'] as const) {
    const orig = target[name];
    const spy = vi.spyOn(target, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (forWrite(args[1])) writeCalls.push(`fs.${name}`);
      return orig.apply(this, args);
    });
    restores.push(() => spy.mockRestore());
  }
  const promises = fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ['writeFile', 'appendFile', 'cp', 'copyFile', 'mkdtemp', 'open'] as const) {
    const orig = promises[name];
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
    // util.format, as console itself formats: a Buffer arrives as `<Buffer 51 4b …>`, not as its UTF-8 text.
    const spy = vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void capture(`${format(...args)}\n`));
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

const HINT = ['sesame', 'kiwi-hint-8'];

/**
 * Honest fakes, with markers in every error message. Hint `boom`: the STT rejects. Hint `sync`: the STT throws
 * synchronously, before returning a promise (review I1), with the PCM as hex in the message. Text `boom …`: the TTS
 * throws.
 */
function engines(leak: (ctx: LeakContext) => void = () => {}): { stt: SttEngine; tts: TtsEngine } {
  const base = fakeStt(() => STT_MARKER);
  const tts = fakeTts();
  return {
    stt: {
      model: base.model,
      transcribe: (pcm, hint, signal) => {
        if (hint.includes('sync')) throw new Error(`stt threw on ${STT_MARKER} ${pcmBytes(pcm).toString('hex')}`);
        if (hint.includes('boom')) return Promise.reject(new Error(`stt crashed on ${STT_MARKER} ${pcmBytes(pcm).toString('hex')}`));
        return base.transcribe(pcm, hint, signal).then((text) => {
          if (hint.length > 0) leak({ pcm, bytes: pcmBytes(pcm), hint, text });
          return text;
        });
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

interface LeakContext {
  pcm: Int16Array;
  bytes: Buffer;
  hint: readonly string[];
  text: string;
}

/**
 * The positive controls (D1, review I2): each leaks in one format, and the named checks must then fail. Together they
 * cover the formats Node itself produces for audio: inspect of a Buffer, a Uint8Array and an Int16Array, a Buffer's
 * JSON, hex and base64, and the hint words and transcript.
 */
const LEAKS: Record<string, { leak: (c: LeakContext) => void; fails: string[] }> = {
  'a file in TMPDIR': { leak: (c) => writeFileSync(join(tmpdir(), 'utterance.pcm'), c.bytes), fails: ['identicalSnapshots', 'noWriteSpyCall'] },
  'the transcript': { leak: (c) => console.log(`heard: ${c.text}`), fails: ['noMarker'] },
  'the hint words': { leak: (c) => console.info('hint', c.hint), fails: ['noHint'] },
  'console.log(Buffer)': { leak: (c) => console.log(c.bytes.subarray(0, 32)), fails: ['noPcmSpacedHex'] },
  'console.log(Uint8Array)': { leak: (c) => console.warn(new Uint8Array(c.bytes.subarray(0, 32))), fails: ['noPcmBytes'] },
  'JSON.stringify(Buffer)': { leak: (c) => void process.stderr.write(JSON.stringify({ frame: c.bytes.subarray(0, 16) })), fails: ['noBufferJson', 'noPcmBytes'] },
  'hex': { leak: (c) => void process.stderr.write(c.bytes.subarray(0, 16).toString('hex')), fails: ['noPcmHex'] },
  'base64': { leak: (c) => void process.stdout.write(c.bytes.subarray(1, 25).toString('base64')), fails: ['noPcmBase64'] },
  'console.log(Int16Array)': { leak: (c) => console.error(c.pcm.subarray(0, 4)), fails: ['noPcmDecimal'] },
};

const leakAll = (c: LeakContext) => {
  for (const { leak } of Object.values(LEAKS)) leak(c);
};

// --- one full session ------------------------------------------------------------------------------------------------

async function waitFor(c: Client, pred: (m: UpstreamServerMsg) => boolean): Promise<UpstreamServerMsg> {
  for (;;) {
    const r = await c.next();
    if (r.kind === 'msg' && pred(r.msg)) return r.msg;
  }
}

const hasId = (id: number) => (m: UpstreamServerMsg) => 'id' in m && m.id === id;

async function runSession(e: { stt: SttEngine; tts: TtsEngine }): Promise<Evidence> {
  const before = dirs.map((d) => snapshot(d));
  const nets = installNets();
  const ev = { transcript: false, audioEnd: false, failedStt: false, failedTts: false, syncFailedStt: false, badFrameClosed: false };
  try {
    // The real logger, writing to the real (captured) stdout.
    const server = createVoiceServer({ config: testConfig(), stt: e.stt, tts: e.tts, log: createLogger() });
    const port = await server.listen(0);

    const a = await connect(port);
    a.send({ t: 'hello', v: 1 });
    await waitFor(a, (m) => m.t === 'ready');
    a.send({ t: 'listen', id: 1, hint: HINT });
    for (let i = 0; i < 50; i++) a.send(encodeFrame(1, pcmFrame()));
    a.send({ t: 'end', id: 1 });
    const t = await waitFor(a, (m) => m.t !== 'ready');
    ev.transcript = t.t === 'transcript' && t.text === STT_MARKER;
    a.send({ t: 'speak', id: 2, voice: 'pan', chunks: [{ text: TTS_MARKER, cache: false }] });
    ev.audioEnd = (await waitFor(a, hasId(2))).t === 'audio_end';
    // speak, then cancel mid-chunk
    a.send({ t: 'speak', id: 3, voice: 'pan', chunks: [{ text: Array.from({ length: 30 }, () => TTS_MARKER).join(' '), cache: true }] });
    for (;;) if ((await a.next()).kind === 'frame') break;
    a.send({ t: 'cancel', id: 3 });
    // a second listen, closed mid-utterance
    a.send({ t: 'listen', id: 4, hint: [] });
    for (let i = 0; i < 10; i++) a.send(encodeFrame(4, pcmFrame()));
    a.ws.terminate();
    await a.closed;

    // the throwing engines, with markers in their messages: rejecting, throwing synchronously (I1), and the TTS
    const b = await connect(port);
    b.send({ t: 'hello', v: 1 });
    await waitFor(b, (m) => m.t === 'ready');
    b.send({ t: 'listen', id: 5, hint: ['boom'] });
    for (let i = 0; i < 5; i++) b.send(encodeFrame(5, pcmFrame()));
    b.send({ t: 'end', id: 5 });
    const f = await waitFor(b, hasId(5));
    ev.failedStt = f.t === 'failed' && f.kind === 'stt';
    b.send({ t: 'listen', id: 7, hint: ['sync'] });
    for (let i = 0; i < 5; i++) b.send(encodeFrame(7, pcmFrame()));
    b.send({ t: 'end', id: 7 });
    const s7 = await waitFor(b, hasId(7));
    ev.syncFailedStt = s7.t === 'failed' && s7.kind === 'stt';
    b.send({ t: 'speak', id: 6, voice: 'pan', chunks: [{ text: `boom ${TTS_MARKER}`, cache: false }] });
    const g = await waitFor(b, hasId(6));
    ev.failedTts = g.t === 'failed' && g.kind === 'tts';
    b.ws.close();
    await b.closed;

    // an undecodable frame mid-utterance: bad_message, closed, with audio buffered
    const c = await connect(port);
    c.send({ t: 'hello', v: 1 });
    await waitFor(c, (m) => m.t === 'ready');
    c.send({ t: 'listen', id: 8, hint: [] });
    for (let i = 0; i < 5; i++) c.send(encodeFrame(8, pcmFrame()));
    c.send(new Uint8Array([0, 0, 0, 8, 0x51]));
    ev.badFrameClosed = (await c.closed) === 4400;
    await server.close();
  } finally {
    nets.restore();
  }
  return { ...ev, before, after: dirs.map((d) => snapshot(d)), writeCalls: nets.writeCalls, output: nets.output.join('') };
}

// --- the checks ------------------------------------------------------------------------------------------------------

const sample = pcmBytes(new Int16Array(16).fill(PCM_WORD));
const PCM_HEX = [sample.subarray(0, 8).toString('hex'), sample.subarray(1, 9).toString('hex')];
const PCM_SPACED_HEX = /(51 4b 51 4b|4b 51 4b 51)/;
/** The bytes as decimals, as inspect of a Uint8Array and a Buffer's JSON print them: 81, 75, 81, 75 (any spacing). */
const PCM_BYTES = /(81,\s*75,\s*81,\s*75|75,\s*81,\s*75,\s*81)/;
const PCM_B64 = [sample.subarray(0, 12).toString('base64'), sample.subarray(1, 13).toString('base64')];
const PCM_DEC = String(PCM_WORD); // 19281, as inspect of an Int16Array prints it

function checks(e: Evidence): Record<string, boolean> {
  const out = e.output.toLowerCase();
  return {
    identicalSnapshots: JSON.stringify(e.before) === JSON.stringify(e.after),
    noWriteSpyCall: e.writeCalls.length === 0,
    noMarker: !out.includes(STT_MARKER) && !out.includes(TTS_MARKER),
    noHint: !HINT.some((w) => out.includes(w)),
    noPcmHex: !PCM_HEX.some((h) => out.includes(h)),
    noPcmSpacedHex: !PCM_SPACED_HEX.test(out),
    noPcmBytes: !PCM_BYTES.test(out),
    noBufferJson: !out.includes('"type":"buffer"'),
    noPcmBase64: !PCM_B64.some((b) => e.output.includes(b.slice(0, 12))),
    noPcmDecimal: !out.includes(PCM_DEC),
  };
}
const ALL_PASS = Object.fromEntries(Object.keys(checks({ before: [], after: [], writeCalls: [], output: '' } as unknown as Evidence)).map((k) => [k, true]));

const flow = (e: Evidence) => [e.transcript, e.audioEnd, e.failedStt, e.failedTts, e.syncFailedStt, e.badFrameClosed];

test('a full session (hello, listen, 50 frames, end, speak, cancel, a second listen closed mid-utterance, a throwing engine whose message holds "zebrapeanut71") reaches transcript and audio_end, then: identical snapshots, no write spy call, neither marker nor the PCM as hex/base64/decimal in captured output', async () => {
  const e = await runSession(engines());
  expect(flow(e)).toEqual([true, true, true, true, true, true]);
  // The logger did run (so output was captured), with numbers and enums only.
  expect(e.output).toContain('"kind":"stt_done"');
  expect(e.output).toContain('"kind":"engine_error"');
  expect(e.output).toContain('"kind":"bad_message"');
  expect(e.after).toEqual(e.before);
  expect(e.writeCalls).toEqual([]);
  expect(checks(e)).toEqual(ALL_PASS);
});

test('positive control: the same run with a deliberately leaking fake (writes the PCM to TMPDIR and logs the transcript) FAILS each assertion', async () => {
  const e = await runSession(engines(leakAll));
  // The flow still reaches the same places, so the failures below are the leak's alone.
  expect(flow(e)).toEqual([true, true, true, true, true, true]);
  expect(e.after[0]).toHaveProperty('utterance.pcm');
  expect(checks(e)).toEqual(Object.fromEntries(Object.keys(ALL_PASS).map((k) => [k, false])));
});

test.each(Object.entries(LEAKS))('positive control, one format at a time (review I2): a leak of %s fails its check', async (_name, { leak, fails }) => {
  const e = await runSession(engines(leak));
  expect(flow(e)).toEqual([true, true, true, true, true, true]);
  const got = checks(e);
  for (const k of fails) expect(got[k], k).toBe(false);
});
