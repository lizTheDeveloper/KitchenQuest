// M7 Step 7 (P15): the benchmark's self-test. The whole loop (loop.ts `runBench`) runs once, for one utterance, against
// the real voice service on fake engines and a stub API on loopback. No network, no model, no GPU, and nothing is
// written (bench/latest.json, which production boots against, is never touched). Nothing here imports apps/api.
//
// The stub API holds the bench to what the real API does (Steps 5–6), with core's own parsers:
// - `GET /voice` upgrades only with the game's Origin and the session cookie (`kq_session=<token>`), else it sends
//   `closed bad_origin` (4403) or `closed signed_out` (4401), as voice/routes.ts does; every message must parse as a
//   core `ClientMsg` (`hello` first, with `localDate` and `localTime`), else `closed bad_message` (4400);
// - a `speak` may name only a `line` filler or a `reply` part the API kept that is a written line (Ruling 15, R9);
// - `POST /mentor/turn` needs the cookie and a core transcript input (`parseTurnInput`); a turn naming a food is
//   answered with its heard card until `heard.words` confirm exactly the heard words (core `heardCheck`,
//   `heardConfirmed`), and only a confirmed turn's reply is kept to be spoken.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  decodeFrame,
  encodeFrame,
  heardCheck,
  heardConfirmed,
  heardLine,
  IngredientGraph,
  parseClientMsg,
  parseTurnInput,
  VOICE_CLOSE_CODES,
  type IngredientData,
  type ReplyPart,
  type RuleTerm,
  type ServerMsg,
  type TurnResponse,
  type VoiceCloseReason,
} from '@kitchenquest/core';
import { WebSocketServer, type WebSocket } from 'ws';
import type { VoiceConfig } from '../src/config.js';
import { fakeStt, fakeTts } from '../src/engines/fake.js';
import { createLogger } from '../src/log.js';
import { createVoiceServer } from '../src/server.js';
import { runBench } from './loop.js';
import type { BenchRun } from './schema.js';

const DATA = new URL('../../../data/', import.meta.url);
const SESSION = 'selftest-session-token-0123456789';
const ORIGIN = 'http://127.0.0.1:5173';
const VOICE_TOKEN = 'selftest-voice-token-0123456789-0123456789';
/** What the stub's STT "hears": a food, so the heard card is part of every round. */
export const SELFTEST_TRANSCRIPT = "i'm allergic to kiwi";

export interface StubApi {
  url: string;
  cookie: string;
  origin: string;
  /** Everything the bench did that the real API would refuse; the self-test fails on any. */
  problems: string[];
  close(): Promise<void>;
}

const json = (x: unknown) => JSON.stringify(x);
const hasCookie = (req: IncomingMessage) => (req.headers.cookie ?? '').split(/;\s*/).includes(`kq_session=${SESSION}`);

/** The stub API (HTTP + WebSocket) on a loopback port. */
export async function startStubApi(transcript: string = SELFTEST_TRANSCRIPT): Promise<StubApi> {
  const graph = IngredientGraph.fromData(JSON.parse(readFileSync(new URL('ingredients.json', DATA), 'utf8')) as IngredientData);
  const terms = JSON.parse(readFileSync(new URL('rule-terms.json', DATA), 'utf8')) as RuleTerm[];
  const problems: string[] = [];
  /** Replies the API keeps to be spoken (`recentReplies`): never a gated (heard-card) turn's. */
  const kept = new Map<string, ReplyPart[]>();

  const respond = (parts: ReplyPart[]): TurnResponse => ({ conversationId: randomUUID(), route: 'deterministic', parts, cards: [], actions: [], notice: null, toolTurn: false, replyId: randomUUID() });

  const http = createServer((req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(json(body));
    if (req.method !== 'POST' || req.url !== '/mentor/turn') return send(404, { error: { code: 'not_found' } });
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      if (!hasCookie(req)) {
        problems.push('POST /mentor/turn without the session cookie');
        return send(401, { error: { code: 'unauthorized' } });
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      const input = parseTurnInput(body.input);
      if (input?.kind !== 'transcript') {
        problems.push(`POST /mentor/turn without a transcript input: ${raw.slice(0, 200)}`);
        return send(400, { error: { code: 'bad_request' } });
      }
      const shaped =
        (body.conversationId === null || typeof body.conversationId === 'string') &&
        typeof body.localDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.localDate) &&
        typeof body.localTime === 'string' && /^\d{2}:\d{2}$/.test(body.localTime) &&
        body.screen === null && body.intakeStep === null;
      if (!shaped) {
        problems.push(`POST /mentor/turn with a body the API refuses: ${raw.slice(0, 200)}`);
        return send(400, { error: { code: 'bad_request' } });
      }
      const check = heardCheck(input.text, graph, terms);
      if (check !== null && !heardConfirmed(check, input.heard?.words)) {
        return send(200, respond([{ kind: 'heard', check }, { kind: 'line', line: heardLine(check) }]));
      }
      const r = respond([{ kind: 'line', line: { trigger: 'rule.readback', vars: {} } }, { kind: 'line', line: { trigger: 'mentor.check_card', vars: {} } }]);
      kept.set(r.replyId, r.parts);
      send(200, r);
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/voice') {
      problems.push(`a WebSocket to ${req.url ?? ''}, not /voice`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => device(ws, req));
  });

  function device(ws: WebSocket, req: IncomingMessage) {
    const sendMsg = (m: ServerMsg) => ws.send(json(m));
    const close = (reason: VoiceCloseReason, why: string) => {
      problems.push(why);
      sendMsg({ t: 'closed', reason });
      ws.close(VOICE_CLOSE_CODES[reason]);
    };
    // The real route checks the Origin first, before the cookie is even looked up.
    if (req.headers.origin !== ORIGIN) return close('bad_origin', `the voice socket's Origin is ${String(req.headers.origin)}`);
    if (!hasCookie(req)) return close('signed_out', 'the voice socket without the session cookie');
    let hello = false;
    let listening: number | null = null;
    ws.on('message', (data: Buffer, binary: boolean) => {
      if (binary) {
        const f = decodeFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        if (f === null || f.id !== listening) close('bad_message', 'a frame for no listen in flight');
        return;
      }
      const msg = parseClientMsg(JSON.parse(data.toString('utf8')) as unknown);
      if (msg === null) return close('bad_message', `a message core's parseClientMsg refuses: ${data.toString('utf8').slice(0, 200)}`);
      if (!hello && msg.t !== 'hello') return close('bad_message', `${msg.t} before hello`);
      switch (msg.t) {
        case 'hello':
          hello = true;
          return sendMsg({ t: 'ready', state: { kind: 'available' } });
        case 'listen':
          listening = msg.id;
          return;
        case 'end':
          if (msg.id !== listening) return close('bad_message', 'end for no listen in flight');
          listening = null;
          return sendMsg({ t: 'transcript', id: msg.id, text: transcript });
        case 'cancel':
          listening = null;
          return;
        case 'speak': {
          for (const item of msg.items) {
            if (item.kind === 'line') continue;
            if (item.kind !== 'reply') return close('bad_message', `a ${item.kind} speak item the bench never sends`);
            const parts = kept.get(item.replyId);
            if (parts === undefined) return close('bad_message', 'a reply the API never kept (a gated turn, or unknown)');
            if (parts[item.part]?.kind !== 'line') return close('bad_message', `reply part ${item.part} is not a written line`);
          }
          sendMsg({ t: 'audio_start', id: msg.id, sampleRate: 16_000 });
          for (let k = 0; k < 3; k++) ws.send(encodeFrame(msg.id, Int16Array.from({ length: 320 }, (_, i) => Math.round(4000 * Math.sin(i / 3)))));
          return sendMsg({ t: 'audio_end', id: msg.id });
        }
      }
    });
  }

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    cookie: `kq_session=${SESSION}`,
    origin: ORIGIN,
    problems,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** One utterance through the whole loop, against fake engines and the stub API; a run `parseBenchRun` accepted. */
export async function selftest(): Promise<BenchRun> {
  const config: VoiceConfig = {
    production: false,
    port: 0,
    token: Buffer.from(VOICE_TOKEN),
    engine: 'fake',
    sttModel: 'faster-whisper-base.en',
    cast: { model: 'piper-en_GB-northern_english_male-medium', voice: 'northern_english_male' },
    maxConnections: 4,
    host: '127.0.0.1',
    workerEngine: 'echo',
    modelsDir: '/nonexistent/kq-voice-models',
    python: 'python3',
    workers: 1,
    acceptLatencyMiss: undefined,
  };
  const voice = createVoiceServer({ config, stt: fakeStt(() => SELFTEST_TRANSCRIPT), tts: fakeTts(), log: createLogger(() => undefined) });
  const voicePort = await voice.listen(0);
  const api = await startStubApi();
  try {
    const now = new Date();
    const run = await runBench({
      api: api.url,
      cookie: api.cookie,
      origin: api.origin,
      voice: { host: '127.0.0.1', port: voicePort, token: VOICE_TOKEN },
      stack: { stt: 'fake-stt', tts: 'fake-tts', voice: 'selftest', llm: 'selftest', providers: ['selftest'] },
      box: 'selftest',
      cpu: 'selftest',
      gpu: null,
      texts: ["I'm allergic to kiwi, K-I-W-I"],
      noise: ['clean'],
      localDate: now.toISOString().slice(0, 10),
      localTime: now.toISOString().slice(11, 16),
    });
    if (api.problems.length > 0) throw new Error(`bench selftest: the stub API refused: ${api.problems.join('; ')}`);
    return run;
  } finally {
    await api.close();
    await voice.close();
  }
}
