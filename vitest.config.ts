import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{shared,core,server,extension,cli}/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
