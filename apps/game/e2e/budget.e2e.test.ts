// M6 Step 5: the real build's first paint and its market chunk, read from the dist/ e2e/setup.ts builds (exactly what
// `npm run build` ships). First paint is what index.html loads before any dynamic import: its module script and every
// modulepreload (Vite writes one for each chunk the entry statically imports), so that sum is the budget plugin's.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { FIRST_PAINT_TARGET_BYTES, M7_FIRST_PAINT_CAP_BYTES } from '../build/budget-plugin';
import { wsOriginFor } from '../build/csp';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const read = (p: string): string => readFileSync(`${dist}${p.replace(/^\//, '')}`, 'utf8');

/** Lines only a stall file or The Season's Table holds (none is in pan.yaml, forms.yaml or a cook file). */
const STALL_ONLY = ['Price per pound lies; price per serving tells the truth.', 'That onion has made a wise career choice.', 'Local, stored from the autumn harvest'];

describe('the real build (M6 Step 5)', () => {
  test('the real build: first paint ≤ 360 KB and no first-paint chunk carries stall content; the market chunk is lazy and precached', () => {
    expect(existsSync(`${dist}index.html`)).toBe(true);
    const html = read('index.html');
    const entry = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    const preloads = [...html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(entry).toHaveLength(1);
    const firstPaint = [...entry, ...preloads];
    const code = firstPaint.map(read);
    const bytes = code.reduce((n, c) => n + Buffer.byteLength(c), 0);
    console.info(`first paint ${(bytes / 1024).toFixed(1)} KB in ${firstPaint.length} files`);
    expect(bytes).toBeLessThanOrEqual(FIRST_PAINT_TARGET_BYTES);
    // M7 B8: at most 2 KB over Step 7's 357.6 KB, and none of it the voice client (a lazy chunk).
    expect(bytes).toBeLessThanOrEqual(M7_FIRST_PAINT_CAP_BYTES);
    for (const c of code) expect(c.includes('kq-capture')).toBe(false);
    for (const text of STALL_ONLY) expect(code.some((c) => c.includes(text)), text).toBe(false);

    // The market chunk: one file, holding the stalls, never preloaded, and precached by the service worker.
    const market = readdirSync(`${dist}assets`).filter((f) => f.endsWith('.js') && read(`assets/${f}`).includes(STALL_ONLY[0]));
    expect(market).toHaveLength(1);
    expect(market[0]).toMatch(/^market-[\w-]{8}\.js$/);
    const marketCode = read(`assets/${market[0]}`);
    for (const text of STALL_ONLY) expect(marketCode.includes(text), text).toBe(true);
    expect(firstPaint).not.toContain(`/assets/${market[0]}`);
    expect(html.includes(market[0])).toBe(false);
    expect(read('sw.js').includes(`"/assets/${market[0]}"`)).toBe(true);
    const kb = Buffer.byteLength(marketCode) / 1024;
    console.info(`market chunk ${kb.toFixed(1)} KB`);
    expect(kb).toBeGreaterThan(80);
    expect(kb).toBeLessThan(200);
  });

  test("M7 Step 8: the built index.html's CSP has connect-src 'self' and the voice socket's origin, and media-src 'self'; no build holds browser speech", () => {
    const html = read('index.html');
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).toContain(`connect-src 'self' ${wsOriginFor(process.env.KQ_APP_ORIGIN ?? 'http://localhost:4173')};`);
    expect(csp).toContain("media-src 'self'");
    expect(html).not.toContain('%KQ_WS_ORIGIN%');
    // Ruling 1 (C6): Web Speech is dev-only, so no shipped file names it.
    const js = readdirSync(`${dist}assets`).filter((f) => f.endsWith('.js'));
    expect(js.length).toBeGreaterThan(0);
    for (const f of [...js.map((x) => `assets/${x}`), 'sw.js']) expect(read(f), f).not.toMatch(/webkitSpeechRecognition|SpeechRecognition/);
  });
});
