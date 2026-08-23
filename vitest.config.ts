import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // Keep pipeline logging out of the test output; failures still surface.
    env: { SIFT_LOG_LEVEL: 'error', SIFT_DRY_RUN: '1', SIFT_DB_PATH: ':memory:' },
  },
});
