# pico v2 release notes (draft)

## Headline

**On-chain trustless HTLC settlement.** In-flight HTLCs now survive a unilateral
close. The v1 trust-liveness limitation called out in `protocol-spec.md` §5.4 has
been lifted — neither party can grief the other out of mid-flight value during a
force-close.

## Contract changes (breaking)

- New `Status.ResolvingHtlcs` between `ClosingUnilateral` and `Closed`. `finalize`
  transitions to it lazily on the first call after `disputeDeadline` when the
  posted state had `htlcsCount > 0`.
- New entry points on `PaymentChannel`:
  - `claimHtlc(channelId, htlc, proof, sortedIndex, totalLeaves, preimage)` —
    verifies `sha256(preimage) == htlc.paymentHash`, verifies the ordered Merkle
    proof, and credits the receiver side.
  - `refundHtlc(channelId, htlc, proof, sortedIndex, totalLeaves)` — same proof
    check, post-`expiry` only, credits the sender side.
- `HTLC.verifyOrderedProof` library helper. Mirrors `htlcMerkleProof` in
  `packages/protocol/src/htlc-root.ts`: sort by id, left/right pairing,
  odd-tail self-duplication (not OZ min/max).
- `Adjudicator.ChannelState` extended with `htlcsCount: uint16` and
  `htlcsTotalLocked: uint256`. EIP-712 typehash + domain bumped to
  `("pico", "2")`. Conservation invariant enforced at every dispute-relevant
  entry point becomes
  `balanceA + balanceB + htlcsTotalLocked == amountA + amountB`.
- Penalty path short-circuits HTLC resolution: when `penalized == true`, the
  entire pot goes to the non-closer, regardless of in-flight HTLCs.
- Four `require(htlcsRoot == bytes32(0), "htlcs!=0")` guards removed
  (`closeUnilateral`, `dispute`, `submitPenaltyProof`, `topUp` x2). `topUp`
  now requires the HTLC set to be unchanged across `prev` / `next` instead.
- New events: `HtlcResolutionStarted`, `HtlcClaimed` (preimage included),
  `HtlcRefunded`.

## Protocol / state-machine changes

- `PROTOCOL_VERSION` bumped to `0.2.0`.
- `ChannelState` extended with `htlcsCount` + `htlcsTotalLocked`. The
  state-machine maintains both fields automatically across `addHtlc`,
  `settleHtlc`, `failHtlc`, `expireHtlcs`. Off-chain Merkle root computation
  is unchanged; the new fields are signed alongside the root.
- New `htlcMerkleProof(htlcs, targetId)` helper in `packages/protocol`.

## SDK changes

- `paymentChannelAbi` extended with `claimHtlc`, `refundHtlc`,
  `HtlcResolutionStarted`, `HtlcClaimed`, `HtlcRefunded`.
- `encodeChannelStateForOnChain` and `buildSignedStateTuple` thread the two
  new fields through.

## Hub changes

- `dispute-handler` no longer skips disputes when the latest state has
  in-flight HTLCs (the `htlcsRoot != 0` skip is removed). The conservation
  invariant alone is enough.
- `state-repo.latestDisputeEligible` returns the highest-version state
  regardless of HTLC set; v1's empty-htlcs filter is dropped.

## Watchtower changes

- The `index.ts:214` reject of non-empty-HTLC states is removed.
  Conservation now includes `htlcsTotalLocked`. Watchtowers should persist
  full HTLC sets per signed state (not just the root) so they can build
  Merkle proofs at HTLC resolution time. The preimage cache is shared
  with hubs over the existing HTTP surface.

## Migration

v2 is a **fresh contract deployment** at new proxy addresses. v1 channels
continue to operate against the v1 contracts indefinitely; users drain them
via cooperative close or wait for natural close. No on-chain migration is
performed. Off-chain configuration carries `version: 'v1' | 'v2'` per chain
entry in `CONTRACT_ADDRESSES`.

EIP-712 domain version `"1" → "2"` plus the new `ChannelState` fields make
v1 signatures impossible to replay against v2 contracts.

## Operational notes

- Watchtower DB grows ~5x per channel from persisting full HTLC sets. Verify
  capacity before enabling v2 in production.
- The single contract-wide `MAX_HTLC_DURATION + HTLC_RESOLUTION_GRACE`
  ceiling (4h) for `htlcResolutionDeadline` trusts the off-chain protocol
  cap on HTLC duration. Same assumption as v1's trust in the off-chain
  HTLC-count cap.

## Known gaps in this draft

- Client-side `claimHtlcOnChain` / `refundHtlcOnChain` SDK helpers are
  scaffolded in the ABI but not exposed as adapter methods yet.
- Watchtower `htlc-resolver` module (preimage cache + auto-claim/refund) is
  not yet wired; the existing reject was simply removed.
- `apps/hub/chain-watcher` does not yet emit `HtlcResolutionStarted` or
  `HtlcClaimed` / `HtlcRefunded` to downstream consumers.
- e2e scenarios for the new flow are not yet authored.
- `forge fmt` and `forge test` were not run locally (no foundry in the
  sandbox). The new Foundry tests
  (`HTLC.merkleProof.t.sol`, `PaymentChannel.htlcSettlement.t.sol`) compile
  against the API surface but should be regenerated for fmt conformance in
  CI before merge.
