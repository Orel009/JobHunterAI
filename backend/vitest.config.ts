import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    env: { DATA_DIR: 'data/test', PACE_MIN_MS: '0', PACE_MAX_MS: '0', LOG_LEVEL: 'warn', HEADLESS: 'true' },
  },
});
