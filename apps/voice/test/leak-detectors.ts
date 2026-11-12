// M7 C-18 leak detectors, shared by memory-only.test.ts (the Node side) and worker-contract.test.ts (the Python worker).
// Each looks for the test PCM word 0x4B51 (19281) in one encoding an adapter could print it in.
//
// F3 (Step 2 fix round 3): the float detectors are built from the real adapter's conversion. The worker turns PCM16
// into float32 as x / PCM_SCALE (read here from kq_voice_worker.py itself, so the two cannot drift); x / 32767 is
// covered too. Each scale is detected as a decimal (any form with 4+ decimals: float32 or float64 printing, %.7g,
// toFixed(4)), as hex of its float32 and float64 bytes, and as base64 of those bytes, in every byte phase.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PCM_WORD = 0x4b51;
export const WORKER_SOURCE = fileURLToPath(new URL('../worker/kq_voice_worker.py', import.meta.url));

/** The worker's own int16 -> float divisor, from its source. */
export function workerScale(): number {
  const m = /^PCM_SCALE = (\d+(?:\.\d+)?)\b/m.exec(readFileSync(WORKER_SOURCE, 'utf8'));
  if (m === null) throw new Error('kq_voice_worker.py: PCM_SCALE not found');
  return Number(m[1]);
}

const pcmBytes = Buffer.from(new Int16Array(32).fill(PCM_WORD).buffer);
const PCM_HEX = [pcmBytes.subarray(0, 8).toString('hex'), pcmBytes.subarray(1, 9).toString('hex')];
const PCM_B64 = [pcmBytes.subarray(0, 12).toString('base64').slice(0, 12), pcmBytes.subarray(1, 13).toString('base64').slice(0, 12)];
const PCM_SPACED_HEX = /(51 4b 51 4b|4b 51 4b 51)/;
/** The bytes as decimals, as inspect of a Uint8Array and a Buffer's JSON print them: 81, 75, 81, 75 (any spacing). */
const PCM_BYTES = /(81[,\s]+75[,\s]+81[,\s]+75|75[,\s]+81[,\s]+75[,\s]+81)/;
/** One sample per hex word: 4b51 4b51. */
const PCM_SAMPLE_HEX = /4b51[,\s]+4b51/;
const PCM_DEC = String(PCM_WORD);

/** 19281 / 32768 = 0.5884094…, 19281 / 32767 = 0.5884273…: both start 0.5884 at four or more decimals. */
const FLOAT_DEC = /0\.5884/;

/** The float runs a conversion makes, as raw bytes: float32 and float64, at each scale, exact and float32-rounded. */
function floatRuns(): Buffer[] {
  const runs: Buffer[] = [];
  for (const scale of [workerScale(), 32767]) {
    const exact = PCM_WORD / scale;
    const f32 = Math.fround(exact);
    runs.push(Buffer.from(new Float32Array(16).fill(exact).buffer));
    runs.push(Buffer.from(new Float64Array(16).fill(exact).buffer));
    runs.push(Buffer.from(new Float64Array(16).fill(f32).buffer));
  }
  return runs;
}

/** Every byte phase of each run (period 4 or 8 bytes), as hex and as base64. */
function phased(): { hex: string[]; b64: string[] } {
  const hex = new Set<string>();
  const b64 = new Set<string>();
  for (const run of floatRuns()) {
    const period = run.length / 16;
    for (let p = 0; p < period; p++) {
      hex.add(run.subarray(p, p + period * 2).toString('hex'));
      b64.add(run.subarray(p, p + 24).toString('base64').slice(0, 16));
    }
  }
  return { hex: [...hex], b64: [...b64] };
}
const FLOAT = phased();

const DETECTORS = {
  noPcmHex: (out: string) => !PCM_HEX.some((h) => out.toLowerCase().includes(h)),
  noPcmSpacedHex: (out: string) => !PCM_SPACED_HEX.test(out.toLowerCase()),
  noPcmBytes: (out: string) => !PCM_BYTES.test(out),
  noBufferJson: (out: string) => !out.toLowerCase().includes('"type":"buffer"'),
  noPcmBase64: (out: string) => !PCM_B64.some((b) => out.includes(b)),
  noPcmDecimal: (out: string) => !out.includes(PCM_DEC),
  noPcmSampleHex: (out: string) => !PCM_SAMPLE_HEX.test(out.toLowerCase()),
  noFloatPcm: (out: string) => !FLOAT_DEC.test(out),
  noFloatHex: (out: string) => !FLOAT.hex.some((h) => out.toLowerCase().includes(h)),
  noFloatPcmBase64: (out: string) => !FLOAT.b64.some((b) => out.includes(b)),
} as const;

export type DetectorName = keyof typeof DETECTORS;

export function pcmChecks(out: string): Record<DetectorName, boolean> {
  return Object.fromEntries(Object.entries(DETECTORS).map(([k, f]) => [k, f(out)])) as Record<DetectorName, boolean>;
}
