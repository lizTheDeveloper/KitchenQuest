import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { kqAssets } from './build/assets-plugin';
import { kqFirstPaintBudget } from './build/budget-plugin';
import { kqContent } from './build/content-plugin';
import { kqCsp } from './build/csp';
import { kqHandsFree } from './build/hands-free-gate';
import { kqSecurityHeaders } from './build/headers-plugin';
import { kqServiceWorker } from './build/sw-plugin';
import { kqVoiceProvider } from './build/voice-provider';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// The M2 API, reached same-origin under /api (production: the reverse proxy does the same). `ws: true`: the M7 voice
// socket (`/api/voice`) goes through it too.
const api = {
  '/api': { target: process.env.KQ_API_ORIGIN ?? 'http://localhost:3000', ws: true, rewrite: (p: string) => p.replace(/^\/api/, '') },
};

// M7 Step 11: the hands-free gate reads the operator's record (apps/voice/bench/latest.json). Only a Vitest run (the
// e2e setup's hands-free build) may point it at the test fixture instead; `npm run build` never sets VITEST.
const handsFreeRecord = process.env.VITEST === 'true' ? process.env.KQ_TEST_HANDS_FREE_RECORD : undefined;

export default defineConfig({
  base: '/',
  // The M7 gates run first, so a refused build fails before any work (Ruling 1, C9, B8).
  plugins: [kqVoiceProvider(), kqHandsFree(handsFreeRecord), kqCsp(), kqContent({ repoRoot }), kqAssets({ repoRoot }), kqServiceWorker(), kqSecurityHeaders(), kqFirstPaintBudget('index')],
  server: { port: 5173, fs: { allow: [repoRoot] }, proxy: api },
  preview: { proxy: api },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1600, // Phaser alone is ~1.2 MB minified
    rollupOptions: {
      // The service worker is its own entry, served at /sw.js so its scope can be '/'.
      input: { index: here('index.html'), verify: here('auth/verify/index.html'), sw: here('src/pwa/sw.ts') },
      output: {
        entryFileNames: (c) => (c.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        // Keep Phaser in its own chunk so game-code changes don't bust its cache.
        manualChunks: (id) => (id.includes('node_modules/phaser') ? 'phaser' : undefined),
      },
    },
  },
});
