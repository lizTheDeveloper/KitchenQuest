import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { kqContent } from './build/content-plugin';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  // Unit tests may import the real compiled content through `virtual:kq-content`.
  plugins: [kqContent({ repoRoot })],
  test: { include: ['src/**/*.test.ts', 'build/**/*.test.ts'] },
});
