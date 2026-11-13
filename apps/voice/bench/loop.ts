// M7 Step 3, split out in Step 7 (P15): the benchmark loop itself, shared by the operator run (`run.ts`) and the
// self-test (`selftest.ts`, `--selftest`), so the self-test exercises exactly the code an operator run uses.
//
// What it assumes about the API, pinned by the self-test's stub API (selftest.ts) against core's own parsers:
// - the device socket is `GET <api>/voice`, a WebSocket that needs the session cookie (`cookie: kq_session=<token>`,
//   BENCH_API_COOKIE) and the game's Origin (BENCH_ORIGIN) on the upgrade, or it is closed `signed_out` / `bad_origin`;
// - every message the bench sends is a core `ClientMsg` (`parseClientMsg`): `hello` with the player's clock
//   (`localDate` and `localTime`, M7 Step 5 carry 4), `listen` / frames / `end`, and `speak` whose items carry no text
//   and no variables (Ruling 15): the filler `line`, and `reply` items naming only the reply's own `line` parts;
// - the transcript turn is `POST <api>/mentor/turn` with the same cookie, `input: { kind: 'transcript' }` (core
//   `parseTurnInput`); a turn naming a food answers with its heard card (Ruling 4) and no replyId to speak, and the
//   same text with `heard.words` equal to the card's heard words, in order, is answered as the typed words would be.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeFrame,
  encodeFrame,
  FILLER_AFTER_MS,
  fillerFor,
  FRAME_MS,
  parseServerMsg,
  parseUpstreamServerMsg,
  SAMPLE_RATE_IN,
  type ReplyPart,
  type ServerMsg,
  type TurnResponse,
  type UpstreamServerMsg,
} from '@kitchenquest/core';
import WebSocket from 'ws';
import { HINT, NOISE_LEVELS, OPENERS, SPIKE_PHRASES, TERMS, type NoiseLevel } from './phrases.js';
import { meetsTarget, parseBenchRun, TIMINGS, type BenchRun } from './schema.js';
import { corpusWer, percentile, termRecall } from './stats.js';

const FRAME = (SAMPLE_RATE_IN * FRAME_MS) / 1000;
const TIMEOUT_MS = 30_000;

interface Utterance {
  text: string;
  noise: NoiseLevel;
  pcm: Int16Array; // 16 kHz mono, in memory only
}

// --- a small message queue over one WebSocket --------------------------------------------------------------------------

class Channel<M> {
  private readonly items: ({ kind: 'msg'; msg: M } | { kind: 'frame'; id: number; at: number })[] = [];
  private wake: (() => void) | null = null;
  /** Frames collected per id, for ids registered with collect(). */
  readonly frames = new Map<number, Int16Array[]>();
  constructor(
    readonly ws: WebSocket,
    parse: (x: unknown) => M | null,
  ) {
    ws.on('message', (data: Buffer, binary: boolean) => {
      if (binary) {
        const f = decodeFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        if (f) {
          this.items.push({ kind: 'frame', id: f.id, at: performance.now() });
          this.frames.get(f.id)?.push(f.pcm);
        }
      } else {
        const msg = parse(JSON.parse(data.toString('utf8')) as unknown);
        if (msg === null) throw new Error('bench: a message the protocol refuses');
        this.items.push({ kind: 'msg', msg });
      }
      this.wake?.();
    });
  }
  collect(id: number): Int16Array[] {
    const list: Int16Array[] = [];
    this.frames.set(id, list);
    return list;
  }
  async next<T>(pick: (x: { kind: 'msg'; msg: M } | { kind: 'frame'; id: number; at: number }) => T | undefined, timeoutMs = TIMEOUT_MS): Promise<T> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      while (this.items.length > 0) {
        const got = pick(this.items.shift()!);
        if (got !== undefined) return got;
      }
      if (performance.now() > deadline) throw new Error('bench: timed out waiting for the server');
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 50);
      });
    }
  }
}

function open(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// --- audio: resampling, noise, WAV -------------------------------------------------------------------------------------

function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm.slice();
  const n = Math.floor((pcm.length * to) / from);
  const out = new Int16Array(n);
  for (let k = 0; k < n; k++) {
    const x = (k * from) / to;
    const j = Math.floor(x);
    const f = x - j;
    out[k] = Math.round((pcm[j] ?? 0) * (1 - f) + (pcm[j + 1] ?? 0) * f);
  }
  return out;
}

/** A seeded PRNG (mulberry32), so every run mixes the same noise. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The spike's kitchen: pink-ish hiss (white noise through a leaky integrator) plus clatter bursts, about three a second. */
function kitchenNoise(n: number, rand: () => number): Float64Array {
  const out = new Float64Array(n);
  let pink = 0;
  for (let i = 0; i < n; i++) {
    pink = 0.97 * pink + 0.03 * (rand() * 2 - 1) * 4;
    out[i] = pink;
  }
  const bursts = Math.floor((n / SAMPLE_RATE_IN) * 3);
  for (let b = 0; b < bursts; b++) {
    const at = Math.floor(rand() * Math.max(1, n - 800));
    for (let i = 0; i < 800 && at + i < n; i++) out[at + i] += (rand() * 2 - 1) * Math.exp(-i / 150) * 0.6;
  }
  return out;
}

const rms = (xs: ArrayLike<number>) => Math.sqrt(Array.from(xs).reduce((s, x) => s + x * x, 0) / Math.max(1, xs.length));

function mix(pcm: Int16Array, level: NoiseLevel, rand: () => number): Int16Array {
  if (level === 'clean') return pcm.slice();
  const snr = level === '15dB' ? 15 : 5;
  const noise = kitchenNoise(pcm.length, rand);
  const scale = rms(pcm) / (rms(noise) * 10 ** (snr / 20));
  return Int16Array.from(pcm, (s, i) => Math.max(-32768, Math.min(32767, Math.round(s + noise[i] * scale))));
}

/** A 16 kHz mono 16-bit PCM WAV, or a refusal naming the file. */
function readWav(file: string): Int16Array {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV file`);
  let at = 12;
  let fmt: { channels: number; rate: number; bits: number; format: number } | null = null;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(at + 8), channels: b.readUInt16LE(at + 10), rate: b.readUInt32LE(at + 12), bits: b.readUInt16LE(at + 22) };
    if (id === 'data') {
      if (fmt === null || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== SAMPLE_RATE_IN || fmt.bits !== 16) throw new Error(`${file}: needs 16 kHz mono 16-bit PCM`);
      const pcm = new Int16Array(size / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = b.readInt16LE(at + 8 + i * 2);
      b.fill(0);
      return pcm;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

// --- the voice service (synthesis and the WER pass) --------------------------------------------------------------------

async function voiceService(host: string, port: number, token: string): Promise<{ ch: Channel<UpstreamServerMsg>; rate: number; stt: string; tts: string }> {
  const ws = await open(`ws://${host.includes(':') ? `[${host}]` : host}:${port}/`, { authorization: `Bearer ${token}` });
  const ch = new Channel(ws, parseUpstreamServerMsg);
  ws.send(JSON.stringify({ t: 'hello', v: 1 }));
  const ready = await ch.next((x) => (x.kind === 'msg' && x.msg.t === 'ready' ? x.msg : undefined));
  return { ch, rate: ready.sampleRate, stt: ready.stt, tts: ready.tts };
}

let nextId = 1;

async function synthesize(svc: Awaited<ReturnType<typeof voiceService>>, text: string): Promise<Int16Array> {
  const id = nextId++;
  const frames = svc.ch.collect(id);
  svc.ch.ws.send(JSON.stringify({ t: 'speak', id, voice: 'pan', chunks: [{ text, cache: false }] }));
  await svc.ch.next((x) => (x.kind === 'msg' && 'id' in x.msg && x.msg.id === id ? x.msg : undefined));
  svc.ch.frames.delete(id);
  const all = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    all.set(f, at);
    at += f.length;
  }
  return resample(all, svc.rate, SAMPLE_RATE_IN);
}

async function transcribe(svc: Awaited<ReturnType<typeof voiceService>>, pcm: Int16Array, hint: readonly string[]): Promise<string> {
  const id = nextId++;
  svc.ch.ws.send(JSON.stringify({ t: 'listen', id, hint }));
  for (let i = 0; i < pcm.length; i += FRAME) svc.ch.ws.send(encodeFrame(id, pcm.subarray(i, i + FRAME)));
  svc.ch.ws.send(JSON.stringify({ t: 'end', id }));
  const m = await svc.ch.next((x) => (x.kind === 'msg' && 'id' in x.msg && x.msg.id === id ? x.msg : undefined));
  return m.t === 'transcript' ? m.text : '';
}

// --- the round through the API -----------------------------------------------------------------------------------------

interface Round {
  firstAudio: number;
  replyAudio: number;
  stt: number;
  turn: number;
  ttsFirst: number;
}

async function turn(api: string, cookie: string, origin: string, text: string, localDate: string): Promise<TurnResponse> {
  const post = async (heard?: string[]): Promise<TurnResponse> => {
    const res = await fetch(`${api}/mentor/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({
        conversationId: null,
        input: { kind: 'transcript', text, ...(heard ? { heard: { words: heard } } : {}) },
        localDate,
        localTime: '18:30',
        screen: null,
        intakeStep: null,
      }),
    });
    if (!res.ok) throw new Error(`bench: the turn answered ${res.status}`);
    return (await res.json()) as TurnResponse;
  };
  const first = await post();
  // Ruling 4: a heard card stops the turn until it is confirmed by tap; the benchmark confirms exactly its words.
  const heard = first.parts.find((p): p is Extract<ReplyPart, { kind: 'heard' }> => p.kind === 'heard');
  return heard ? post(heard.check.terms.map((t) => t.heard)) : first;
}

async function round(device: Channel<ServerMsg>, u: Utterance, opts: { api: string; cookie: string; origin: string; localDate: string }): Promise<Round> {
  const id = nextId++;
  device.ws.send(JSON.stringify({ t: 'listen', id, mode: 'hold' }));
  const started = performance.now();
  for (let i = 0, k = 0; i < u.pcm.length; i += FRAME, k++) {
    const due = started + k * FRAME_MS;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    device.ws.send(encodeFrame(id, u.pcm.subarray(i, i + FRAME)));
  }
  device.ws.send(JSON.stringify({ t: 'end', id }));
  const end = performance.now();
  const transcript = await device.next((x) => (x.kind === 'msg' && x.msg.t === 'transcript' && x.msg.id === id ? x.msg.text : undefined));
  const sttAt = performance.now();

  // The filler, as the device speaks it: FILLER_AFTER_MS after the end of speech, if the reply is not back.
  const fillerSpeak: { id: number | null } = { id: null };
  const filler = setTimeout(
    () => {
      fillerSpeak.id = nextId++;
      device.ws.send(JSON.stringify({ t: 'speak', id: fillerSpeak.id, items: [{ kind: 'line', trigger: fillerFor(transcript), index: 0 }] }));
    },
    Math.max(0, FILLER_AFTER_MS - (sttAt - end)),
  );
  const reply = await turn(opts.api, opts.cookie, opts.origin, transcript, opts.localDate);
  clearTimeout(filler);
  const turnAt = performance.now();

  const replySpeak = nextId++;
  // Ruling 15 / R9: only the reply's own written lines are spoken, by index; the model's text never is.
  const items = reply.parts.flatMap((p, part) => (p.kind === 'line' ? [{ kind: 'reply', replyId: reply.replyId, part }] : [])).slice(0, 8);
  if (items.length === 0) throw new Error('bench: the reply has nothing to speak');
  device.ws.send(JSON.stringify({ t: 'speak', id: replySpeak, items }));
  const speakAt = performance.now();
  let firstAudio: number | null = null;
  let replyAudio: number | null = null;
  while (replyAudio === null) {
    const f = await device.next((x) => (x.kind === 'frame' ? x : undefined));
    if (firstAudio === null && (f.id === replySpeak || f.id === fillerSpeak.id)) firstAudio = f.at - end;
    if (f.id === replySpeak) replyAudio = f.at - end;
  }
  await device.next((x) => (x.kind === 'msg' && x.msg.t === 'audio_end' && x.msg.id === replySpeak ? true : undefined));
  return { firstAudio: firstAudio ?? replyAudio, replyAudio, stt: sttAt - end, turn: turnAt - sttAt, ttsFirst: replyAudio + end - speakAt };
}

// --- the whole run ------------------------------------------------------------------------------------------------------

export interface BenchOptions {
  /** The API base URL (`https://<api host>`), no trailing slash needed. */
  api: string;
  /** The whole Cookie header for the synthetic player: `kq_session=<token>` (BENCH_API_COOKIE). */
  cookie: string;
  /** The game's origin, as a browser sends it (BENCH_ORIGIN). */
  origin: string;
  /** The voice service, reached directly with its bearer token (the WER pass and the synthesis). */
  voice: { host: string; port: number; token: string };
  stack: BenchRun['stack'];
  box: string;
  cpu: string;
  gpu: string | null;
  /** The phrases to synthesize (default: the spike's ten and the ten openers) and the noise levels (default: all). */
  texts?: readonly string[];
  noise?: readonly NoiseLevel[];
  /** The operator's recordings directory and its written consent record (C8). */
  recordings?: { dir: string; consent: string };
  manual?: BenchRun['manual'];
  /** The player's local date (YYYY-MM-DD) and time (HH:MM) for the hello and the turns. */
  localDate: string;
  localTime: string;
}

/** The benchmark, once: utterances, WER, the rounds through the API; a run `parseBenchRun` accepts. Writes nothing. */
export async function runBench(o: BenchOptions): Promise<BenchRun> {
  const api = o.api.replace(/\/$/, '');
  const svc = await voiceService(o.voice.host, o.voice.port, o.voice.token);
  const rand = prng(20261109);
  const utterances: Utterance[] = [];
  try {
    // 1. Utterances, in memory only.
    if (o.recordings !== undefined) {
      const dir = o.recordings.dir;
      for (const name of readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()) {
        const text = readFileSync(join(dir, name.replace(/\.wav$/, '.txt')), 'utf8').trim();
        utterances.push({ text, noise: 'clean', pcm: readWav(join(dir, name)) });
      }
    } else {
      for (const text of o.texts ?? [...SPIKE_PHRASES, ...OPENERS]) {
        const clean = await synthesize(svc, text);
        for (const level of o.noise ?? NOISE_LEVELS) utterances.push({ text, noise: level, pcm: mix(clean, level, rand) });
        clean.fill(0);
      }
    }
    if (utterances.length === 0) throw new Error('bench: no utterances');

    // 2. WER, hinted and not, straight from the voice service.
    const hinted: [string, string][] = [];
    const unhinted: [string, string][] = [];
    for (const u of utterances) {
      hinted.push([u.text, await transcribe(svc, u.pcm, HINT)]);
      unhinted.push([u.text, await transcribe(svc, u.pcm, [])]);
    }

    // 3. The rounds through the API, as a device.
    const apiWs = api.replace(/^http/, 'ws');
    const device = new Channel(await open(`${apiWs}/voice`, { cookie: o.cookie, origin: o.origin }), parseServerMsg);
    const rounds: Round[] = [];
    try {
      device.ws.send(JSON.stringify({ t: 'hello', v: 1, conversationId: null, localDate: o.localDate, localTime: o.localTime, familyTable: false }));
      await device.next((x) => (x.kind === 'msg' && x.msg.t === 'ready' ? true : x.kind === 'msg' && x.msg.t === 'closed' ? fail(`the API closed the voice socket: ${x.msg.reason}`) : undefined));
      for (const u of utterances) {
        rounds.push(await round(device, u, { api, cookie: o.cookie, origin: o.origin, localDate: o.localDate }));
        u.pcm.fill(0);
      }
    } finally {
      device.ws.close();
    }

    const pct = (k: keyof Round) => {
      const xs = rounds.map((r) => Math.round(r[k]));
      return { p50: percentile(xs, 50), p90: percentile(xs, 90), p95: percentile(xs, 95) };
    };
    const ms = Object.fromEntries(TIMINGS.map((k) => [k, pct(k)])) as BenchRun['ms'];
    return parseBenchRun({
      date: o.localDate,
      box: o.box,
      cpu: o.cpu,
      gpu: o.gpu,
      stack: o.stack,
      utterances: {
        source: o.recordings === undefined ? 'synthetic' : 'recorded',
        n: utterances.length,
        noise: [...new Set(utterances.map((u) => u.noise))],
        consentRecord: o.recordings?.consent ?? null,
      },
      ms,
      wer: { hinted: round3(corpusWer(hinted)), unhinted: round3(corpusWer(unhinted)) },
      termRecall: { hinted: round3(termRecall(hinted, TERMS)), unhinted: round3(termRecall(unhinted, TERMS)) },
      meetsTarget: meetsTarget(ms),
      ...(o.manual ? { manual: o.manual } : {}),
    });
  } finally {
    for (const u of utterances) u.pcm.fill(0);
    svc.ch.ws.close();
  }
}

function fail(why: string): never {
  throw new Error(`bench: ${why}`);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
