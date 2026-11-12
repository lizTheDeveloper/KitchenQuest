// M7 Step 3: the operator latency benchmark (spec §12, Ruling 3). Run on the target box, never in CI:
//
//   npm run bench -w @kitchenquest/voice -- --api https://<api host> --box ccx33-fsn1 --cpu "<model, vCPUs>" \
//     --llm qwen/qwen3.8-27b --providers tenstorrent [--gpu "<model>"] [--recordings <dir> --consent <record>] \
//     [--manual chromium:pass,safari:pass,firefox:fail]
//
// It needs a running API (AI on, a throwaway database, a synthetic player: BENCH_API_COOKIE, and BENCH_ORIGIN for the
// API's Origin check) and a voice service with real engines (VOICE_PORT, VOICE_HOST, VOICE_SERVICE_TOKEN and the
// VOICE_* model variables, as the service itself reads them). `--selftest` (M7 Step 7, P15) runs the same loop
// (loop.ts) against fake engines and a stub API on loopback and writes nothing:
//
//   npm run bench -w @kitchenquest/voice -- --selftest
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
import { copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadVoiceConfig } from '../src/config.js';
import { loadManifest } from '../src/models.js';
import { runBench } from './loop.js';
import { selftest } from './selftest.js';

const BENCH = fileURLToPath(new URL('./', import.meta.url));

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
      selftest: { type: 'boolean' },
    },
  });
  // M7 Step 7 (P15): the whole loop against fake engines and a stub API on loopback. No network, no model, and nothing
  // written: bench/latest.json, which production boots against, is never touched.
  if (values.selftest === true) {
    const run = await selftest();
    process.stdout.write(`${JSON.stringify({ selftest: 'pass', n: run.utterances.n, replyAudio: run.ms.replyAudio })}\n`);
    return;
  }
  const need = (k: keyof typeof values): string => {
    const v = values[k];
    if (typeof v !== 'string' || v === '') throw new Error(`bench: --${k} is required`);
    return v;
  };
  const cookie = process.env.BENCH_API_COOKIE ?? '';
  const origin = process.env.BENCH_ORIGIN ?? '';
  if (cookie === '' || origin === '') throw new Error('bench: BENCH_API_COOKIE (the synthetic player: kq_session=<token>) and BENCH_ORIGIN are required');
  if (values.recordings !== undefined && !values.consent) throw new Error('bench: --recordings needs --consent naming the written consent record (C8)');

  const config = loadVoiceConfig(process.env, loadManifest());
  const now = new Date();
  const manual = values.manual?.split(',').map((e) => {
    const [browser, result] = e.split(':');
    return { browser: browser as 'chromium' | 'safari' | 'firefox', echoBargeInPass: result === 'pass' };
  });
  const run = await runBench({
    api: need('api'),
    cookie,
    origin,
    voice: { host: config.host, port: config.port, token: config.token.toString('utf8') },
    stack: { stt: config.sttModel, tts: config.cast.model, voice: config.cast.voice, llm: need('llm'), providers: need('providers').split(',') },
    box: need('box'),
    cpu: need('cpu'),
    gpu: values.gpu ?? null,
    ...(values.recordings !== undefined ? { recordings: { dir: values.recordings, consent: values.consent! } } : {}),
    ...(manual ? { manual } : {}),
    localDate: now.toISOString().slice(0, 10),
    localTime: now.toISOString().slice(11, 16),
  });
  const file = join(BENCH, 'results', `${run.date}-${run.box}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  copyFileSync(file, join(BENCH, 'latest.json'));
  process.stdout.write(`${JSON.stringify({ file, meetsTarget: run.meetsTarget, replyAudio: run.ms.replyAudio, firstAudio: run.ms.firstAudio, wer: run.wer })}\n`);
  if (values.recordings !== undefined) process.stdout.write('Delete the recordings now (C8): they were read in place and never copied.\n');
}

// Run only as the CLI (`npm run bench`), never on import.
const invoked = process.argv.at(1);
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : 'bench failed'}\n`);
    process.exit(1);
  });
}
