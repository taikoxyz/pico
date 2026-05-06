---
'@inferenceroom/pico-cli': patch
---

`pico --version` now prints the cli, sdk, and protocol versions (read from a generated `src/generated/versions.ts`), so users can tell which protocol/sdk a published cli build was bundled against.
