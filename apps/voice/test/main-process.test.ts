// M7 fix round 1 (review I1, M9): the real src/main.ts in a child process, so Node's own fatal-error printer, which no
// in-process spy can see, is covered. Engines that throw synchronously, throw outside any promise, or reject
// unhandled, each with the transcript marker and the PCM in the message, must leave the child's real stdout and
// stderr clean (only content-free JSON log lines) and its TMPDIR, HOME and cwd untouched.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeFrame, type UpstreamServerMsg } from '@kitchenquest/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { connect, freePort, TEST_TOKEN, type Client } from './helpers';

const MARKER = 'zebrapeanut71';
const HINT_WORD = 'sesame';
const PCM_HEX = /514b514b|4b514b51/i;
const KINDS = ['conn_open', 'conn_close', 'stt_done', 'tts_done', 'engine_error', 'bad_message', 'auth_fail', 'fatal'];

const require = createRequire(import.meta.url);
const tsxDir = dirname(require.resolve('tsx/package.json'));
const tsxLoader = pathToFileURL(join(tsxDir, (JSON.parse(readFileSync(join(tsxDir, 'package.json'), 'utf8')) as { exports: { '.': string } }).exports['.'])).href;
const preload = new URL('./fixtures/fault-preload.mjs', import.meta.url).href;
/** As `npm run dev` runs main: core's recipe parser loads WebAssembly, whose ExperimentalWarning is not ours to print. */
const NODE_FLAGS = ['--no-warnings=ExperimentalWarning'];
const mainTs = fileURLToPath(new URL('../src/main.ts', import.meta.url));

let root = '';
let dirs: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kq-voice-main-'));
  dirs = ['tmp', 'home', 'cwd'].map((d) => join(root, d));
  for (const d of dirs) mkdirSync(d);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

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

interface Child {
  port: number;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
  kill(): void;
}

async function startMain(): Promise<Child> {
  const port = await freePort();
  let out = '';
  let err = '';
  const child = spawn(process.execPath, [...NODE_FLAGS, '--import', tsxLoader, '--import', preload, mainTs], {
    cwd: dirs[2],
    env: { PATH: process.env.PATH, TMPDIR: dirs[0], HOME: dirs[1], VOICE_SERVICE_TOKEN: TEST_TOKEN, VOICE_PORT: String(port), VOICE_ENGINE: 'fake' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const probe = await connect(port);
      probe.ws.close();
      await probe.closed;
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`main did not start: ${err}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return { port, stdout: () => out, stderr: () => err, exited, kill: () => child.kill('SIGTERM') };
}

async function waitFor(c: Client, pred: (m: UpstreamServerMsg) => boolean): Promise<UpstreamServerMsg> {
  for (;;) {
    const r = await c.next();
    if (r.kind === 'msg' && pred(r.msg)) return r.msg;
  }
}

async function utter(c: Client, id: number, hint: string[]): Promise<void> {
  c.send({ t: 'listen', id, hint });
  for (let i = 0; i < 10; i++) c.send(encodeFrame(id, new Int16Array(320).fill(0x4b51)));
  c.send({ t: 'end', id });
}

/** Every stdout line is a log line: a known kind and number or boolean fields only. Nothing at all on stderr. */
function clean(child: Child): { stdoutLines: unknown[]; problems: string[] } {
  const problems: string[] = [];
  const all = child.stdout() + child.stderr();
  if (child.stderr() !== '') problems.push('stderr not empty');
  if (all.includes(MARKER)) problems.push('marker');
  if (all.includes(HINT_WORD)) problems.push('hint');
  if (PCM_HEX.test(all)) problems.push('pcm hex');
  const stdoutLines = child
    .stdout()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        problems.push('a stdout line that is not JSON');
        return {};
      }
    });
  for (const line of stdoutLines) {
    if (!KINDS.includes(String(line.kind))) problems.push('unknown kind');
    for (const [k, v] of Object.entries(line)) if (k !== 'kind' && typeof v !== 'number' && typeof v !== 'boolean') problems.push(`field ${k}`);
  }
  return { stdoutLines, problems };
}

test('I1: a synchronous throw whose message carries the marker and the PCM fails only that utterance; the real main keeps serving and its stdout and stderr stay clean', async () => {
  const before = dirs.map((d) => snapshot(d));
  const child = await startMain();
  const c = await connect(child.port);
  c.send({ t: 'hello', v: 1 });
  await waitFor(c, (m) => m.t === 'ready');
  await utter(c, 1, ['sync', HINT_WORD]);
  expect(await waitFor(c, (m) => 'id' in m && m.id === 1)).toEqual({ t: 'failed', id: 1, kind: 'stt' });
  c.send({ t: 'speak', id: 2, voice: 'pan', chunks: [{ text: 'boom quagga', cache: false }] });
  expect(await waitFor(c, (m) => 'id' in m && m.id === 2)).toEqual({ t: 'failed', id: 2, kind: 'tts' });
  await utter(c, 3, [HINT_WORD]);
  expect(await waitFor(c, (m) => 'id' in m && m.id === 3)).toEqual({ t: 'transcript', id: 3, text: MARKER });
  c.ws.close();
  await c.closed;
  child.kill();
  expect(await child.exited).toBe(0);
  const { stdoutLines, problems } = clean(child);
  expect(problems).toEqual([]);
  expect(stdoutLines).toContainEqual({ kind: 'engine_error', stt: true });
  expect(dirs.map((d) => snapshot(d))).toEqual(before);
});

test.each([
  ['a throw outside any promise (uncaughtException)', 'escape'],
  ['an unhandled rejection', 'unhandled'],
])('I1: %s with the marker and the PCM: main logs only {"kind":"fatal"} and exits 1, printing nothing else', async (_name, fault) => {
  const before = dirs.map((d) => snapshot(d));
  const child = await startMain();
  const c = await connect(child.port);
  c.send({ t: 'hello', v: 1 });
  await waitFor(c, (m) => m.t === 'ready');
  await utter(c, 1, [fault, HINT_WORD]);
  expect(await child.exited).toBe(1);
  const { stdoutLines, problems } = clean(child);
  expect(problems).toEqual([]);
  expect(stdoutLines.at(-1)).toEqual({ kind: 'fatal' });
  expect(dirs.map((d) => snapshot(d))).toEqual(before);
});

test('positive control: an engine that prints its error is caught by the same checks (the child capture works)', async () => {
  const child = await startMain();
  const c = await connect(child.port);
  c.send({ t: 'hello', v: 1 });
  await waitFor(c, (m) => m.t === 'ready');
  await utter(c, 1, ['print', HINT_WORD]);
  await waitFor(c, (m) => 'id' in m && m.id === 1);
  c.ws.close();
  await c.closed;
  child.kill();
  await child.exited;
  expect(clean(child).problems).toEqual(expect.arrayContaining(['stderr not empty', 'marker', 'pcm hex']));
});
