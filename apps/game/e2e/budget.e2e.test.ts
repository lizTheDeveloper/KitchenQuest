// M6 Step 5: the real build's first paint and its market chunk, read from the dist/ e2e/setup.ts builds (exactly what
// `npm run build` ships). First paint is what index.html loads before any dynamic import: its module script and every
// modulepreload (Vite writes one for each chunk the entry statically imports), so that sum is the budget plugin's.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { FIRST_PAINT_TARGET_BYTES } from '../build/budget-plugin';

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
});
