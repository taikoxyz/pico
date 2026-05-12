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

## Audit remediation (high + medium findings)

A three-agent audit (Solidity security, TS↔Solidity consistency,
integration quality) ran against this branch and surfaced 5 High and
6 Medium findings. All have been remediated in this PR:

| Severity | Issue | Resolution |
| --- | --- | --- |
| High | `htlcResolutionDeadline` set but never enforced — malicious far-future expiry could deadlock `finalize` | `refundHtlc` now accepts post-`htlcResolutionDeadline` regardless of `htlc.expiry`; force-refund path closes the DoS |
| High | `htlc.direction > 1` silently routed to userA in payout ternaries | `_verifyHtlcMembership` rejects with `"direction"` revert |
| High | `closeUnilateralFromOpen` did not guard `htlcsCount == 0` | Added `require(ch.htlcsCount == 0, "htlcs at open")` (defense-in-depth) |
| High | SDK `ChainAdapter` exposed neither `claimHtlc` nor `refundHtlc` | Added types + viem implementations + mock fallback |
| High | Hub `chain-watcher` blind to `HtlcResolutionStarted` / `HtlcClaimed` / `HtlcRefunded` | New event subscriptions; status flips to `'resolving-htlcs'` on the first event |
| High | Watchtower had no resolver, only the `htlcs!=0` reject was removed | New `htlc-resolver.ts` module + preimage cache table + `POST /v1/preimage` endpoint + event-driven invocation from `index.ts` |
| Medium | `reinitializeV2` skip leaves `minChannelAmount` at 0 | NatSpec warning expanded; `Deploy.s.sol` upgrade path documented |
| Medium | `HtlcClaimed` preimage leak undocumented in contract NatSpec | Privacy block added above the event declaration |
| Medium | `scenarios.fork.test.ts` used the v1 11-field `channels()` ABI | Refreshed to the 19-field v2 layout |
| Medium | `admitSignedState` did not validate `htlcsCount == htlcs.length` or `htlcsTotalLocked == Σ amount` | Added `HTLC_DERIVED_MISMATCH` guard before signature verification |
| Medium | `validateUpdate` did not enforce the v2 conservation invariant using the derived field | Added `balanceA + balanceB + htlcsTotalLocked` check alongside the existing `computeBalance` guard |
| Medium | Watchtower DB growth from full HTLC-set persistence undocumented | Sizing note in `apps/watchtower/README.md`; release notes call out retention guidance |
| Medium | No e2e force-close-with-HTLCs coverage | Two scenarios in `e2e/src/scenarios.test.ts`: claim with preimage + refund after expiry |

The v1 "Known gaps" section that previously called these out is intentionally
removed — they are no longer gaps. Future work (PTLCs, additional
multi-token-pair watchtower scaling) tracked in `docs/protocol-spec.md` §10.

## Verification

- `forge fmt --check` clean.
- `forge test` 181/181 passing (179 prior + 2 new for the H1/H2 audit fixes).
- TS workspace typecheck clean.
- `pnpm test` across `protocol` (20/20), `state-machine` (134/134),
  `sdk` (22/22), `hub` (24/24), `watchtower` (recovery 14/14 + new
  `htlc-resolver` 5/5).
- Two new e2e scenarios in `e2e/src/scenarios.test.ts` exercise force-close
  with an HTLC through claim-with-preimage and refund-after-expiry, including
  the second `finalize` call that pays out `pendingPayout{A,B}`.

## Operations

**Watchtower DB sizing**: persisting full HTLC sets per signed-state version
adds ~5× per-channel storage relative to v1. Rough estimate is
500 KB – 1 MB per active channel under heavy use (up to `MAX_HTLCS_PER_CHANNEL`
= 5 in-flight HTLCs, average state churn). Recommend a retention policy
that prunes signed states older than the dispute window once `finalize`
fires (`ChannelFinalized` event). See `apps/watchtower/README.md` for the
recommended SQLite configuration.

**Preimage forwarding**: the watchtower exposes `POST /v1/preimage` when
`preimageAuthToken` is configured. Hubs MUST authenticate with
`Authorization: Bearer <token>`. Payload: `{ paymentHash, preimage }`,
both 0x-prefixed hex. The endpoint stores idempotently keyed on
`paymentHash`; an unknown channel is OK (the resolver will discover it
when `HtlcResolutionStarted` fires).
