# Compliance posture

Pico provides the rails for off-chain payment channels secured on Taiko; it does
not impose user KYC, screen counterparties, or perform regulated activity on
behalf of operators. **Pico provides the rails; operators carry the compliance
burden.** This document is informational, not legal advice. Every operator
deploying a pico hub MUST consult counsel in their jurisdiction before
custodying user funds.

## 1. Asset compliance

Pico v1 supports two settlement assets, gated by `setTokenAllowed` on
`PaymentChannel` (see `packages/contracts/src/PaymentChannel.sol`):

- **ETH** — native asset on Taiko. No issuer, no blocklist, no pause. The only
  failure modes are protocol-level (chain liveness, gas).
- **USDC** — Circle-issued regulated stablecoin (Taiko-bridged variant).
  Circle retains the legal and technical ability to:
  - **Blocklist** any address. A blocklisted address can neither send nor
    receive USDC. If the hub hot wallet is blocklisted, every USDC channel
    settling through that wallet freezes until the blocklist is lifted.
  - **Pause** USDC transfers globally during an incident.
  - **Mint / burn** to enforce regulatory orders.

### Graceful-failure behaviour today

USDC channels follow the push-pattern: settlement requires the hub to call
`PaymentChannel.close` / `closeBatch` and receive USDC into its hot wallet.
A Circle pause or hub-wallet blocklist freezes settlement until Circle
unpauses or unblocks. Funds remain accounted for on-chain (the
`PaymentChannel` contract balance is not at risk) but participants cannot
withdraw. See PR #127 findings **U-01** and **U-02**.

### Planned mitigation (v2.1)

The pull-pattern channel close (tracked in the v2.1 spec, PR #127 §6.2)
lets each participant pull their own settled balance directly from the
contract, removing the hub hot wallet as a chokepoint for blocklist /
pause events. Until v2.1 ships, operators MUST disclose this asset risk to
users in their terms of service.

## 2. OFAC and sanctions screening

**Pico does not screen addresses.** The hub admit-gate
(`apps/hub/src/router.ts`) accepts any well-formed channel open request.

Operators are responsible for sanctions compliance in their jurisdiction.
Recommended controls before opening a hub to the public in regulated markets:

- Integrate an address-screening service at the admit-gate. Common vendors:
  Chainalysis Address Screening, Elliptic Lens, TRM Labs.
- Cross-reference the OFAC SDN list, EU sanctions list, UK OFSI list, and any
  local lists applicable to the operator's jurisdiction.
- Log screening decisions for audit; do not silently drop. The audit trail
  is required if regulators ask for evidence of controls.

A reference middleware shim is **not** provided by pico v1. Operators MUST
build the integration themselves, behind the WebSocket admit-gate and the
operator REST `/v1/channels/open` endpoint.

## 3. Money transmission, MTL, MSB, VASP

A pico hub operator acts as a custodial relay for stablecoin (and ETH)
payments between counterparties. The hub holds user funds in the
`PaymentChannel` contract while channels are open and routes payments
off-chain. Most regulators treat this posture as **money transmission** or
its local equivalent.

Indicative posture per jurisdiction (NOT legal advice — verify with counsel):

| Jurisdiction | Likely regime | Notes |
|---|---|---|
| US (federal) | MSB registration with FinCEN | Stablecoin transmission generally triggers MSB status. |
| US (state)   | Money Transmitter Licenses (MTLs) | Required in most states for custodial stablecoin flows. NY BitLicense applies in NY. |
| EU           | MiCA CASP authorisation | "Crypto-asset service provider" — custody + transfer of e-money tokens. |
| UK           | FCA cryptoasset registration | Money-laundering regulations apply. |
| Singapore    | PSA DPT licence | Major Payment Institution licence for stablecoin services. |
| Japan        | FSA crypto-asset exchange registration | High bar; expect 12-18 month process. |

**Each operator MUST seek local counsel before custodying real user funds.**
The pico maintainers do not, and cannot, provide regulatory guidance.

## 4. User KYC / customer due diligence

Pico imposes **no** KYC requirement. Channels open with a signature; no
identity is collected or verified by the protocol.

Operators MUST decide their KYC posture per jurisdiction:

- Most MSB / MTL / CASP regimes require **CIP** (customer identification),
  **CDD** (customer due diligence), and ongoing **transaction monitoring**.
- Tiered KYC (e.g. low-volume anonymous tier + verified higher-volume tier)
  is common but each tier must be defensible.
- KYC data, if collected, must be stored and retained per local privacy law
  (see §6).

Integration point: the hub admit-gate
(`apps/hub/src/router.ts`, channel-open path). Operators add their KYC
check there.

## 5. Tax reporting hooks

Pico emits **informational** payment receipts on every successful payment
(see the `payments` and `signed_states` tables in the hub SQLite store;
schema in `apps/hub/src/storage.ts`). Receipts contain:

- Channel ID, payer, payee, token, amount, timestamp.
- Latest signed state version.

These are sufficient inputs for the operator to compute their tax
reporting obligations (e.g. US Form 1099-K, 1099-MISC, 1099-DA; EU DAC8;
UK Cryptoasset Reporting Framework). **1099 / DAC8 / CARF reporting is
the operator's responsibility.** Pico does not file forms on the operator's
behalf and does not produce regulator-ready exports.

Export path: `sqlite3 hub.sqlite "SELECT ... FROM payments WHERE ..."`,
then transform into the operator's reporting pipeline.

## 6. Data retention and privacy

The hub stores channel and payment history **indefinitely** by default
(see `apps/hub/src/storage.ts`). There is no built-in retention policy.

Operators MUST define retention windows that comply with:

- **GDPR** (EU): minimisation principle; right to erasure; lawful basis
  for processing personal-data-adjacent fields (IP addresses, signing
  keys linked to identity).
- **CCPA / CPRA** (California): right to delete, right to know.
- **Local law** in every jurisdiction the operator serves.

Practical guidance:

- Define a retention window per data class (channel metadata vs payment
  receipts vs operator logs).
- Document the legal basis for each class.
- Implement an automated purge job; do not rely on manual deletion.

The hub will gain a retention-policy knob in v2.x; tracked under the
operations backlog.

## 7. Bug bounty and safe harbour

See [`SECURITY.md`](SECURITY.md). Pico does not run a paid bounty at v1;
post-launch retroactive rewards may be approved by the board.

Reporters acting in good faith — testing on testnet or against their own
deployments, disclosing privately, not exfiltrating data beyond what is
needed to demonstrate impact — are **safe-harboured** from civil action by
the pico maintainers. Operators who fork or redeploy pico are encouraged
to adopt an equivalent policy; the maintainers cannot bind operators to
the safe harbour.

## 8. Disclosure process

See [`SECURITY.md`](SECURITY.md) and
[`docs/runbooks/security-disclosure.md`](docs/runbooks/security-disclosure.md)
for the disclosure flow, embargo defaults (90 days), CVE process, and the
maintainer paging rotation.

## Operator checklist (pre-mainnet)

- [ ] Counsel engaged for the operator's jurisdiction(s).
- [ ] MSB / MTL / CASP / equivalent registrations filed where required.
- [ ] Sanctions-screening vendor integrated at the admit-gate.
- [ ] KYC posture documented; CIP / CDD implemented if required.
- [ ] Tax-reporting export pipeline implemented and tested.
- [ ] Retention policy documented and enforced.
- [ ] Terms of service disclose USDC pause / blocklist risk (U-01, U-02).
- [ ] Incident-response runbooks (see `docs/runbooks/`) drilled.
