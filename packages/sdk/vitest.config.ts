import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    environmentMatchGlobs: [['src/**/*.dom.test.ts', 'happy-dom']],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/_test/**',
        'src/index.ts',
        'src/signer.ts',
        'src/payment.ts',
        'src/contracts-abi.ts',
      ],
      thresholds: {
        lines: 80,
        statements: 80,
      },
    },
  },
});
