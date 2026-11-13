// A valid BenchRun for the schema and gate tests: the configured default stack, meeting the target.
import type { BenchRun } from '../bench/schema';

export function benchRun(over: Partial<BenchRun> = {}): BenchRun {
  const t = (p50: number, p90: number, p95: number) => ({ p50, p90, p95 });
  return {
    date: '2026-12-01',
    box: 'ccx33-fsn1',
    cpu: 'AMD EPYC 9454P, 8 dedicated vCPU',
    gpu: null,
    stack: { stt: 'faster-whisper-base.en', tts: 'piper-en_GB-northern_english_male-medium', voice: 'northern_english_male', llm: 'qwen/qwen3.8-27b', providers: ['openrouter'] },
    utterances: { source: 'synthetic', n: 60, noise: ['clean', '15dB', '5dB'], consentRecord: null },
    ms: { firstAudio: t(420, 610, 700), replyAudio: t(1380, 2100, 2400), stt: t(540, 600, 640), turn: t(700, 1300, 1600), ttsFirst: t(60, 80, 90) },
    wer: { hinted: 0.1, unhinted: 0.14 },
    termRecall: { hinted: 0.7, unhinted: 0.45 },
    meetsTarget: true,
    ...over,
  };
}
