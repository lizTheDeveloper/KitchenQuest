// M7 Step 3: the benchmark results file (spec §12, Ruling 3). One run is `bench/results/<date>-<box>.json`; the run
// production boots against is copied to `bench/latest.json`. apps/voice/README.md documents every field.
import { NOISE_LEVELS, type NoiseLevel } from './phrases.js';

type Pct = { p50: number; p90: number; p95: number };
export const TIMINGS = ['firstAudio', 'replyAudio', 'stt', 'turn', 'ttsFirst'] as const;
const BROWSERS = ['chromium', 'safari', 'firefox'] as const;

export interface BenchRun {
  date: string;
  box: string;
  cpu: string;
  gpu: string | null;
  stack: { stt: string; tts: string; voice: string; llm: string; providers: string[] };
  utterances: { source: 'synthetic' | 'recorded'; n: number; noise: NoiseLevel[]; consentRecord: string | null };
  ms: Record<(typeof TIMINGS)[number], Pct>;
  wer: { hinted: number; unhinted: number };
  termRecall: { hinted: number; unhinted: number };
  /** replyAudio.p50 ≤ 1500 && replyAudio.p90 ≤ 2500 (§7.7 as revised by the spike). */
  meetsTarget: boolean;
  /** The browser echo/barge-in checklist (Ruling 7), done by hand on speakers, no headphones. */
  manual?: { browser: (typeof BROWSERS)[number]; echoBargeInPass: boolean }[];
}

/** Ruling 3: end of speech → first spoken reply audio. */
export const LATENCY_TARGET_MS = { p50: 1500, p90: 2500 } as const;

export function meetsTarget(ms: Pick<BenchRun['ms'], 'replyAudio'>): boolean {
  return ms.replyAudio.p50 <= LATENCY_TARGET_MS.p50 && ms.replyAudio.p90 <= LATENCY_TARGET_MS.p90;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function bad(what: string): never {
  throw new Error(`bench run: ${what}`);
}

function obj(x: unknown, where: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isObj(x)) bad(`${where} must be an object`);
  for (const k of keys) if (!(k in x)) bad(`${where === '' ? '' : `${where}.`}${k} is missing`);
  for (const k of Object.keys(x)) if (!keys.includes(k) && !optional.includes(k)) bad(`${where === '' ? '' : `${where}.`}${k} is not a known field`);
  return x;
}

function str(x: unknown, where: string): string {
  if (typeof x !== 'string' || x.trim() === '') bad(`${where} must be a non-empty string`);
  return x;
}

function num(x: unknown, where: string, max = Number.POSITIVE_INFINITY): number {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > max) bad(`${where} must be a number from 0${max === Number.POSITIVE_INFINITY ? '' : ` to ${max}`}`);
  return x;
}

function pair(x: unknown, where: string, max?: number): { hinted: number; unhinted: number } {
  const o = obj(x, where, ['hinted', 'unhinted']);
  return { hinted: num(o.hinted, `${where}.hinted`, max), unhinted: num(o.unhinted, `${where}.unhinted`, max) };
}

/** A run, strictly: every field present and nothing unknown. meetsTarget is recomputed and must agree. A fresh copy. */
export function parseBenchRun(x: unknown): BenchRun {
  const keys = ['date', 'box', 'cpu', 'gpu', 'stack', 'utterances', 'ms', 'wer', 'termRecall', 'meetsTarget'];
  const o = obj(x, '', keys, ['manual']);

  const date = str(o.date, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) bad('date must be YYYY-MM-DD');
  const box = str(o.box, 'box');
  if (!/^[a-z0-9-]+$/.test(box)) bad('box must be lowercase letters, digits and hyphens (it names the results file)');
  const cpu = str(o.cpu, 'cpu');
  const gpu = o.gpu === null ? null : str(o.gpu, 'gpu');

  const s = obj(o.stack, 'stack', ['stt', 'tts', 'voice', 'llm', 'providers']);
  if (!Array.isArray(s.providers) || s.providers.length === 0) bad('stack.providers must list at least one provider');
  const stack = { stt: str(s.stt, 'stack.stt'), tts: str(s.tts, 'stack.tts'), voice: str(s.voice, 'stack.voice'), llm: str(s.llm, 'stack.llm'), providers: (s.providers as unknown[]).map((p, i) => str(p, `stack.providers[${i}]`)) };

  const u = obj(o.utterances, 'utterances', ['source', 'n', 'noise', 'consentRecord']);
  if (u.source !== 'synthetic' && u.source !== 'recorded') bad('utterances.source must be synthetic or recorded');
  if (typeof u.n !== 'number' || !Number.isInteger(u.n) || u.n < 1) bad('utterances.n must be a positive whole number');
  if (!Array.isArray(u.noise) || u.noise.length === 0 || !u.noise.every((n) => (NOISE_LEVELS as readonly unknown[]).includes(n)) || new Set(u.noise).size !== u.noise.length)
    bad(`utterances.noise must list distinct levels from ${NOISE_LEVELS.join(', ')}`);
  // C8: recorded speech only from volunteers with a written consent record, named here.
  if (u.source === 'recorded' && (typeof u.consentRecord !== 'string' || u.consentRecord.trim() === '')) bad('utterances.consentRecord is required for a recorded run (C8)');
  if (u.consentRecord !== null && typeof u.consentRecord !== 'string') bad('utterances.consentRecord must be a string or null');
  const utterances = { source: u.source as BenchRun['utterances']['source'], n: u.n, noise: [...(u.noise as NoiseLevel[])], consentRecord: u.consentRecord as string | null };

  const m = obj(o.ms, 'ms', TIMINGS);
  const ms = Object.fromEntries(
    TIMINGS.map((k) => {
      const where = `ms.${k}`;
      const p = obj(m[k], where, ['p50', 'p90', 'p95']);
      const v = { p50: num(p.p50, `${where}.p50`), p90: num(p.p90, `${where}.p90`), p95: num(p.p95, `${where}.p95`) };
      if (!(v.p50 <= v.p90 && v.p90 <= v.p95)) bad(`${where} must have p50 ≤ p90 ≤ p95`);
      return [k, v];
    }),
  ) as BenchRun['ms'];

  const wer = pair(o.wer, 'wer');
  const termRecall = pair(o.termRecall, 'termRecall', 1);
  if (typeof o.meetsTarget !== 'boolean') bad('meetsTarget must be a boolean');
  if (o.meetsTarget !== meetsTarget(ms)) bad(`meetsTarget is ${String(o.meetsTarget)} but replyAudio p50 ${ms.replyAudio.p50} ms and p90 ${ms.replyAudio.p90} ms say ${String(meetsTarget(ms))}`);

  const run: BenchRun = { date, box, cpu, gpu, stack, utterances, ms, wer, termRecall, meetsTarget: o.meetsTarget };
  if (o.manual !== undefined) {
    if (!Array.isArray(o.manual)) bad('manual must be a list');
    run.manual = (o.manual as unknown[]).map((e, i) => {
      const r = obj(e, `manual[${i}]`, ['browser', 'echoBargeInPass']);
      if (!(BROWSERS as readonly unknown[]).includes(r.browser)) bad(`manual[${i}].browser must be one of ${BROWSERS.join(', ')}`);
      if (typeof r.echoBargeInPass !== 'boolean') bad(`manual[${i}].echoBargeInPass must be a boolean`);
      return { browser: r.browser as (typeof BROWSERS)[number], echoBargeInPass: r.echoBargeInPass };
    });
  }
  return run;
}
