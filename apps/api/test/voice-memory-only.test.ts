// M7 C-18, §7.7 ("Audio is processed in memory and never stored"), Review Focus 2, D1: the API's voice route keeps
// audio and transcripts in memory only. A full session runs over the real socket (marker PCM, a transcript token, a
// throwing upstream, a socket closed mid-utterance, a failing database on the upgrade); then the process's
// filesystem, every log line, stdout/stderr/console and the database are checked with apps/voice's shared leak
// detectors. The same run with a deliberately leaking FakeUpstream must FAIL the checks (the positive control).
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import type { FastifyBaseLogger, FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { PCM_WORD, pcmChecks } from '../../voice/test/leak-detectors.js';
import { buildApp } from '../src/app.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { voiceErrorForLog } from '../src/logging/redact.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { connectVoice, FakeUpstream, type FakeUpstreamOptions } from './helpers/fake-upstream.js';
import { captureLogs } from './helpers/logs.js';

const config = testConfig({ VOICE_ENABLED: 'true', VOICE_SERVICE_URL: 'ws://127.0.0.1:9', VOICE_SERVICE_TOKEN: 'test-token' });
const NOW = new Date('2026-11-12T10:00:00Z');
const CLOCK = { localDate: '2026-11-12', localTime: '10:00' };
const MARKER = 'zebrapeanut71';
/** A pantry name that goes into the STT hint (with health_data): it must never reach a log either. */
const HINT_WORD = 'quaggaberry';

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
});
afterAll(async () => {
  await closeDb?.();
});

// --- a fresh TMPDIR, HOME and cwd per run ----------------------------------------------------------------------------

let root = '';
let dirs: string[] = [];
const saved = { cwd: process.cwd(), TMPDIR: process.env.TMPDIR, HOME: process.env.HOME };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kq-api-c18-'));
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

type Snapshot = Record<string, number>;
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

// --- the second net: fs write spies, and stdout, stderr and console captured -----------------------------------------

function installNets(): { writeCalls: string[]; output: string[]; restore(): void } {
  const writeCalls: string[] = [];
  const output: string[] = [];
  const restores: (() => void)[] = [];
  const target = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'copyFile', 'copyFileSync', 'mkdtemp', 'mkdtempSync'] as const) {
    const orig = target[name];
    const spy = vi.spyOn(target, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      writeCalls.push(`fs.${name}`);
      return orig.apply(this, args);
    });
    restores.push(() => spy.mockRestore());
  }
  const promises = fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ['writeFile', 'appendFile', 'copyFile', 'mkdtemp'] as const) {
    const orig = promises[name];
    const spy = vi.spyOn(promises, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      writeCalls.push(`fs.promises.${name}`);
      return orig.apply(this, args);
    });
    restores.push(() => spy.mockRestore());
  }
  syncBuiltinESMExports();
  const capture = (chunk: unknown) => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return true;
  };
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  restores.push(() => out.mockRestore(), () => err.mockRestore());
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
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

// --- one full session ------------------------------------------------------------------------------------------------

interface Evidence {
  transcript: boolean;
  audioEnd: boolean;
  failedStt: boolean;
  closedMidUtterance: boolean;
  upgrade500: boolean;
  before: Snapshot[];
  after: Snapshot[];
  writeCalls: string[];
  output: string;
  database: string;
}

/** Leaks the positive control can do: with the app's own logger, the TMPDIR, and the fake's view of audio. */
type Leak = (log: FastifyBaseLogger) => Pick<FakeUpstreamOptions, 'onTranscript' | 'onFrame'>;

async function runSession(leak?: Leak): Promise<Evidence> {
  const before = dirs.map((d) => snapshot(d));
  const nets = installNets();
  const logs = captureLogs();
  const ev = { transcript: false, audioEnd: false, failedStt: false, closedMidUtterance: false, upgrade500: false };
  let app: FastifyInstance | undefined;
  let failSelects = false;
  try {
    let log: FastifyBaseLogger | null = null;
    const hooks = leak ? leak({ info: (...a: unknown[]) => (log as unknown as { info: (...b: unknown[]) => void }).info(...a) } as unknown as FastifyBaseLogger) : {};
    const upstream = new FakeUpstream({
      transcribe: (u) => {
        // A throwing STT whose error holds the transcript and the audio (an engine's message may: Review Focus 2).
        if (u.frames === 3) throw new Error(`stt crashed on ${MARKER} ${Buffer.from(new Int16Array(8).fill(PCM_WORD).buffer).toString('hex')}`);
        return `i ate ${MARKER} and ${HINT_WORD}`;
      },
      rawErrors: true,
      ...hooks,
    });
    // The database, failing on demand with the marker in its error (the upgrade's error hook, Review Focus 2).
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select' && failSelects) return () => { throw new Error(`database down while reading ${MARKER}`); };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    app = await buildApp({ config, db: failing, mailer: new CaptureMailer(), ai: null, now: () => NOW, logger: logs.logger, voiceUpstream: upstream });
    log = app.log;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const mailer = (app.deps.mailer as CaptureMailer);
    const cookie = await signIn(app, mailer, `memonly${++seq}@example.com`);
    const call = (opts: InjectOptions) => app!.inject({ ...opts, cookies: { kq_session: cookie } });
    for (const purpose of ['voice', 'health_data'] as const) {
      expect((await call({ method: 'POST', url: '/me/consents', payload: { purpose, noticeVersion: NOTICES[purpose]!.version } })).statusCode).toBe(201);
    }
    expect((await call({ method: 'POST', url: '/pantry/changes', payload: { add: [{ name: HINT_WORD, ingredientId: null }], removeNames: [], removeIds: [], confirmed: true } })).statusCode).toBe(200);

    const c = await connectVoice(port, { cookie });
    c.send({ t: 'hello', v: 1, conversationId: null, familyTable: false, ...CLOCK });
    await c.next((m) => m.t === 'ready');
    // 1. an utterance of marker PCM → its transcript
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    for (let i = 0; i < 50; i++) c.frame(1, 320, PCM_WORD);
    c.send({ t: 'end', id: 1 });
    const t = await c.next((m) => m.t !== 'ready');
    ev.transcript = t.t === 'transcript' && t.text.includes(MARKER);
    // 2. the Pan reads the heard card back (the transcript's words, spelled) → audio_end
    c.send({ t: 'speak', id: 2, items: [{ kind: 'heard', utteranceId: 1 }, { kind: 'line', trigger: 'voice.check_screen', index: 0 }] });
    ev.audioEnd = (await c.next((m) => m.t === 'audio_end' || m.t === 'failed')).t === 'audio_end';
    // 3. the throwing upstream: the route gets an error holding the marker and the PCM, and must not look at it
    c.send({ t: 'listen', id: 3, mode: 'hold' });
    for (let i = 0; i < 3; i++) c.frame(3, 320, PCM_WORD);
    c.send({ t: 'end', id: 3 });
    const f = await c.next((m) => m.t === 'failed' || m.t === 'transcript');
    ev.failedStt = f.t === 'failed';
    // 4. a socket closed mid-utterance
    c.send({ t: 'listen', id: 4, mode: 'hold' });
    for (let i = 0; i < 10; i++) c.frame(4, 320, PCM_WORD);
    await new Promise((r) => setTimeout(r, 50));
    c.ws.terminate();
    ev.closedMidUtterance = (await c.closed) === 1006;
    // 5. the upgrade's error hook: the database fails with the marker in its error → a bare 500, logged by kind
    failSelects = true;
    ev.upgrade500 = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`, { headers: { cookie: `kq_session=${cookie}`, origin: 'http://localhost:5173' } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode === 500));
      ws.on('open', () => resolve(false));
      ws.on('error', () => {});
    });
    failSelects = false;
    await new Promise((r) => setTimeout(r, 100));
    await app.close();
    app = undefined;
  } finally {
    failSelects = false;
    await app?.close();
    nets.restore();
  }
  // Every table, as text: no transcript, hint or audio in any row.
  const tables = await sql<{ t: string }[]>`select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;
  let database = '';
  for (const { t } of tables) database += (await sql.unsafe(`select coalesce(string_agg(r::text, E'\\n'), '') as d from "${t}" r`))[0].d as string;
  return { ...ev, before, after: dirs.map((d) => snapshot(d)), writeCalls: nets.writeCalls, output: nets.output.join('') + logs.text(), database };
}

function checks(e: Evidence): Record<string, boolean> {
  const out = e.output.toLowerCase();
  return {
    identicalSnapshots: JSON.stringify(e.before) === JSON.stringify(e.after),
    noWriteSpyCall: e.writeCalls.length === 0,
    noMarker: !out.includes(MARKER),
    noHint: !out.includes(HINT_WORD),
    noMarkerInDatabase: !e.database.includes(MARKER),
    ...pcmChecks(e.output),
  };
}
const ALL_PASS = Object.fromEntries(Object.keys(checks({ before: [], after: [], writeCalls: [], output: '', database: '' } as unknown as Evidence)).map((k) => [k, true]));
const flow = (e: Evidence) => [e.transcript, e.audioEnd, e.failedStt, e.closedMidUtterance, e.upgrade500];

describe('C-18: the voice route keeps audio and transcripts in memory only', () => {
  test('a session with marker PCM, a transcript token and a throwing upstream reaches transcript and audio_end, leaves identical dir snapshots and no marker in logs', async () => {
    const e = await runSession();
    expect(flow(e)).toEqual([true, true, true, true, true]);
    // The logger ran (so the check can fail): the route's kinds are there, and nothing else of the session.
    expect(e.output).toContain('"kind":"voice_upstream_other"');
    expect(e.output).toContain('"kind":"Error","status":500');
    expect(e.after).toEqual(e.before);
    expect(e.writeCalls).toEqual([]);
    expect(checks(e)).toEqual(ALL_PASS);
  });

  test('positive control: a leaking FakeUpstream (logs the transcript via app.log) fails the assertions', async () => {
    const e = await runSession((log) => ({
      onTranscript: (text) => log.info({ heard: text }, 'transcript'),
      onFrame: (pcm) => {
        log.info({ frame: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).subarray(0, 16).toString('hex') }, 'frame');
        writeFileSync(join(tmpdir(), 'utterance.pcm'), Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      },
    }));
    // The flow reaches the same places, so the failures are the leak's alone.
    expect(flow(e)).toEqual([true, true, true, true, true]);
    const got = checks(e);
    for (const k of ['identicalSnapshots', 'noWriteSpyCall', 'noMarker', 'noHint', 'noPcmHex']) expect(got[k], k).toBe(false);
    expect(got.noMarkerInDatabase).toBe(true);
  });

  test('the Fastify error hook on /voice logs kind and status only (Review Focus 2)', () => {
    class Custom extends Error {}
    const err = Object.assign(new Custom(`boom ${MARKER}`), { detail: MARKER, cause: new Error(MARKER) });
    err.name = `name ${MARKER}`;
    expect(voiceErrorForLog(err, 500)).toEqual({ kind: 'Custom', status: 500 });
    expect(voiceErrorForLog(`string ${MARKER}`, 1011)).toEqual({ kind: 'NonError', status: 1011 });
    expect(JSON.stringify(voiceErrorForLog(err, 500))).not.toContain(MARKER);
  });
});
