import { defineConfig } from 'vitest/config';

// Task 9 fix round 1 (review flakes): an explicit budget that matches the work. These are integration tests against
// real Postgres; a timeout should catch a hang, not measure how busy the machine is (vitest's default is 5 s).
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 60_000 },
});
