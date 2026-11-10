// Draws the PWA icons from the Pan sprite: the sprite centred on a cast-iron (--iron) square, scaled by a
// whole number with smoothing off, so the pixels stay square. Run once (`npm run icons -w @kitchenquest/game`)
// and commit the PNGs. Uses the pre-installed Chromium; no network.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// The drawing runs in the page.
/* global document, Image */

const repo = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const out = (p) => fileURLToPath(new URL(`../public/icons/${p}`, import.meta.url));

// The art agent's Pan wins over the prototype's (see build/assets/manifest.ts: pan_neutral is char.pan).
const SOURCES = ['art/characters/pan.png', 'art/characters/pan_neutral.png', 'prototype/art/pan.png'];
const source = SOURCES.find((p) => existsSync(repo(p)));
if (!source) throw new Error(`No Pan sprite found in ${SOURCES.join(', ')}`);

const IRON = '#1e1b1d';
// [file, canvas size, scale]. The maskable icon keeps the sprite inside the central safe circle (80%).
const ICONS = [
  ['icon-192.png', 192, 2],
  ['icon-512.png', 512, 6],
  ['maskable-512.png', 512, 4],
  ['apple-touch-icon.png', 180, 2],
];

const dataUrl = `data:image/png;base64,${readFileSync(repo(source)).toString('base64')}`;
mkdirSync(out(''), { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [file, size, scale] of ICONS) {
    const png = await page.evaluate(async ({ src, size, scale, iron }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = iron;
      ctx.fillRect(0, 0, size, size);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, Math.floor((size - w) / 2), Math.floor((size - h) / 2), w, h);
      return canvas.toDataURL('image/png');
    }, { src: dataUrl, size, scale, iron: IRON });
    writeFileSync(out(file), Buffer.from(png.split(',')[1], 'base64'));
    console.log(`${file}: ${size}×${size}, ${source} ×${scale}`);
  }
} finally {
  await browser.close();
}
