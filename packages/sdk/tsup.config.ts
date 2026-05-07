import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: true,
  treeshake: true,
  external: [
    '@inferenceroom/pico-protocol',
    '@noble/hashes',
    'tweetnacl',
    'viem',
    'ws',
    'fake-indexeddb',
    'happy-dom',
  ],
  noExternal: ['@inferenceroom/pico-state-machine'],
});
