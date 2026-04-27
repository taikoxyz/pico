# P1 — Protocol freeze

**Status:** 🔵 not started
**Blocks:** P2 (contracts), P3 (state machine) — and transitively P4–P7
**Effort:** 2–4 days, mostly your decision-making

## Why this comes first

The wire format and EIP-712 schemas appear in five places: the contracts, the state
machine, the SDK, the hub, and the watchtower. If any of these ship before the format
is locked, we'll either thrash (rewriting code five times) or end up with mismatched
implementations that pass unit tests in isolation but fail in e2e. **Lock it once,
write it down, then build.**

You don't need state-channel expertise to make these calls — every decision below has a
default that is the standard choice for a USDC channel network, and accepting all
defaults is fine.

## Decisions

> Read these once, override any you want, then move on.

### D1.1 Dispute window length
- **Default:** 24 hours
- **Tradeoff:** shorter = faster cooperative-close fallback, snappier UX. Longer =
  more safety margin if your watchtower is briefly down. 24h is the Lightning norm.
- **Why it matters now:** baked into the contract as an immutable constant.
- Decision: ☐ 12h ☐ 24h ☐ 48h ☐ 72h

### D1.2 HTLC hash function
- **Default:** `sha256`
- **Tradeoff:** `sha256` is cheaper for off-chain coordination and matches Lightning,
  which means future DVM/Lightning bridge work is easier. `keccak256` is ~700 gas
  cheaper per HTLC on-chain. We don't expect on-chain HTLC reveals to be common
  (only on dispute), so off-chain ergonomics win.
- **Why it matters now:** baked into the contract.
- Decision: ☐ `sha256` ☐ `keccak256`

### D1.3 HTLC root algorithm (how the set of in-flight HTLCs gets hashed into a state)
- **Default:** sorted-then-`keccak256`-concat (i.e., sort HTLCs by `id`, abi-encode
  each, concat, hash once).
- **Tradeoff:** simple > Merkle for v1 because we expect ≤ 5 in-flight HTLCs per
  channel. A Merkle tree is only useful if we ever need to prove a single HTLC's
  inclusion on-chain without the others, which we don't in the dogfood scope.
- **Why it matters now:** identical algorithm must run in Solidity (`HTLC.rootOf`)
  and TypeScript (`@tainnel/state-machine`).
- Decision: ☐ sorted-keccak ☐ Merkle (more complex, defer)

### D1.4 Minimum channel amount
- **Default:** 1 USDC (1_000_000 = 1 USDC at 6 decimals)
- **Tradeoff:** prevents dust channels that cost more in gas than they're worth to
  open. Higher minimums make the network feel less micropayment-friendly.
- Decision: ☐ 0.5 USDC ☐ 1 USDC ☐ 5 USDC ☐ 10 USDC

### D1.5 Hub fee policy default for v1
- **Default:** 0 (no fee)
- **Tradeoff:** charging a fee in dogfood adds an analytics axis but introduces a
  routing-failure mode (fees > sent amount). For 1–2 month dogfood, run free. The
  `FlatPlusBpsFeePolicy` plumbing already exists — flipping it on later is a config
  change.
- Decision: ☐ 0 ☐ 0.1% + 1 unit (current code default) ☐ custom

### D1.6 Time source for HTLC expiry
- **Default:** on-chain `block.timestamp` (uint64, seconds), off-chain `Date.now()`
  in milliseconds bucketed to seconds before signing
- **Tradeoff:** the only viable choice. Using ms off-chain causes off-by-1000 bugs
  when comparing signed messages to chain timestamps.
- **Why it matters now:** easy to misread the spec and pick ms everywhere; lock it.
- Decision: ☐ accept default

## Implementation tasks

- [ ] `[agent]` Fully populate [`docs/protocol-spec.md`](../protocol-spec.md) sections
      1–7 with concrete normative content based on the locked decisions above. Replace
      every "will be specified here" with actual prose, ABIs, and pseudocode.
      **Acceptance:** every section non-empty; reviewer can read the spec end-to-end
      without external context and understand the wire format.
- [ ] `[agent]` Update `packages/protocol/src/constants.ts`:
      `DEFAULT_DISPUTE_WINDOW_MS`, `DEFAULT_HTLC_EXPIRY_MS`, `DEFAULT_HUB_FEE_BPS`,
      `DEFAULT_HUB_FEE_FLAT`, `MIN_CHANNEL_AMOUNT_USDC` to match D1.1 / D1.4 / D1.5.
      **Acceptance:** values reflect decisions; `pnpm test` still green.
- [ ] `[agent]` Finalize EIP-712 typed-data definitions in
      `packages/protocol/src/eip712.ts`. Add typed-data for `HTLC`, `Update`, and
      `CooperativeClose` in addition to the existing `ChannelState`. Include a
      versioning byte in the domain so future protocol bumps don't replay against v1
      contracts.
      **Acceptance:** types compile; corresponding fixture in
      `packages/state-machine/src/signing.test.ts` exercises every typed-data variant
      with a viem account.
- [ ] `[agent]` Update [`docs/threat-model.md`](../threat-model.md) sections with
      concrete adversary models for each section heading (malicious user, malicious
      hub, etc.). 2–3 paragraphs per section. Reference specific protocol fields.
      **Acceptance:** reviewer can map every threat to a mitigation in the spec.
- [ ] `[review]` You skim the spec and threat model. Ask the agent to push back if
      anything reads wrong against your mental model.

## Done when

- All five decisions in this file have a checked box (or accepted default)
- `docs/protocol-spec.md` and `docs/threat-model.md` have no placeholder text
- `packages/protocol/src/constants.ts` reflects the decisions
- `packages/protocol/src/eip712.ts` covers `ChannelState`, `Update`, `Htlc`,
  `CooperativeClose`
- `pnpm build && pnpm test` green
- Branch merged to main with commit message `feat(protocol): freeze v1 wire format`
