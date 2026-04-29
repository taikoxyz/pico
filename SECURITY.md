# Security policy

## Reporting a vulnerability

Please report suspected security issues **privately**. Do not open a public issue.

- Email: security@tainnel.dev (placeholder — update before any external announcement)
- Encrypted reports preferred. PGP key will be published alongside the first signed
  release.

We aim to acknowledge within 72 hours and to provide a status update within 7 days.

## Scope

In scope:

- Smart contracts under `packages/contracts/src/` once deployed.
- Logic in `@tainnel/state-machine` and `@tainnel/sdk` that affects fund safety.
- Hub and watchtower services in `apps/hub` and `apps/watchtower`.
- The agent runtime CLI in `apps/cli` once it ships, including the encrypted hot
  key file format.

Out of scope (in the bootstrap):

- Documentation typos, dead links.
- Phase 2 components not yet built (wallet UI, ERC-8004 integration, EIP-7702
  delegation, TEE / KMS Signer backends, multi-hub failover).

## Disclosure

We will coordinate disclosure with reporters. A 90-day default embargo is reasonable
for bugs that affect deployed contracts.
