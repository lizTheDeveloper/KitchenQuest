// M7 Step 2: the service logs only enums and numbers (Global Constraints, Logs; C-18). D3: the type rule is checked
// by tsc (typecheck runs tsconfig.test.json over this file) and again at runtime.
import { expect, test } from 'vitest';
import { createLogger, type LogKind, warningFields } from '../src/log';

test('a string field is a compile error (// @ts-expect-error, checked by tsc in typecheck) and is dropped at runtime (D3)', () => {
  const lines: string[] = [];
  const log = createLogger((line) => lines.push(line));

  // @ts-expect-error -- a string field never type-checks
  log('stt_done', { text: 'zebrapeanut71', audioMs: 1200 });
  // @ts-expect-error -- nor does a nested object
  log('tts_done', { detail: { text: 'quagga' }, ms: 5 });
  // @ts-expect-error -- nor an unknown kind
  log('transcript', { ms: 1 });
  log('conn_open', { open: 1, ok: true });
  log('conn_close');

  expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
    { kind: 'stt_done', audioMs: 1200 },
    { kind: 'tts_done', ms: 5 },
    { kind: 'conn_open', open: 1, ok: true },
    { kind: 'conn_close' },
  ]);
  const all = lines.join('\n');
  expect(all).not.toContain('zebrapeanut71');
  expect(all).not.toContain('quagga');
  expect(all).not.toContain('text');
  expect(all).not.toContain('transcript');
});

test('non-finite numbers and odd field names are dropped too; every line is one JSON object', () => {
  const lines: string[] = [];
  const log = createLogger((line) => lines.push(line));
  log('engine_error', { ms: Number.NaN, inf: Number.POSITIVE_INFINITY, 'with space': 1, ['a'.repeat(65)]: 2, stt: true });
  expect(lines).toEqual([JSON.stringify({ kind: 'engine_error', stt: true })]);
  const kinds: LogKind[] = ['conn_open', 'conn_close', 'stt_done', 'tts_done', 'engine_error', 'bad_message', 'auth_fail', 'fatal', 'warning', 'worker_down', 'pool_empty', 'pool_ready'];
  for (const k of kinds) log(k);
  expect(lines).toHaveLength(1 + kinds.length);
});

test('fix round 2 (N2): a warning is logged by name only; a free-text type is just `other`', () => {
  const custom = new Error('zebrapeanut71');
  custom.name = 'Zebrapeanut71Warning';
  expect(warningFields(custom)).toEqual({ other: true });
  const dep = new Error('deprecated zebrapeanut71');
  dep.name = 'DeprecationWarning';
  expect(warningFields(dep)).toEqual({ deprecation: true });
  expect(warningFields('a string')).toEqual({ other: true });
});
