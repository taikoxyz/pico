---
'@inferenceroom/pico-cli': patch
---

Switch cli build to tsup; bundle all `@inferenceroom/pico-*` workspace deps into `dist/index.js`. Published cli now has runtime deps only on true externals (`commander`, `viem`, `picocolors`, `pino`, `pino-pretty`, `prompts`, `ws`).
