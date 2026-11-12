// M7 Step 3: the operator latency benchmark (spec §12, Ruling 3). Run on the target box, never in CI:
//
//   npm run bench -w @kitchenquest/voice -- --api https://<api host> --box ccx33-fsn1 --cpu "<model, vCPUs>" \
//     --llm qwen/qwen3.8-27b --providers tenstorrent [--gpu "<model>"] [--recordings <dir> --consent <record>] \
//     [--manual chromium:pass,safari:pass,firefox:fail]
//
// It needs a running API (AI on, a throwaway database, a synthetic player: BENCH_API_COOKIE, and BENCH_ORIGIN for the
// API's Origin check) and a voice service with real engines (VOICE_PORT, VOICE_HOST, VOICE_SERVICE_TOKEN and the
// VOICE_* model variables, as the service itself reads them). The voice route and the transcript turn arrive in
// Steps 5–6, so this cannot be exercised before them; Step 7 adds `--selftest` against fake engines (P15).
//
// What it does:
// 1. Utterances: the spike's ten phrases and ten openers (phrases.ts), spoken by the configured voice through the
//    voice service, resampled to 16 kHz and mixed with clean, 15 dB and 5 dB kitchen-like noise. Or, with
//    --recordings, the operator's 16 kHz mono 16-bit WAV files, each with a <name>.txt reference (C8: volunteers only,
//    a written consent record named by --consent; read in place, never copied, and deleted by the operator after).
// 2. WER: every utterance is transcribed by the voice service directly, with and without the vocabulary hint.
// 3. The round, per utterance, through the API as a device does: the audio streamed at real time, `end`, the
//    transcript turn (the heard card confirmed so the turn proceeds), then the reply spoken. If the reply is not back
//    FILLER_AFTER_MS after the end of speech, the filler line is spoken first, as the device does.
// 4. Timings in ms from the end of speech: firstAudio (filler or reply, whichever is first), replyAudio (the gated
//    number), stt (to the transcript), turn (transcript to the turn's answer), ttsFirst (speak to its first frame).
// 5. Output: bench/results/<date>-<box>.json, copied to bench/latest.json, which production boots against.
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
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
import { loadVoiceConfig } from '../src/config.js';
import { loadManifest } from '../src/models.js';
import { HINT, NOISE_LEVELS, OPENERS, SPIKE_PHRASES, TERMS, type NoiseLevel } from './phrases.js';
import { meetsTarget, parseBenchRun, TIMINGS, type BenchRun } from './schema.js';
import { corpusWer, percentile, termRecall } from './stats.js';

const BENCH = fileURLToPath(new URL('./', import.meta.url));
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
  const items = reply.parts.flatMap((p, part) => (p.kind === 'line' || p.kind === 'text' ? [{ kind: 'reply', replyId: reply.replyId, part }] : [])).slice(0, 8);
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

// --- main ----------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      api: { type: 'string' },
      box: { type: 'string' },
      cpu: { type: 'string' },
      gpu: { type: 'string' },
      llm: { type: 'string' },
      providers: { type: 'string' },
      recordings: { type: 'string' },
      consent: { type: 'string' },
      manual: { type: 'string' },
    },
  });
  const need = (k: keyof typeof values): string => {
    const v = values[k];
    if (typeof v !== 'string' || v === '') throw new Error(`bench: --${k} is required`);
    return v;
  };
  const api = need('api').replace(/\/$/, '');
  const cookie = process.env.BENCH_API_COOKIE ?? '';
  const origin = process.env.BENCH_ORIGIN ?? '';
  if (cookie === '' || origin === '') throw new Error('bench: BENCH_API_COOKIE (the synthetic player) and BENCH_ORIGIN are required');
  if (values.recordings !== undefined && !values.consent) throw new Error('bench: --recordings needs --consent naming the written consent record (C8)');

  const config = loadVoiceConfig(process.env, loadManifest());
  const svc = await voiceService(config.host, config.port, config.token.toString('utf8'));
  const date = new Date().toISOString().slice(0, 10);

  // 1. Utterances, in memory only.
  const rand = prng(20261109);
  const utterances: Utterance[] = [];
  if (values.recordings !== undefined) {
    const dir = values.recordings;
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()) {
      const text = readFileSync(join(dir, name.replace(/\.wav$/, '.txt')), 'utf8').trim();
      utterances.push({ text, noise: 'clean', pcm: readWav(join(dir, name)) });
    }
  } else {
    for (const text of [...SPIKE_PHRASES, ...OPENERS]) {
      const clean = await synthesize(svc, text);
      for (const level of NOISE_LEVELS) utterances.push({ text, noise: level, pcm: mix(clean, level, rand) });
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
  const device = new Channel(await open(`${apiWs}/voice`, { cookie, origin }), parseServerMsg);
  device.ws.send(JSON.stringify({ t: 'hello', v: 1, conversationId: null, localDate: date, familyTable: false }));
  await device.next((x) => (x.kind === 'msg' && x.msg.t === 'ready' ? true : undefined));
  const rounds: Round[] = [];
  for (const u of utterances) {
    rounds.push(await round(device, u, { api, cookie, origin, localDate: date }));
    u.pcm.fill(0);
  }
  device.ws.close();
  svc.ch.ws.close();

  const pct = (k: keyof Round) => {
    const xs = rounds.map((r) => Math.round(r[k]));
    return { p50: percentile(xs, 50), p90: percentile(xs, 90), p95: percentile(xs, 95) };
  };
  const ms = Object.fromEntries(TIMINGS.map((k) => [k, pct(k)])) as BenchRun['ms'];
  const manual = values.manual?.split(',').map((e) => {
    const [browser, result] = e.split(':');
    return { browser, echoBargeInPass: result === 'pass' };
  });
  const run = parseBenchRun({
    date,
    box: need('box'),
    cpu: need('cpu'),
    gpu: values.gpu ?? null,
    stack: { stt: config.sttModel, tts: config.cast.model, voice: config.cast.voice, llm: need('llm'), providers: need('providers').split(',') },
    utterances: {
      source: values.recordings === undefined ? 'synthetic' : 'recorded',
      n: utterances.length,
      noise: [...new Set(utterances.map((u) => u.noise))],
      consentRecord: values.consent ?? null,
    },
    ms,
    wer: { hinted: round3(corpusWer(hinted)), unhinted: round3(corpusWer(unhinted)) },
    termRecall: { hinted: round3(termRecall(hinted, TERMS)), unhinted: round3(termRecall(unhinted, TERMS)) },
    meetsTarget: meetsTarget(ms),
    ...(manual ? { manual } : {}),
  });
  const file = join(BENCH, 'results', `${run.date}-${run.box}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  copyFileSync(file, join(BENCH, 'latest.json'));
  process.stdout.write(`${JSON.stringify({ file, meetsTarget: run.meetsTarget, replyAudio: run.ms.replyAudio, firstAudio: run.ms.firstAudio, wer: run.wer })}\n`);
  if (values.recordings !== undefined) process.stdout.write('Delete the recordings now (C8): they were read in place and never copied.\n');
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : 'bench failed'}\n`);
  process.exit(1);
});
