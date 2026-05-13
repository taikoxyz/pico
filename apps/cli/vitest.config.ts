import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'test/**'],
      // Integration code in commands/{channel,keys,channel-close-from-open}.ts
      // action handlers exercises viem/RPC paths that are validated via live
      // smoke tests (see `.context/smoke-test-log.md`) rather than unit tests;
      // thresholds reflect what's reasonably reachable without spinning up
      // anvil + a mock hub in CI.
      thresholds: { lines: 65, branches: 60, functions: 70, statements: 65 },
    },
  },
});
