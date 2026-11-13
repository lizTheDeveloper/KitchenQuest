// M7 Step 11: writes utterance.wav, the clip Chromium's fake microphone plays in the voice e2e. A synthetic,
// tone-shaped "utterance" (no human voice): 0.5 s of silence, then 1.6 s of syllable-like bursts (a 180 Hz voiced tone
// with two formant-like partials, each burst shaped by a smooth envelope), then 0.9 s of silence. 16 kHz mono PCM16.
// Run: node apps/game/e2e/fixtures/voice/make.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RATE = 16_000;
const seconds = 3;
const pcm = new Int16Array(RATE * seconds);
for (let i = 0; i < pcm.length; i++) {
  const t = i / RATE;
  if (t < 0.5 || t > 2.1) continue;
  const s = (t - 0.5) % 0.2; // one 200 ms syllable
  const env = s < 0.16 ? Math.sin((Math.PI * s) / 0.16) : 0;
  const v = Math.sin(2 * Math.PI * 180 * t) * 0.6 + Math.sin(2 * Math.PI * 720 * t) * 0.25 + Math.sin(2 * Math.PI * 1260 * t) * 0.15;
  pcm[i] = Math.round(v * env * 0.5 * 32767);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.byteLength, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.byteLength, 40);
writeFileSync(fileURLToPath(new URL('./utterance.wav', import.meta.url)), Buffer.concat([header, Buffer.from(pcm.buffer)]));
