# E2E, Ops, And Documentation Audit Report

## Executive summary

This audit finds the repository is not ready for controlled Taiko mainnet real-money operation. The strongest readiness blockers are fund-safety and operational, not cosmetic:

- The SDK/CLI mainnet path appears to sign channel state with the `PaymentChannel` address as the EIP-712 verifying contract, while the deployed contract verifies through `Adjudicator`. The e2e harness uses `Adjudicator`, so current e2e coverage would not catch this CLI/SDK mainnet mismatch.
- Mainnet-fork e2e support exists in the harness, but no scenario or CI job runs it. Fork mode also does not provision USDC, so it cannot currently exercise the full lifecycle against deployed mainnet contracts.
- The hub restart e2e manually re-registers state after restart and therefore does not prove durable DB hydration or in-flight HTLC recovery. The hub plan explicitly leaves in-flight HTLC rehydration deferred.
- Production/ops defaults remain unsafe: services default to Taiko mainnet RPC and deployed contract addresses with well-known dummy keys, hub signed-envelope auth is off by default, and operator REST auth is absent unless an env var is set.
- Ops/runbooks/backups/monitoring are still planning-only. There are no checked-in runbooks, no `infra/` dashboards, no `fly.toml`, no watchtower Dockerfile, and no litestream integration in the hub image.
- Documentation status and links are materially stale. `ROADMAP.md`, `e2e/README.md`, docs plans, and learning pages disagree about what is implemented, where learning docs live, and what is still blocked.

## Component boundary

In scope:

- `e2e/` harness, scenarios, package config, and README.
- `packages/test-utils/` Anvil helpers and docs.
- `.github/workflows`, branch ruleset metadata, root package/build config.
- `apps/hub` and `apps/watchtower` deployment/config defaults where they affect e2e/ops readiness.
- `README.md`, `SECURITY.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `docs/plans/`, `docs/learning/`, and runbook/operations expectations.
- Limited CLI/SDK evidence where required to evaluate the documented P10 real-money CLI path and the e2e coverage gap.

Out of scope:

- Full contract, SDK, state-machine, hub router, or watchtower code review beyond evidence needed for e2e/ops/docs readiness.
- Remediation changes. This report only records findings.

## Findings table

| ID | Severity | Finding |
|---|---|---|
| EOD-01 | Critical | CLI/SDK mainnet signing domain appears inconsistent with the Adjudicator domain used by contracts and e2e |
| EOD-02 | High | No CI or scenario exercises the real lifecycle on a Taiko mainnet fork |
| EOD-03 | High | Hub restart e2e masks missing durable in-flight HTLC/router rehydration |
| EOD-04 | High | Mainnet services have unsafe defaults: dummy private keys, mainnet RPC/contracts, optional auth |
| EOD-05 | High | Production ops, monitoring, backup, deployment, and incident runbooks are not implemented |
| EOD-06 | Medium | Production DB direction is internally inconsistent across roadmap, plans, code, and ops docs |
| EOD-07 | Medium | CI does not enforce the coverage thresholds claimed in plans/configs |
| EOD-08 | Medium | Security disclosure contact and encryption path are placeholders |
| EOD-09 | Medium | Roadmap/status docs drift from implemented code and P8/P5/P6 plans |
| EOD-10 | Medium | Watchtower docs overstate encrypted-backup/service-mode behavior |
| EOD-11 | Low | README and learning-material links point at a non-existent root `learning/` directory |

## Detailed findings

### EOD-01: CLI/SDK mainnet signing domain appears inconsistent with Adjudicator

**Severity:** Critical

**Evidence file references:**

- `packages/contracts/src/PaymentChannel.sol:71-72` stores an `Adjudicator public adjudicator`.
- `packages/contracts/src/PaymentChannel.sol:323-330` verifies dual signatures by calling `adjudicator.verifyDualSig(...)`.
- `packages/contracts/src/Adjudicator.sol:83-90` initializes the EIP-712 domain inside the `Adjudicator` proxy.
- `e2e/src/harness.ts:449-456` constructs `ChannelClient` with `paymentChannelAddress: h.paymentChannel` but `verifyingContract: h.adjudicator`.
- `apps/cli/src/commands/channel.ts:92-113`, `apps/cli/src/commands/pay.ts:89-130`, and `apps/cli/src/commands/listen.ts:77-110` use `CONTRACT_ADDRESSES[chainId].PaymentChannel` as both the on-chain payment-channel address and the SDK `verifyingContract`.
- `packages/sdk/README.md:25-36` documents the same `verifyingContract: CONTRACT_ADDRESSES[...].PaymentChannel` pattern.
- `apps/cli/test/integration/pay-listen.integration.test.ts:30-32` and `:90-93` use a mock hub with `VERIFYING_CONTRACT = PaymentChannel`, so the CLI integration test does not validate the deployed Adjudicator domain.

**Observed behavior:**

The e2e harness signs against the Adjudicator address, which matches the contract verification path. The CLI and SDK README examples sign against the PaymentChannel address. The mock CLI integration also uses PaymentChannel, so this mismatch can pass local CLI tests.

**Impact:**

Mainnet CLI-generated states may fail on-chain verification during cooperative close, unilateral close, dispute, or penalty paths. In the worst case, an operator may believe they have recoverable signed states, but those states are not accepted by the deployed contracts during a hub outage or stale-state incident. This is a direct fund-safety blocker until fixed or disproven.

**Recommended fix:**

Separate `paymentChannelAddress` from `adjudicatorAddress` everywhere a client is constructed. CLI commands should use `CONTRACT_ADDRESSES[chainId].PaymentChannel` only for `ViemChainAdapter.paymentChannelAddress`, and `CONTRACT_ADDRESSES[chainId].Adjudicator` for `ChannelClient.verifyingContract`. Update SDK docs and mock/dev helpers to make this distinction explicit.

**Tests/checks needed:**

- Add a CLI-driven e2e that opens, pays, and closes through the real contracts, with on-chain verification, not a mock hub only.
- Add a unit/integration assertion that a CLI-signed state verifies through the deployed/forked `Adjudicator`.
- Add a regression test that fails if `PaymentChannel` and `Adjudicator` are accidentally conflated.

### EOD-02: No CI or scenario exercises the real lifecycle on a Taiko mainnet fork

**Severity:** High

**Evidence file references:**

- `e2e/src/harness.ts:61-66` defines `forkUrl` and `forkBlockNumber`.
- `e2e/src/harness.ts:168-170` selects fork mode only when `opts.forkUrl` is set.
- `e2e/src/scenarios.test.ts:53-55`, `:281-285`, `:343-345`, `:474-475`, `:538-540`, and `:605-609` all call `bootE2E()` with no fork options.
- `e2e/src/harness.ts:358-407` has fork mode, but it only sets ETH balances and `fundAndApproveParty()` throws because USDC minting needs impersonation.
- `.github/workflows/ci.yml:141-147` runs `pnpm -F @tainnel/e2e test` and leaves `e2e-fork` as a TODO.
- `docs/plans/08-e2e-and-audit.md:46-58` says Phase 2 should run on an anvil fork of Taiko mainnet.
- `docs/plans/08-e2e-and-audit.md:424-428` still lists a 24h Taiko mainnet fork soak as a done-when item.

**Observed behavior:**

The active suite is a vanilla Anvil lifecycle suite. It deploys fresh local contracts and mock USDC, and it exercises many useful scenarios, but it does not prove deployed Taiko mainnet contract addresses, mainnet USDC behavior, RPC behavior, gas/fee behavior, or forked-state parity.

**Impact:**

The system can pass CI while still failing on the first forked or real-money Taiko mainnet flow. This gap is especially material because docs/plans claim fork-mode readiness is part of P8.

**Recommended fix:**

Add a separate `e2e-fork` suite and GitHub Actions job gated on `secrets.TAIKO_MAINNET_RPC_URL`, with a pinned block and explicit expected deployed contract/USDC addresses. Implement USDC provisioning on the fork via token-whale impersonation or a controlled fork fixture, then run at least open -> route HTLC -> cooperative close, unilateral close -> dispute/finalize, watchtower penalty, and restart recovery.

**Tests/checks needed:**

- `pnpm -F @tainnel/e2e test:fork` or equivalent.
- CI job skipped only when the RPC secret is absent, and required for release/mainnet-readiness branches.
- A 24h fork soak or scheduled fork job before P10.

### EOD-03: Hub restart e2e masks missing durable in-flight HTLC/router rehydration

**Severity:** High

**Evidence file references:**

- `e2e/src/scenarios.test.ts:548-597` is the hub-down recovery scenario.
- `e2e/src/scenarios.test.ts:570-580` restarts the hub and manually calls `reborn.registerChannel(channel, v2 ?? undefined)`.
- `docs/plans/08-e2e-and-audit.md:323-329` describes the same "in lieu of durable DB hydration" behavior.
- `docs/plans/05-hub.md:230-233` explicitly defers `Router.recordInflight()` re-population on startup and says pre-existing in-flight HTLCs would time out and be resolved on-chain.

**Observed behavior:**

The recovery test proves a fresh hub can process a manually re-registered channel/state. It does not prove production restart behavior from the persisted database, and it does not prove queued or in-flight HTLCs survive process death.

**Impact:**

Operators can get a false sense of restart safety. During mainnet operation, a hub crash with in-flight HTLCs may lose routing state, force on-chain resolution, strand payments, or increase stale-state/dispute exposure.

**Recommended fix:**

Implement router/in-flight HTLC hydration from the hub DB on startup. Then rewrite the hub-down e2e to restart against the same DB without manual `registerChannel()` calls, including a receiver-offline queued HTLC across restart.

**Tests/checks needed:**

- Restart e2e with persistent DB path and no manual state injection.
- Restart while an HTLC is queued for an offline receiver; after restart, receiver reconnects and settles.
- DB migration/repository tests proving enough data is persisted to rebuild router in-flight state.

### EOD-04: Mainnet services have unsafe defaults: dummy private keys, mainnet RPC/contracts, optional auth

**Severity:** High

**Evidence file references:**

- `apps/hub/src/config.ts:30-41` defaults `CHAIN_ID` to Taiko mainnet and `HUB_PRIVATE_KEY` to `0x...0001`.
- `apps/hub/src/config.ts:46-60` defaults RPC to `https://rpc.taiko.xyz`, default contract addresses, SQLite DB, and `HUB_REQUIRE_SIGNED_ENVELOPE === 'true'` only when explicitly set.
- `apps/hub/src/config.test.ts:5-13` asserts empty env uses mainnet and `requireSignedEnvelope` is false.
- `apps/hub/.env.example:3-6` shows a known dummy key, Taiko RPC, and SQLite.
- `apps/hub/src/api/index.ts:80-86` allows operator endpoints when `HUB_OPERATOR_TOKEN` is not set.
- `apps/watchtower/src/config.ts:26-46` defaults to mainnet with `WATCHTOWER_PRIVATE_KEY` `0x...0002`.
- `apps/watchtower/.env.example:3-5` documents the dummy watchtower key and Taiko RPC.
- `docs/plans/05-hub.md:221-226` states SDK envelope wrapping is deferred and production should flip `HUB_REQUIRE_SIGNED_ENVELOPE=true` later.

**Observed behavior:**

Starting hub/watchtower with missing env uses mainnet-facing defaults and known keys. Hub auth for signed WS envelopes and operator REST endpoints is opt-in.

**Impact:**

An accidental deployment can connect to Taiko mainnet with well-known private keys, wrong/no auth, and open operator endpoints. Even if dummy keys are unfunded, this pattern is unsafe for a real-money readiness gate and makes configuration mistakes too easy.

**Recommended fix:**

Fail fast on mainnet unless private keys, RPC URL, contract addresses, operator token, and signed-envelope requirement are explicitly configured. Make examples placeholders rather than runnable known keys. Consider `NODE_ENV=production` or `TAINNEL_ENV=production` validation that rejects dummy keys, unauthenticated operator endpoints, and `HUB_REQUIRE_SIGNED_ENVELOPE=false`.

**Tests/checks needed:**

- Config tests that empty env is local/dev-only, not mainnet.
- Production config tests reject dummy keys and missing operator token.
- A CI check or startup assertion that mainnet deployments require signed-envelope auth once SDK support exists.

### EOD-05: Production ops, monitoring, backup, deployment, and incident runbooks are not implemented

**Severity:** High

**Evidence file references:**

- `docs/plans/09-ops.md:3-6` says ops is planning-only.
- `docs/plans/09-ops.md:78-96` lists uncompleted hub deployment/litestream tasks.
- `docs/plans/09-ops.md:97-107` lists uncompleted watchtower deployment tasks.
- `docs/plans/09-ops.md:108-134` lists uncompleted monitoring and alerting tasks.
- `docs/plans/09-ops.md:144-158` lists five required runbooks that are not present.
- Local inspection found no `docs/runbooks/`, no `infra/`, no `fly.toml`, and no watchtower Dockerfile.
- `apps/hub/Dockerfile:13-19` runs `node dist/server.js`; it does not include litestream or a backup entrypoint.
- `apps/hub/docker-compose.yml:1-13` only defines the hub service and volumes.

**Observed behavior:**

The repo has a local/dev hub container path, but the P9 production deployment, monitoring, backup, and incident response surface is still a plan.

**Impact:**

P10 cannot be safely executed. If hub/watchtower crashes, keys are compromised, RPC breaks, backup restore is needed, or a dispute occurs, there is no committed operational path to recover or verify the response.

**Recommended fix:**

Complete P9 before any real-money flow: production deployment manifests, watchtower image, separate-region placement, litestream or selected DB backup, Grafana/Loki or equivalent config, alert rules, and the five runbooks.

**Tests/checks needed:**

- Restore drill from backup to a fresh volume.
- Watchtower-down and hub-down fire drills.
- Test alert delivery.
- Verify hub and watchtower run in separate regions/providers.

### EOD-06: Production DB direction is internally inconsistent

**Severity:** Medium

**Evidence file references:**

- `ROADMAP.md:104-109` says P5 hub DB default is `sqlite + litestream`.
- `docs/plans/05-hub.md:28-35` describes sqlite as default but marks the decision as Postgres.
- `docs/plans/09-ops.md:51-55` says backup strategy default is litestream replicating SQLite to R2.
- `apps/hub/src/config.ts:37-55` defaults to SQLite but supports Postgres.
- `apps/hub/src/config.test.ts:15-19` tests `DB_DRIVER=postgres`.
- `docs/learning/05-hub.html:107-112` teaches SQLite + litestream as the decision.

**Observed behavior:**

Production DB guidance points in multiple directions: roadmap/ops/learning favor SQLite + litestream, P5's checked decision says Postgres, and code defaults to SQLite.

**Impact:**

The operator can deploy with the wrong backup/restore model. This matters because hub state drives routing, disputes, nonce replay protection, and restart behavior.

**Recommended fix:**

Pick one production DB target for P10 and make all docs/configs match it. If Postgres is selected, remove litestream-specific runbook assumptions and add managed Postgres backup/restore drills. If SQLite is selected, make P5's decision match and ship litestream integration.

**Tests/checks needed:**

- Production config fixture for the selected DB.
- Backup restore test for the selected DB.
- Documentation link/checklist update asserting no contradictory DB decision remains.

### EOD-07: CI does not enforce the coverage thresholds claimed in plans/configs

**Severity:** Medium

**Evidence file references:**

- `.github/workflows/ci.yml:60-72` runs `pnpm exec turbo run test --filter='!@tainnel/contracts' --filter='!@tainnel/e2e'`.
- `apps/hub/package.json:16-20`, `apps/watchtower/package.json:9-12`, and `apps/cli/package.json:12-15` all define `test` as `vitest run`, not `vitest run --coverage`.
- `apps/hub/vitest.config.ts:7-10`, `apps/watchtower/vitest.config.ts:7-10`, and `apps/cli/vitest.config.ts:8-13` define coverage thresholds, but Vitest thresholds are only enforced when coverage is enabled.
- `docs/plans/05-hub.md:7-8` and `:161-164` claim hub coverage is a readiness signal.
- `docs/plans/06-watchtower.md:133-135` claims watchtower coverage is enforced.

**Observed behavior:**

Coverage thresholds exist in config, but the CI path runs plain tests. The plans cite coverage as a readiness criterion, but CI does not enforce it.

**Impact:**

Coverage can silently regress while readiness docs continue to claim coverage gates exist. This is not a direct fund-loss issue, but it weakens safety claims around hub/watchtower code.

**Recommended fix:**

Add `test:coverage` scripts for apps that claim coverage gates, run them in CI for readiness-critical packages, or create a separate coverage job required by the aggregator.

**Tests/checks needed:**

- CI should fail if hub/watchtower/CLI coverage drops below configured thresholds.
- Update docs to distinguish measured coverage from enforced CI gates.

### EOD-08: Security disclosure contact and encryption path are placeholders

**Severity:** Medium

**Evidence file references:**

- `SECURITY.md:5-9` asks for private reports but lists `security@tainnel.dev` as a placeholder and says PGP will be published with the first signed release.
- `SECURITY.md:11` commits to a 72-hour acknowledgment.

**Observed behavior:**

The disclosure path is not production-ready. There is no committed evidence that the inbox exists, is monitored, or has usable encryption.

**Impact:**

External researchers and private dogfood users have no reliable confidential path for vulnerability reports. This is a mainnet-readiness/process blocker before external announcements or broader real-money testing.

**Recommended fix:**

Replace the placeholder with a monitored address, publish a PGP key or security.txt equivalent, and document who receives alerts and how reports are triaged.

**Tests/checks needed:**

- Send a test report email and verify receipt/ack path.
- Verify PGP fingerprint and key retrieval.

### EOD-09: Roadmap/status docs drift from implemented code and P8/P5/P6 plans

**Severity:** Medium

**Evidence file references:**

- `ROADMAP.md:38-41` says P5/P6 are partial and P8 is not started with skipped lifecycle scenarios.
- `docs/plans/05-hub.md:3-8` says P5 is implemented.
- `docs/plans/06-watchtower.md:3-6` says P6 is implemented.
- `docs/plans/08-e2e-and-audit.md:3-5` says P8 Phase 2 is done with 13 scenarios green.
- `e2e/src/scenarios.test.ts:49-670` contains active lifecycle, HTLC, watchtower, rotation, hub-down, and offline-resume tests.
- `e2e/README.md:10-12` says active scenarios are smoke-only and full lifecycle cases are `describe.skip`'d.
- `docs/plans/08-e2e-and-audit.md:117-123` still says multi-party/dispute/HTLC scenarios remain `describe.skip`.

**Observed behavior:**

The authoritative status surfaces disagree with each other and with the current test file.

**Impact:**

Readiness gates can be misread. A human operator could either block work that is done or, worse, miss the real remaining blockers because the roadmap says old blockers are still the current ones.

**Recommended fix:**

Make `ROADMAP.md` the single readiness source and update it from the implemented plans. Update `e2e/README.md` and stale P8 sections to distinguish vanilla e2e done, fork e2e not done, and internal review/soak still pending.

**Tests/checks needed:**

- Add a docs checklist before P10 requiring roadmap/plans/e2e README consistency.
- Consider a simple link/status lint script for phase status strings.

### EOD-10: Watchtower docs overstate encrypted-backup/service-mode behavior

**Severity:** Medium

**Evidence file references:**

- `apps/watchtower/README.md:3-11` says the watchtower stores encrypted state backups and supports service mode accepting encrypted state blobs.
- `docs/plans/06-watchtower.md:14-20` says service mode is Phase 2 and self-hosted only is selected for v1.
- `docs/plans/06-watchtower.md:29-35` says self-hosted mode uses a shared SQLite file, not encrypted blob upload.
- `apps/watchtower/src/storage.ts:129-164` creates plaintext `signed_states`, `watchtower_observations`, `in_flight_txs`, and `meta` tables.
- `apps/watchtower/src/storage.ts:169-179` persists serialized state/signatures JSON.
- `docs/learning/06-watchtower.html:75-78` also describes `storage.ts` as encrypted state-backup persistence.

**Observed behavior:**

The implemented default watchtower store is a SQLite state store with serialized signed states. Docs imply encrypted backups and a multi-tenant service mode that are not part of the v1 implementation.

**Impact:**

Operators may misunderstand custody and data-exposure risk. Signed state history is safety-critical; if docs imply encryption that does not exist, deployment and backup handling may be too casual.

**Recommended fix:**

Either implement the encrypted backup protocol or update README/learning docs to say v1 self-hosted watchtower uses a local SQLite state store and must be protected by filesystem/volume encryption and host access controls.

**Tests/checks needed:**

- Documentation review around watchtower storage claims.
- If encryption is implemented later, add tests proving at-rest state blobs are encrypted and recoverable.

### EOD-11: README and learning-material links point at a non-existent root `learning/` directory

**Severity:** Low

**Evidence file references:**

- `README.md:10-12`, `:43`, and `:95-96` link to or describe `learning/index.html`.
- `ROADMAP.md:10-12`, `:44`, `:150`, and `:204-205` also refer to `learning/`.
- Local file listing shows learning files under `docs/learning/`, not root `learning/`.
- `docs/learning/07-agent-runtime.html:79` links to `../docs/plans/07-agent-runtime.md`, which resolves to `docs/docs/plans/...` from `docs/learning/`.
- `docs/plans/11-learning.md:16-17`, `:25-27`, and `:34-46` specify a root `learning/` directory, while the repo contains `docs/learning/`.

**Observed behavior:**

Learning docs are present, but several entry links are broken or point to the wrong directory.

**Impact:**

New operator onboarding and pre-mainnet review are harder. This is low severity by itself, but it compounds the status-drift problem.

**Recommended fix:**

Update root docs to point to `docs/learning/index.html`, or move the learning directory to the documented root path. Fix relative links inside `docs/learning/*`.

**Tests/checks needed:**

- Add a markdown/html link check for relative links.
- Verify `docs/learning/index.html` can be opened offline and all cross-links resolve.

## Readiness blockers

- Fix or disprove the CLI/SDK Adjudicator-vs-PaymentChannel signing-domain mismatch before any mainnet channel state is signed.
- Add forked-mainnet lifecycle e2e coverage, including USDC provisioning, deployed contract addresses, and a gated CI path.
- Prove hub restart from durable DB state without manual channel/state injection, including in-flight HTLC recovery.
- Make production service startup fail fast on dummy keys, missing auth, missing operator token, and implicit mainnet defaults.
- Complete P9: deployment manifests, separate watchtower deployment, monitoring, alerts, backup/restore, sweeper, and runbooks.
- Resolve the production DB decision and align docs/configs/backups accordingly.
- Replace placeholder security contact/encryption instructions with a real monitored disclosure channel.
- Sync roadmap/plans/README/learning docs so readiness gates are not contradicted by stale text.

## Validation notes

- This was a read-only inspection except for creating this report file.
- I did not run build/test/e2e commands; findings are based on static evidence from source, configs, workflows, and docs. Runtime pass/fail claims should be verified separately where noted.
- Local inspection found no pre-existing `deepseek_audit_report_*.md` files at the time of this report creation.
- File changed: `deepseek_audit_report_e2e_ops_docs.md`.
