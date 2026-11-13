// M7 Step 8: the sizzle, played on release, at once, while the transcript is on its way (§7.7's earcon). Made on the
// device from noise: no file, no request, nothing leaves it.
import { outputContext } from './playback';

const SIZZLE_S = 0.18;

export function sizzle(win: Window): void {
  const ctx = outputContext(win);
  const n = Math.round(ctx.sampleRate * SIZZLE_S);
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * 0.12 * Math.exp((-4 * i) / n);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(ctx.currentTime);
}
