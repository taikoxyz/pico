# @inferenceroom/pico-test-utils

Shared test helpers: anvil fork bootstrappers, deterministic key fixtures (Alice, Bob,
Charlie, Hub, Watchtower), and a tiny mock-hub for SDK tests. Internal package — not
intended to be installed from npm. The bundled `pico` CLI inlines this code at build
time. The 1.0.0 entry on npm is deprecated.

Used by `packages/state-machine`, `packages/sdk`, `apps/cli` (via `pico dev`), and `e2e/`.
