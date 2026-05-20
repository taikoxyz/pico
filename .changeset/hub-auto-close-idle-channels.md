---
"@inferenceroom/pico-protocol": patch
---

Hub: auto-close idle channels after no payment for 24h.

A new periodic `AutoCloseSweeper` reclaims liquidity from dormant channels. A channel the hub is a party to with no payment (no new co-signed state) for `HUB_AUTO_CLOSE_AFTER_MS` (default 24h) is closed unilaterally by posting the latest co-signed state on-chain (`closeUnilateral`, or `closeUnilateralFromOpen` for never-used channels), then finalized once the dispute window elapses. Finalize is guarded on the on-chain status and HTLC count so it never flips a client-initiated close into `ResolvingHtlcs` or reverts on an already-`Closed` channel. Enabled by default; disable via `HUB_AUTO_CLOSE_ENABLED=false`. On-chain txs share the hot-wallet mutex with top-ups to avoid nonce collisions.

Adds an operator-gated `GET /v1/channels/closures` endpoint (upcoming idle channels with timing + eligibility, and closed channels) and `auto_close_*` Prometheus counters.

(Bump applies to deploy-relevant packages only — the source change is entirely in `apps/hub` (which is ignored by changesets); the release pipeline only cuts a Docker tag on a sdk/protocol bump, so the protocol + SDK fixed group records the release boundary.)
