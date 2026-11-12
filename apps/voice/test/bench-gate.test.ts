// M7 Ruling 3: production boots only against a benchmark run of the configured stack that meets p50 ≤ 1.5 s and
// p90 ≤ 2.5 s on replyAudio, or a miss the founder accepted by its date (VOICE_ACCEPT_LATENCY_MISS).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrame } from '@kitchenquest/core';
import { afterEach, expect, test } from 'vitest';
import { benchGate, loadLatestRun } from '../src/bench-gate';
import { boot } from '../src/boot';
import { benchRun } from './bench-fixture';
import { connect, freePort, testConfig, TEST_TOKEN } from './helpers';

const cfg = testConfig({ production: true, engine: 'worker' });
const miss = benchRun({ ms: { ...benchRun().ms, replyAudio: { p50: 1720, p90: 2900, p95: 3100 } }, meetsTarget: false });

test("no run → refused; another stack → refused; a miss → refused unless VOICE_ACCEPT_LATENCY_MISS equals its date; a pass → ok", () => {
  const none = benchGate(cfg, null, undefined);
  expect(none.ok).toBe(false);
  expect(!none.ok && none.why).toMatch(/apps\/voice\/bench\/latest\.json.*npm run bench/s);

  for (const stack of [
    { ...benchRun().stack, stt: 'faster-whisper-tiny.en' },
    { ...benchRun().stack, tts: 'kokoro-82m-v1.0', voice: 'bm_fable' },
    { ...benchRun().stack, voice: 'someone_else' },
  ]) {
    const r = benchGate(cfg, benchRun({ stack }), undefined);
    expect(r.ok, JSON.stringify(stack)).toBe(false);
    expect(!r.ok && r.why).toMatch(/another stack/);
  }

  const m = benchGate(cfg, miss, undefined);
  expect(m.ok).toBe(false);
  expect(!m.ok && m.why).toMatch(/2026-12-01.*p50 1720 ms.*p90 2900 ms.*VOICE_ACCEPT_LATENCY_MISS=2026-12-01/s);
  expect(benchGate(cfg, miss, '2026-11-30').ok).toBe(false);
  expect(benchGate(cfg, miss, '2026-12-01')).toEqual({ ok: true });
  // A pass needs no acceptance, and an acceptance of another date changes nothing.
  expect(benchGate(cfg, benchRun(), undefined)).toEqual({ ok: true });
  expect(benchGate(cfg, benchRun(), '2020-01-01')).toEqual({ ok: true });
  // A pass of another stack is still refused, accepted or not.
  expect(benchGate(cfg, benchRun({ stack: { ...benchRun().stack, stt: 'faster-whisper-small.en' } }), '2026-12-01').ok).toBe(false);
});

test('loadLatestRun: a missing file is no run; an invalid one throws naming the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kq-voice-gate-'));
  try {
    expect(loadLatestRun(join(dir, 'latest.json'))).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect(() => loadLatestRun(new URL('../package.json', import.meta.url))).toThrow(/package\.json/);
});

const services: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

test('boot({ NODE_ENV: "production", … }) rejects with the gate\'s reason; development boots without a run', async () => {
  const prod = { NODE_ENV: 'production', VOICE_SERVICE_TOKEN: 'p'.repeat(32), VOICE_ENGINE: 'worker', VOICE_PORT: String(await freePort()) };
  // The repo has no latest.json until the operator's first run: refused by the gate.
  await expect(boot(prod)).rejects.toThrow(/latency bench gate \(Ruling 3\).*latest\.json/s);
  await expect(boot(prod, { latestRun: () => miss })).rejects.toThrow(/missed the latency target/);
  // Past the gate, the pins are checked next: CI has no weights, so a pass stops there, naming the first file.
  await expect(boot(prod, { latestRun: () => benchRun() })).rejects.toThrow(/voice model faster-whisper-base\.en: faster-whisper-base\.en\/\S+ is missing/);
  await expect(boot({ ...prod, VOICE_ACCEPT_LATENCY_MISS: '2026-12-01' }, { latestRun: () => miss })).rejects.toThrow(/is missing/);

  // Development: the echo worker engine, no run, no pins.
  const port = await freePort();
  const service = await boot({ VOICE_SERVICE_TOKEN: TEST_TOKEN, VOICE_PORT: String(port), VOICE_ENGINE: 'worker', VOICE_WORKER_ENGINE: 'echo', VOICE_WORKERS: '1' }, { latestRun: () => null });
  services.push(service);
  const c = await connect(port);
  c.send({ t: 'hello', v: 1 });
  expect(await c.next(8000)).toMatchObject({ kind: 'msg', msg: { t: 'ready', stt: 'echo-stt', tts: 'echo-tts', sampleRate: 22_050 } });
  c.send({ t: 'listen', id: 1, hint: [] });
  c.send(encodeFrame(1, new Int16Array(320)));
  c.send({ t: 'end', id: 1 });
  expect(await c.next(8000)).toMatchObject({ kind: 'msg', msg: { t: 'transcript', id: 1, text: 'echo 320' } });
  c.ws.close();
  await c.closed;
});
