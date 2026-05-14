---
"@inferenceroom/pico-protocol": patch
---

Consolidate readiness reporting into a single `final_readiness_report.html` at the repo root, replacing the eight overlapping readiness / audit / progress / TODO documents. The report is the single source of truth for design, implementation, test, and documentation readiness against Taiko mainnet (chainId 167000) on GKE with ETH + USDC support. Operator-facing launch evidence continues to be recorded in `docs/launch-log.md`. No publishable code changed; this is a documentation-only release boundary so the protocol + SDK (fixed group) CHANGELOGs record the readiness checkpoint.
