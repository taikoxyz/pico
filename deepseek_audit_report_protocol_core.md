# Protocol Core Audit Report

## Executive summary

The protocol core is not mainnet-ready as written. The highest-risk issue is in `PaymentChannel.dispute()`: any higher-version state signed only by the unilateral closer is accepted, and the closer can create that signature for an arbitrary conserved split. That lets a closer replace the posted state during the dispute phase and drain the channel.

The next readiness blockers are spec/implementation divergence. The frozen spec and threat model describe on-chain HTLC reveal/refund, dual-signed dispute states, cooperative-close signatures over `CooperativeClose`, and dispute-window restart semantics. The contract currently rejects any non-empty `htlcsRoot`, uses finalized `ChannelState` for cooperative close, does not restart the dispute window, and does not enforce that disputes/penalty proofs arrive before the deadline.

EIP-712 domain/typehash consistency is mostly aligned between TypeScript and Solidity for the `Adjudicator` domain, but channel separation and the settlement flows built on those signatures need tightening before funds should be placed at risk.

## Component boundary

Audited scope:

- `packages/contracts`: `PaymentChannel`, `Adjudicator`, `HTLC`, interfaces, deploy scripts, and protocol-core tests.
- `packages/protocol`: shared constants, EIP-712 schemas, HTLC root, protocol types.
- `packages/state-machine`: pure transition helpers, HTLC helpers, signing helpers, oracle tests.
- `docs/protocol-spec.md` and `docs/threat-model.md`.

Out of scope except for incidental search hits: SDK, hub, watchtower, CLI, and learning/plan docs.

## Findings table

| ID | Severity | Area | Finding |
|---|---|---|---|
| PC-01 | Critical | Dispute authorization | `dispute()` accepts a closer-only signature and lets the closer self-author a newer arbitrary split. |
| PC-02 | High | HTLC dispute handling | Spec/threat model promise on-chain HTLC reveal/refund, but `PaymentChannel` rejects non-empty HTLC roots and exposes no settlement path. |
| PC-03 | High | Cooperative close | Wire schema defines `CooperativeClose`, but `PaymentChannel.closeCooperative()` verifies a finalized `ChannelState` instead. |
| PC-04 | High | Penalty proof semantics | 100% slash can be triggered from a single closer signature over a higher-version state; there is no dual-signed accepted-state proof. |
| PC-05 | Medium | Dispute deadlines | Disputes do not restart the deadline as specified, and neither `dispute()` nor `submitPenaltyProof()` checks that the deadline has not passed. |
| PC-06 | Medium | Channel/domain separation | Spec says `channelId` includes the channel contract; implementation omits it while the EIP-712 domain verifies against `Adjudicator`. |
| PC-07 | Medium | Update wrapper | `validateUpdate()` omits `nextState.channelId` enforcement, and on-chain paths accept bare `ChannelState` without `Update` evidence. |
| PC-08 | Medium | Placeholder addresses | Hoodi is listed as supported while Hoodi contract and USDC addresses are `ZERO_ADDRESS`. |
| PC-09 | Medium | UUPS/admin/token allowlist | Owner can upgrade both proxies and alter token allowlist; repo does not prove multisig/timelock ownership or token safety checks. |
| PC-10 | Info | EIP-712 domain | Domain name/version/typehashes are aligned for `Adjudicator`; keep cross-language oracle checks as release gates. |

## Detailed findings

### PC-01: `dispute()` can be used by the closer with a self-signed arbitrary state

Severity: Critical

Evidence file references:

- `packages/contracts/src/PaymentChannel.sol:235-245` accepts `state` and `sigCloser`, checks `s.version > ch.postedVersion`, and requires only `_recoverStateSigner(s, sigCloser) == ch.closer`.
- `packages/contracts/src/PaymentChannel.sol:247-250` then stores the submitted balances as the posted balances.
- `packages/contracts/src/PaymentChannel.sol:305-313` pays `postedBalanceA/postedBalanceB` on finalize when `penalized == false`.
- `packages/contracts/test/PaymentChannel.fuzz.t.sol:81-98` treats arbitrary higher-version, closer-signed dispute states as successful.
- `packages/contracts/test/PaymentChannel.invariant.t.sol:121-139` does the same in the invariant handler.
- `docs/protocol-spec.md:227-228` says the challenge is a strictly newer dual-signed state.
- `docs/protocol-spec.md:85-86` says a `ChannelState` is valid only with both signatures.

Observed behavior:

After Alice unilaterally closes with Bob's signature, Alice remains `ch.closer`. Alice can sign any higher-version `ChannelState` that conserves total funds, set `balanceA` to the full pot, and call `dispute()` with that self-signed state. The contract has no caller restriction and no requirement for Bob's signature on the disputed state.

Impact:

Full channel loss for the non-closer. This defeats the stale-state dispute mechanism and makes the public dispute path unsafe for mainnet funds.

Recommended fix:

Change `dispute()` to require proof that both parties accepted the newer state. The safest contract shape is `dispute(channelId, state, sigA, sigB)` with `_verifyDualSig(ch.userA, ch.userB, state, sigA, sigB)`. If watchtowers submit disputes, they must store both signatures. Do not rely on `msg.sender` as the missing signature because watchtower/relayer submissions are expected.

Tests/checks needed:

- Add a regression where the closer posts a stale state, then attempts to dispute with a higher-version state signed only by the closer and a full-pot split; it must revert.
- Update fuzz/invariant tests so arbitrary closer-only dispute states are rejected.
- Add positive tests for dual-signed disputes from a party and from a third-party watchtower caller.

### PC-02: On-chain HTLC dispute settlement is specified but not implemented

Severity: High

Evidence file references:

- `docs/protocol-spec.md:232-239` specifies receiver preimage claim, expiry refund, and Merkle proof verification against `htlcsRoot`.
- `docs/protocol-spec.md:243-244` says finalization happens after all on-chain HTLC actions resolve.
- `docs/threat-model.md:21-35` describes HTLC double-spend mitigation via on-chain Merkle proof and public preimage reveal.
- `packages/contracts/src/PaymentChannel.sol:24-26` states the implementation assumes `htlcsRoot == bytes32(0)` and rejects in-flight HTLC states.
- `packages/contracts/src/PaymentChannel.sol:178`, `:211`, `:242`, and `:269` reject non-empty `htlcsRoot` in cooperative close, unilateral close, dispute, and penalty proof.
- `packages/contracts/src/HTLC.sol:31-64` has hashing/root/preimage helpers, but there is no public claim/refund/proof function in `PaymentChannel`.
- `packages/contracts/test/PaymentChannel.t.sol:218-225`, `:287-294`, `:411-421`, and `:506-516` pin those reverts.

Observed behavior:

The docs and threat model describe HTLC settlement during disputes. The deployed channel core instead refuses to enter close/dispute/penalty paths with an in-flight HTLC root.

Impact:

If a counterparty disappears while an HTLC is in flight, the documented on-chain recovery path does not exist. Funds may remain unavailable until off-chain cooperation removes the HTLC. The threat model's HTLC double-spend and receiver-reveal mitigations are not true for this contract.

Recommended fix:

Choose one of two paths before mainnet use:

- Implement on-chain HTLC claim/refund with inclusion proof, preimage verification, expiry handling, and finalization gating.
- Or explicitly downgrade v1 to "no channel close while HTLCs are pending", enforce that invariant in all clients/watchtowers/hubs, and update the frozen spec/threat model to remove on-chain HTLC settlement claims.

Tests/checks needed:

- If implementing settlement: add claim/refund unit tests, proof verification tests, duplicate-settlement prevention, expiry boundary tests, and end-to-end close with multiple pending HTLCs.
- If keeping the simplified model: add integration tests that clients never initiate close/dispute while `htlcsRoot != 0`, and update docs as a release blocker.

### PC-03: Cooperative close schema is inconsistent across spec, TypeScript, Adjudicator, and PaymentChannel

Severity: High

Evidence file references:

- `docs/protocol-spec.md:53-54` says both parties sign a `CooperativeClose`.
- `docs/protocol-spec.md:278` defines `CooperativeClose(channelId, finalBalanceA, finalBalanceB, signedAt)`.
- `packages/protocol/src/eip712.ts:46-53` defines the same `COOPERATIVE_CLOSE_TYPES`.
- `packages/contracts/src/Adjudicator.sol:51-58` and `:148-155` define and recover `CooperativeClose`.
- `packages/contracts/src/PaymentChannel.sol:164-181` decodes `finalState` as `Adjudicator.ChannelState`, requires `finalized == true`, and verifies `ChannelState` signatures.
- `packages/contracts/test/PaymentChannel.t.sol:175-186` signs a finalized `ChannelState`, not `CooperativeClose`, for the happy path.

Observed behavior:

The public signing schema and `Adjudicator` support `CooperativeClose`, but the fund-moving contract ignores that schema. A client following the frozen spec and signing only `CooperativeClose` cannot close cooperatively through `PaymentChannel.closeCooperative()`.

Impact:

Cooperative close will fail across correctly spec-compliant clients, causing unnecessary unilateral closes and dispute windows. This is a mainnet-readiness and integration blocker.

Recommended fix:

Either update `PaymentChannel.closeCooperative()` to decode `CooperativeClose` and call `verifyDualCooperativeClose()`, or remove `CooperativeClose` from the v1 wire format and make finalized `ChannelState` the normative cooperative close artifact. Do not keep both as live-but-divergent schemas.

Tests/checks needed:

- Add a contract test using actual `CooperativeClose` signatures if that schema remains normative.
- Add a negative test proving a finalized `ChannelState` cannot be accidentally accepted when `CooperativeClose` is required, or vice versa.
- Keep the TypeScript/Solidity oracle fixture in sync with the chosen schema.

### PC-04: Penalty proof slashes 100% from a single closer signature

Severity: High

Evidence file references:

- `packages/contracts/src/PaymentChannel.sol:21-23` documents a 100% slash.
- `packages/contracts/src/PaymentChannel.sol:254-272` accepts `penaltyState` plus one `signature`, requires only that the recovered signer is `ch.closer`.
- `packages/contracts/src/PaymentChannel.sol:274-280` marks `penalized = true`.
- `packages/contracts/src/PaymentChannel.sol:298-304` sends the full pot to the non-closer on finalize.
- `packages/contracts/test/PaymentChannel.t.sol:452-471` covers the single-closer-signature happy path.
- `docs/protocol-spec.md:85-86` says valid `ChannelState` requires signatures from both parties.
- `docs/threat-model.md:31-35` says transitions and HTLC dispute safety rely on both signatures/public proof.

Observed behavior:

The penalty path treats a higher-version state signed only by the closer as sufficient proof of cheating and applies a full-pot slash. The contract does not prove the non-closer accepted that state, nor does it bind the proof to an `Update` wrapper.

Impact:

This is safe only if every signer never emits a `ChannelState` signature until the state is fully accepted and durably stored by both sides. A leaked draft, proposal, malformed client flow, or signer misuse could become a 100% slash proof. Because the slash is total, this assumption needs to be explicit and mechanically enforced.

Recommended fix:

Require a dual-signed accepted state for penalty proofs, or introduce a distinct `PenaltyProof`/`AcceptedState` typed-data artifact that cannot be confused with proposals. If the design intentionally allows closer-only evidence, document the invariant that clients must never sign bare `ChannelState` drafts and enforce it in signing APIs.

Tests/checks needed:

- Add tests that one-party draft signatures are not slashable if drafts exist in the protocol.
- Add signer API tests proving clients cannot produce a bare `ChannelState` signature outside the accepted-state flow.
- Add docs that explain exactly which signature is penalty-bearing.

### PC-05: Dispute deadline semantics diverge from the frozen spec

Severity: Medium

Evidence file references:

- `docs/protocol-spec.md:59-61` says a dispute replaces the state and restarts the window.
- `docs/protocol-spec.md:227-230` repeats that challenges restart the 24-hour window.
- `docs/protocol-spec.md:243-244` says finalize happens after `now > deadline`.
- `packages/contracts/src/PaymentChannel.sol:221` sets the deadline on unilateral close.
- `packages/contracts/src/PaymentChannel.sol:228-234` explicitly states the deadline is not extended.
- `packages/contracts/src/PaymentChannel.sol:235-252` updates dispute state without checking `block.timestamp < ch.disputeDeadline`.
- `packages/contracts/src/PaymentChannel.sol:259-282` accepts penalty proofs without a deadline check.
- `packages/contracts/src/PaymentChannel.sol:290` finalizes when `block.timestamp >= ch.disputeDeadline`.
- `packages/contracts/test/PaymentChannel.t.sol:345-355` asserts the deadline must not extend.

Observed behavior:

The implementation does not restart the dispute window after a challenge. It also does not reject disputes or penalty proofs after the deadline, as long as no one has finalized yet.

Impact:

The deadline is not the challenge cutoff described by the spec. Watchtower timing assumptions are ambiguous: a late challenge can still mutate the accepted state before finalization, while a no-extension policy leaves no response window after a near-deadline challenge. Combined with PC-01, a closer can self-sign a draining dispute even after the deadline if finalize has not happened.

Recommended fix:

Pick and document one rule:

- Spec rule: require `block.timestamp < disputeDeadline` for disputes/proofs and reset `disputeDeadline = now + DISPUTE_WINDOW` on accepted challenge.
- Bounded-work rule: require `block.timestamp < disputeDeadline`, do not extend, and update spec/threat model to say every watcher must submit the best available state/proof before the original deadline.

Tests/checks needed:

- Add tests for dispute/proof exactly before, at, and after deadline.
- Add tests for whether a successful challenge extends the deadline, matching the chosen rule.
- Add watchtower tests for near-deadline challenge behavior.

### PC-06: `channelId` omits the channel contract despite spec-level contract separation

Severity: Medium

Evidence file references:

- `docs/protocol-spec.md:70` specifies `channelId = keccak256(abi.encode(contract, userA, userB, salt))`.
- `docs/protocol-spec.md:309-310` says replay protection comes from domain version, chainId, and verifyingContract.
- `packages/contracts/src/PaymentChannel.sol:138-139` computes `channelId = keccak256(abi.encode(msg.sender, userB, token, block.timestamp, nonce))`.
- `packages/protocol/src/eip712.ts:55-61` builds the EIP-712 domain from `chainId` and `verifyingContract`.
- `packages/contracts/src/Adjudicator.sol:83-90` sets the verifying contract to the `Adjudicator` proxy, not the `PaymentChannel`.
- `packages/contracts/test/Adjudicator.t.sol:23-30` verifies the EIP-712 `verifyingContract` is the `Adjudicator`.

Observed behavior:

Signatures are scoped to `chainId + Adjudicator + channelId`. The channel ID itself does not include the `PaymentChannel` address, contrary to the spec. If multiple `PaymentChannel` proxies share an `Adjudicator`, the signature domain does not distinguish those channel contracts.

Impact:

Current single-proxy mainnet deployment may be operationally safe, but future deployments, migrations, cloned channels, or test/prod stacks sharing an `Adjudicator` can create replay/collision risk. The implementation also diverges from the frozen protocol spec.

Recommended fix:

Include `address(this)` in the channel ID, or make the EIP-712 verifying contract the `PaymentChannel` that owns funds. If retaining `Adjudicator` as verifier, the channel ID should commit to `PaymentChannel`, participants, token, and salt/nonce.

Tests/checks needed:

- Add a two-`PaymentChannel` same-`Adjudicator` replay test showing signatures from one contract cannot close/dispute the other.
- Add a protocol test pinning the channel ID derivation to the spec.

### PC-07: `Update` wrapper enforcement is incomplete and mostly off-chain

Severity: Medium

Evidence file references:

- `docs/protocol-spec.md:88-91` says `Update(channelId, fromVersion, toVersion, nextState)` proves prev-to-next intent and defends against state-skip attacks.
- `docs/threat-model.md:18-20` lists state-skip as a specific attack against the `Update` wrapper.
- `packages/state-machine/src/channel.ts:18-40` checks `update.channelId`, `fromVersion`, monotonic `toVersion`, `nextState.version`, finalized HTLCs, and balance conservation, but does not check `update.nextState.channelId === update.channelId`.
- `packages/contracts/src/PaymentChannel.sol:201-216`, `:235-245`, and `:259-272` accept bare `ChannelState` signatures for close, dispute, and penalty; they do not require an `Update`.
- `packages/state-machine/src/signing.ts:85-95` exposes direct `ChannelState` typed-data construction.

Observed behavior:

The state-machine can apply an `Update` whose wrapper channel ID matches `prev`, but whose nested `nextState.channelId` points elsewhere. Separately, the on-chain settlement paths never see the `Update` wrapper at all.

Impact:

The state-skip defense is an off-chain convention rather than an enforced invariant. A malformed update can corrupt local channel identity, and any client that signs bare `ChannelState` outside a verified `Update` flow weakens the documented transition-intent guarantee.

Recommended fix:

Add `update.nextState.channelId === update.channelId` and `update.nextState.channelId === prev.channelId` checks. Make the signing API enforce `validateUpdate()` before producing any `ChannelState` signature for the next state, or move settlement-critical proof to an on-chain-verifiable structure.

Tests/checks needed:

- Add a state-machine test where wrapper `channelId` matches `prev` but `nextState.channelId` differs; it must reject.
- Add signer tests proving accepted states originate from validated `Update` wrappers.
- Document which artifacts are safe to sign and which are internal proposals.

### PC-08: Supported Hoodi constants still contain zero/placeholder addresses

Severity: Medium

Evidence file references:

- `packages/protocol/src/constants.ts:11-14` lists mainnet and Hoodi as supported chain IDs.
- `packages/protocol/src/constants.ts:24-27` sets Hoodi `PaymentChannel` and `Adjudicator` to `ZERO_ADDRESS`.
- `packages/protocol/src/constants.ts:41-45` sets Hoodi USDC to `ZERO_ADDRESS`.
- `packages/protocol/src/constants.test.ts:81-85` explicitly pins Hoodi addresses as placeholders.
- `packages/contracts/src/PaymentChannel.sol:101-106` rejects zero `adjudicator_`.
- `packages/contracts/src/PaymentChannel.sol:131-133` rejects zero token/open with ETH disabled.

Observed behavior:

Hoodi is advertised as supported in protocol constants, but its contract and token addresses are placeholders. The contract itself rejects zero addresses, but off-chain consumers can still load these constants and build domains or transactions with a zero verifying contract/token unless guarded elsewhere.

Impact:

Hoodi usage is not ready. The mainnet constants are populated, but supported-chain metadata can mislead SDKs/tests/users into unsafe or failing transactions on Hoodi.

Recommended fix:

Remove Hoodi from `SUPPORTED_CHAIN_IDS` until deployed, or make address lookup return an explicit deployment-missing error instead of `ZERO_ADDRESS`. Add a release gate that every supported chain has non-zero contract and token addresses.

Tests/checks needed:

- Change constants tests so every chain in `SUPPORTED_CHAIN_IDS` has non-zero `PaymentChannel`, `Adjudicator`, and USDC addresses.
- Add a separate fixture for planned-but-unsupported deployments if placeholders are needed.

### PC-09: UUPS/admin/token allowlist risks are not resolved in-repo

Severity: Medium

Evidence file references:

- `packages/contracts/src/Adjudicator.sol:204-205` gates UUPS upgrades by `onlyOwner`.
- `packages/contracts/src/PaymentChannel.sol:343-344` gates UUPS upgrades by `onlyOwner`.
- `packages/contracts/src/PaymentChannel.sol:109-114` lets the owner toggle token allowlist entries.
- `packages/contracts/script/Deploy.s.sol:22-30` initializes both proxies with the deployer as owner and immediately allowlists `USDC_ADDRESS`.
- `packages/contracts/README.md:52-54` states the proxies use one-step `OwnableUpgradeable` and only the owner may authorize UUPS upgrades.

Observed behavior:

The repo-level deployment flow gives a single owner upgrade authority over the verifier and fund-holding channel. The owner can also allow new ERC-20 tokens. The repo does not prove that the mainnet owner is a multisig/timelock, nor does the contract validate token decimals, fee-on-transfer behavior, or canonical token identity beyond the allowlist.

Impact:

This is an admin trust and operational readiness risk. A compromised owner can upgrade fund-moving logic or verifier logic. A mistakenly allowlisted token can break balance conservation assumptions if it is fee-on-transfer, rebasing, non-standard, or wrong-decimal.

Recommended fix:

Before mainnet funds, transfer ownership to a documented multisig/timelock, publish emergency upgrade procedures, and add deployment checks that the allowed token is the intended canonical USDC. Consider a two-step owner and/or upgrade delay for production.

Tests/checks needed:

- Verification needed: confirm current proxy owners and implementation addresses on-chain.
- Add deployment-script assertions for non-zero owner, expected chain ID, expected USDC address, and post-deploy ownership transfer.
- Add tests or runbooks for rejecting fee-on-transfer/non-standard tokens unless explicitly supported.

### PC-10: EIP-712 domain and typehashes are aligned for the Adjudicator verifier

Severity: Info

Evidence file references:

- `docs/protocol-spec.md:255-263` defines domain name `tainnel`, version `1`, chain ID, and `verifyingContract: <Adjudicator address>`.
- `packages/protocol/src/eip712.ts:3-61` implements that domain builder.
- `packages/contracts/src/Adjudicator.sol:83-90` initializes `EIP712Upgradeable` as `("tainnel", "1")`.
- `packages/contracts/test/Adjudicator.t.sol:23-30` checks name, version, chain ID, and verifying contract.
- `packages/protocol/src/eip712.test.ts:34-94` pins domain and type strings.
- `packages/contracts/test/Oracle.t.sol:104-195` and `packages/state-machine/test/oracle.test.ts:105-153` cross-check TypeScript/Solidity digests and HTLC roots.

Observed behavior:

The EIP-712 domain and the four typehash families are intentionally pinned and cross-tested. This is a strong control for signature compatibility.

Impact:

No direct blocker here, aside from the related findings above: the signature domain scopes to `Adjudicator`, cooperative-close schema is not used by `PaymentChannel`, and `channelId` omits the fund-holding contract.

Recommended fix:

Keep the oracle fixture and cross-language tests as mandatory release gates. Extend them after resolving PC-03 and PC-06.

Tests/checks needed:

- Add mainnet/Hoodi fixture coverage for real verifying-contract addresses once all supported deployments are non-zero.
- Add tests proving signatures fail when the wrong verifier address is used.

## Readiness blockers

- Fix PC-01 before any funds are at risk. The current dispute path is unsafe.
- Decide whether v1 supports on-chain HTLC settlement. If yes, implement it; if no, update the frozen spec/threat model and enforce no pending HTLC close paths throughout clients and watchtowers.
- Align cooperative close wire schema with the fund-moving contract.
- Resolve penalty proof semantics so a 100% slash cannot depend on ambiguous one-party draft signatures.
- Resolve deadline semantics and add deadline boundary tests.
- Fix channel/domain separation before deploying additional `PaymentChannel` proxies or reusing an `Adjudicator`.
- Remove placeholder addresses from supported chain metadata or mark those chains unsupported.
- Verify production UUPS owner, implementation addresses, and token allowlist ownership controls.

## Validation notes

Static inspection commands used:

- `rg --files packages/contracts packages/protocol packages/state-machine docs`
- Targeted `rg` searches for HTLC, dispute, EIP-712, `verifyingContract`, `channelId`, cooperative close, deadlines, penalty proof, `Update`, zero addresses, UUPS, admin, and token allowlist.
- `nl -ba` reads of the scoped contracts, protocol/state-machine files, tests, deploy scripts, and the two scoped docs.

Build/test commands were not run. The audit relied on static source and test inspection to avoid creating build artifacts while other workers may be active. Existing tests were inspected and, in several cases, currently pin the unsafe or divergent behavior described above.

Changed file:

- `deepseek_audit_report_protocol_core.md`
