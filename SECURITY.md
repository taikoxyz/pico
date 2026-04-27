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
- Logic in `@tainnel/state-machine` that affects fund safety.
- Hub and watchtower services in `apps/hub` and `apps/watchtower`.

Out of scope (in the bootstrap):

- The reference wallet UI under `apps/wallet-ui` — pre-production, design only.
- Documentation typos, dead links.

## Disclosure

We will coordinate disclosure with reporters. A 90-day default embargo is reasonable
for bugs that affect deployed contracts.
