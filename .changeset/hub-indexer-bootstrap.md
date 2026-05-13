---
'@inferenceroom/pico-protocol': patch
'@inferenceroom/pico-sdk': patch
---

fix(hub): bootstrap unknown channels from `ChannelOpened` events

Round-2 mainnet smoke (HIGH finding #1, issue #100) showed the hub
chain-watcher only updated channels already in the pool on `ChannelOpened`.
Newly-opened channels were never registered, so the WS envelope check —
which builds known-signers from `channelPool.list()` — rejected every
legitimate first message from a fresh channel's party with
"`signer … not a known channel party`", and `pico channel open` then
errored with `subscribe timed out`.

The watcher now registers the channel into the pool when `ChannelOpened`
fires for an unknown channelId, using event-emitted
`userA`/`userB`/`token`/`amountA`/`amountB` and the block timestamp for
`openedAt`. Post-bootstrap, the WS handshake succeeds normally.

Hub-only change; no SDK/protocol API surface impact. The patch bumps here
exist only so the deploy-relevant package list in `release.yml` cuts a
new `v*` tag for the GKE image pipeline to pick up.
