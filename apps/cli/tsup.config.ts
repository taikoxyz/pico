import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  shims: false,
  treeshake: true,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __pico_createRequire } from 'node:module';\nconst require = __pico_createRequire(import.meta.url);",
  },
  external: ['commander', 'viem', 'picocolors', 'pino', 'pino-pretty', 'prompts', 'ws'],
  noExternal: [/^@inferenceroom\/pico-/],
  onSuccess: 'chmod +x dist/index.js',
});
