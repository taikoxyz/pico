# Security policy

## Status

Tainnel is **pre-launch**. Until the first signed mainnet release, treat this
project as research-grade software: do not custody production funds with it,
and assume APIs and on-chain interfaces will change.

## Reporting a vulnerability

Please report suspected security issues **privately**. Do not open a public
issue. Two channels, in order of preference:

1. **GitHub private vulnerability advisory** —
   <https://github.com/dantaik/tainnel/security/advisories/new>. From the CLI:
   `gh api -X POST repos/dantaik/tainnel/security-advisories -f summary=...`.
   This routes to the maintainers without disclosing the report publicly and
   triggers a notification immediately.

2. **Encrypted email** to `security@taiko.xyz` with PGP. Fingerprint:
   `<TAINNEL_PGP_FINGERPRINT_TODO>`. Until that marker is replaced with a real
   fingerprint and `pgp-key.asc` exists at the repo root, **PGP-encrypted
   email is not yet accepted — use the GitHub advisory channel above.** See
   [`docs/runbooks/security-disclosure.md`](docs/runbooks/security-disclosure.md)
   for the operator setup that retires this caveat.

## What to include in your report

- Affected component (path or package name).
- Steps to reproduce.
- Expected behaviour vs observed behaviour.
- Deployment context (mainnet / testnet / local Anvil).
- Severity estimate and reasoning.
- Reporter contact info and whether you would like credit in the hall of fame.

## Response SLA

| Phase | Target |
|---|---|
| Acknowledgement of report | 24 hours |
| Triage decision (severity + owner + patch ETA) | 72 hours |
| Status updates during fix | Weekly |
| Patch shipped: critical | 7 days |
| Patch shipped: high | 30 days |
| Patch shipped: medium | 90 days |
| Patch shipped: low | Next release |

If a deadline slips we will notify the reporter and, where appropriate,
coordinate an extended embargo.

## Scope

In scope:

- Smart contracts under `packages/contracts/src/` once deployed.
- Logic in `@tainnel/state-machine` and `@tainnel/sdk` that affects fund safety.
- Hub and watchtower services in `apps/hub` and `apps/watchtower`.
- The agent runtime CLI in `apps/cli`, including the encrypted hot key file
  format.

Out of scope (in the bootstrap):

- Documentation typos and dead links.
- Phase 2 components not yet built (wallet UI, ERC-8004 integration, EIP-7702
  delegation, TEE / KMS Signer backends, multi-hub failover).

## Disclosure

We will coordinate disclosure with the reporter. Default embargo is **90
days**, negotiable in writing. Public release goes out via:

- The GitHub Security Advisory (which becomes public on coordinated release).
- A tagged version + release notes.
- An entry in [`SECURITY_HALL_OF_FAME.md`](SECURITY_HALL_OF_FAME.md) with
  reporter consent.
- A CVE if the vulnerability qualifies (deployed contracts, fund-loss vectors,
  signature-validation bugs typically do).

## Bounty

Tainnel does **not** run a paid bug bounty program at v1. Reporters are
credited in release notes and `SECURITY_HALL_OF_FAME.md`. Post-launch,
critical-severity reports may be retroactively rewarded subject to board
approval. Do not assume payment; report because it is the right thing to do.

## Maintainer rotation

Current on-call: **@dantaik** (sole maintainer per `CODEOWNERS`). GitHub
private advisory creation auto-notifies this account. Paging configuration
for additional maintainers lives in
[`docs/runbooks/security-disclosure.md`](docs/runbooks/security-disclosure.md).
