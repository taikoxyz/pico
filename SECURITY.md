# Security policy

## Status

Tainnel is **pre-launch**. Until the first signed mainnet release, treat this
project as research-grade software: do not custody real funds with it, and assume
APIs and on-chain interfaces will change.

## Reporting a vulnerability

Please report suspected security issues **privately**. Do not open a public issue.

Preferred channel:

- **GitHub private vulnerability advisories** at
  https://github.com/<your-org>/tainnel/security/advisories/new — `gh advisory create`
  also works from the CLI. This routes to the maintainers without disclosing the
  report publicly.

Backup channel (interim, until a monitored mailbox is provisioned):

- Email a maintainer directly via the contact information in the repository
  `CODEOWNERS` file or the most recent release notes. The `security@tainnel.dev`
  inbox referenced previously is **not** monitored yet.
- A PGP key will be published alongside the first signed release. Until then,
  encrypt sensitive details with a per-maintainer key out-of-band when possible.

We aim to acknowledge within 72 hours when a maintainer is on-rotation.
Acknowledgement SLAs will become firmer once on-call routing is in place.

## Scope

In scope:

- Smart contracts under `packages/contracts/src/` once deployed.
- Logic in `@tainnel/state-machine` and `@tainnel/sdk` that affects fund safety.
- Hub and watchtower services in `apps/hub` and `apps/watchtower`.
- The agent runtime CLI in `apps/cli`, including the encrypted hot key file
  format.

Out of scope (in the bootstrap):

- Documentation typos, dead links.
- Phase 2 components not yet built (wallet UI, ERC-8004 integration, EIP-7702
  delegation, TEE / KMS Signer backends, multi-hub failover).

## Disclosure

We will coordinate disclosure with reporters. A 90-day default embargo is
reasonable for bugs that affect deployed contracts.
