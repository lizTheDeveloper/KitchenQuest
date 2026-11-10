import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { kqAssets } from './build/assets-plugin';
import { kqContent } from './build/content-plugin';
import { kqServiceWorker } from './build/sw-plugin';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: '/',
  plugins: [kqContent({ repoRoot }), kqAssets({ repoRoot }), kqServiceWorker()],
  server: { port: 5173, fs: { allow: [repoRoot] } },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1600, // Phaser alone is ~1.2 MB minified
    rollupOptions: {
      // The service worker is its own entry, served at /sw.js so its scope can be '/'.
      input: { index: here('index.html'), sw: here('src/pwa/sw.ts') },
      output: {
        entryFileNames: (c) => (c.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        // Keep Phaser in its own chunk so game-code changes don't bust its cache.
        manualChunks: (id) => (id.includes('node_modules/phaser') ? 'phaser' : undefined),
      },
    },
  },
});
