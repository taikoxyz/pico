# @inferenceroom/pico-cli

## 2.0.1

### Major Changes

- 78d4fdd: release 1.0.1

### Patch Changes

- 78d4fdd: Switch cli build to tsup; bundle all `@inferenceroom/pico-*` workspace deps into `dist/index.js`. Published cli now has runtime deps only on true externals (`commander`, `viem`, `picocolors`, `pino`, `pino-pretty`, `prompts`, `ws`).
- 78d4fdd: `pico --version` now prints the cli, sdk, and protocol versions (read from a generated `src/generated/versions.ts`), so users can tell which protocol/sdk a published cli build was bundled against.
- release 2.0.1

## 1.0.0

### Major Changes

- First release. Built with `tsup`; all `@inferenceroom/pico-*` workspace packages are bundled into `dist/index.js`. Runtime dependencies are limited to true externals: `commander`, `viem`, `picocolors`, `pino`, `pino-pretty`, `prompts`, and `ws`.
