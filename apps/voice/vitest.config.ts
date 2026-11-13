import { defineConfig } from 'vitest/config';

// Forks, not threads: the memory-only test (C-18) changes the working directory, TMPDIR and HOME, which a worker
// thread may not do. Each test file gets its own process, so nothing it changes reaches another file.
export default defineConfig({
  test: { pool: 'forks', testTimeout: 30_000, hookTimeout: 30_000 },
});
