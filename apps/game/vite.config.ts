import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { kqContent } from './build/content-plugin';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  base: '/',
  plugins: [kqContent({ repoRoot })],
  server: { port: 5173, fs: { allow: [repoRoot] } },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1600, // Phaser alone is ~1.2 MB minified
    rollupOptions: {
      output: {
        // Keep Phaser in its own chunk so game-code changes don't bust its cache.
        manualChunks: (id) => (id.includes('node_modules/phaser') ? 'phaser' : undefined),
      },
    },
  },
});
