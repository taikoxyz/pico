---
'@inferenceroom/pico-protocol': patch
'@inferenceroom/pico-sdk': patch
---

Round-4 hotfix — restart-safe sentinel signatures.

**hub (CRITICAL)**: the chain-watcher and topup-handler defined
`SENTINEL_SIG` with `r: EMPTY_SIG_BYTES, s: EMPTY_SIG_BYTES` — but a
`Signature.r`/`s` is 32 bytes, while `EMPTY_SIG_BYTES` is the full
65-byte sig blob. Serializing this sentinel via `signatureToHex`
produced a 264-character all-zero hex string that was persisted into
the hub's `signed_states` table by the v2.1.2 chain-watcher bootstrap
path. On the next pod restart, `StateRepo.loadAllLatest` called
`hexToSignature` on those rows and threw
`Error: expected 65-byte hex signature, got length 264`,
crash-looping the hub.

Fixes: `SENTINEL_SIG` in both `chain-watcher.ts` and `topup-handler.ts`
now use proper 32-byte zero `r`/`s`. `hexToSignature` (in
`@inferenceroom/pico-sdk`) tolerates the legacy 264-char all-zero blob
as a sentinel so previously-persisted rows hydrate without throwing.
