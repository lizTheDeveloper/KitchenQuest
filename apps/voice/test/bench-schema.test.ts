// M7 Step 3: the benchmark results file (spec §12, Ruling 3). parseBenchRun is strict and recomputes meetsTarget, so a
// hand-edited pass cannot slip through; a recorded run needs its consent record (C8).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parseBenchRun } from '../bench/schema';
import { benchRun } from './bench-fixture';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

test('parseBenchRun rejects a missing field, a meetsTarget that disagrees with the numbers, and a recorded run with no consentRecord', () => {
  const good = benchRun();
  expect(parseBenchRun(clone(good))).toEqual(good);
  // A miss that says so is a valid run.
  const miss = benchRun({ ms: { ...good.ms, replyAudio: { p50: 1600, p90: 2600, p95: 2900 } }, meetsTarget: false });
  expect(parseBenchRun(clone(miss)).meetsTarget).toBe(false);

  // Every top-level field is required.
  for (const k of Object.keys(good).filter((k) => k !== 'manual')) {
    const x = clone(good) as unknown as Record<string, unknown>;
    delete x[k];
    expect(() => parseBenchRun(x), k).toThrow(new RegExp(k));
  }
  // Nested ones too, and nothing unknown.
  const noP95 = clone(good) as unknown as { ms: { stt: Record<string, number> } };
  delete noP95.ms.stt.p95;
  expect(() => parseBenchRun(noP95)).toThrow(/ms\.stt/);
  expect(() => parseBenchRun({ ...clone(good), extra: 1 })).toThrow(/extra/);

  // meetsTarget is recomputed: replyAudio p50 ≤ 1500 and p90 ≤ 2500.
  expect(() => parseBenchRun({ ...clone(miss), meetsTarget: true })).toThrow(/meetsTarget/);
  expect(() => parseBenchRun({ ...clone(good), meetsTarget: false })).toThrow(/meetsTarget/);
  const edge = benchRun({ ms: { ...good.ms, replyAudio: { p50: 1500, p90: 2500, p95: 2500 } } });
  expect(parseBenchRun(clone(edge)).meetsTarget).toBe(true);
  const over = benchRun({ ms: { ...good.ms, replyAudio: { p50: 1500, p90: 2501, p95: 2600 } }, meetsTarget: true });
  expect(() => parseBenchRun(clone(over))).toThrow(/meetsTarget/);

  // C8: recorded speech needs a written consent record named.
  const recorded = { ...good.utterances, source: 'recorded' as const };
  expect(() => parseBenchRun({ ...clone(good), utterances: { ...recorded, consentRecord: null } })).toThrow(/consentRecord/);
  expect(() => parseBenchRun({ ...clone(good), utterances: { ...recorded, consentRecord: '' } })).toThrow(/consentRecord/);
  expect(parseBenchRun({ ...clone(good), utterances: { ...recorded, consentRecord: 'consent/2026-12-01-volunteers.pdf' } }).utterances.source).toBe('recorded');

  // Shapes: a date, percentiles in order, a known noise level, a known browser.
  expect(() => parseBenchRun({ ...clone(good), date: '1 Dec' })).toThrow(/date/);
  expect(() => parseBenchRun({ ...clone(good), ms: { ...good.ms, stt: { p50: 700, p90: 600, p95: 640 } } })).toThrow(/ms\.stt/);
  expect(() => parseBenchRun({ ...clone(good), utterances: { ...good.utterances, noise: ['loud'] } })).toThrow(/noise/);
  expect(() => parseBenchRun({ ...clone(good), manual: [{ browser: 'edge', echoBargeInPass: true }] })).toThrow(/manual/);
  expect(parseBenchRun({ ...clone(good), manual: [{ browser: 'safari', echoBargeInPass: false }] }).manual).toEqual([{ browser: 'safari', echoBargeInPass: false }]);
});

test('every committed file under bench/results/ and bench/latest.json (if present) parses', () => {
  const bench = fileURLToPath(new URL('../bench/', import.meta.url));
  const results = join(bench, 'results');
  expect(existsSync(join(results, '.gitkeep'))).toBe(true);
  const files = readdirSync(results).filter((f) => f !== '.gitkeep');
  for (const f of files) {
    expect(f, f).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.json$/);
    const run = parseBenchRun(JSON.parse(readFileSync(join(results, f), 'utf8')));
    expect(f).toBe(`${run.date}-${run.box}.json`);
  }
  const latest = join(bench, 'latest.json');
  if (existsSync(latest)) {
    const run = parseBenchRun(JSON.parse(readFileSync(latest, 'utf8')));
    // latest.json is a copy of one committed result.
    expect(files).toContain(`${run.date}-${run.box}.json`);
  }
});
