  Overall: Not Ready (~40%)

  The system can execute a happy-path payment in local dev, but cannot safely custody real USDC on Taiko mainnet. The critical failure paths — adversarial hub, watchtower crash,
  restart recovery, stale-state dispute, concurrent routing, and mainnet config defaults — all carry unresolved fund-loss or fund-stranding risk. No dimension of the readiness matrix
  is fully green.

  ---

  What's solid

  | Area | Status |
  |------|--------|
  | **Protocol design** | Frozen and well-specified. 1-hop topology, EIP-712 signing, SHA-256 HTLC. Sound for v1 scope. |
  | **State machine** (`@pico/state-machine`) | Pure-function library, good test coverage, HTLC math / Merkle roots / EIP-712 cross-tested between TS and Solidity. |
  | **SDK happy path** | `ChannelClient` with signer abstraction, storage backends, full payment lifecycle (invoice, keysend, pay, settle, close). Works. |
  | **CLI agent surface** | `keys init`, `channel open`, `pay`, `listen` — all functional. The v1 target (agents shelling out to CLI) is working. |
  | **Contracts (post-audit fixes)** | The critical and high findings from the DeepSeek audit appear patched in the tree. Not yet re-reviewed by a human auditor. |
  | **Documentation** | Comprehensive: protocol spec, threat model, per-phase plans, per-component learning tutorials. |

  ---

  What blocks mainnet — the 10 readiness blockers

  These are the items from `MAINNET_READINESS_EVALUATION.md` that gate the controlled mainnet test. All are blocking:

  1. SDK state verification — **Fixed** (was critical blocker F-01)
  The SDK previously trusted hub-supplied `SignedState` without verifying signatures, channel, version, balances, or HTLCs. Admit gates from `@pico/state-machine` are now wired
  into all signed-state ingestion paths (`packages/sdk/src/client.ts:20-23`).

  2. CLI signing domain mismatch — **Fixed** (was critical blocker EOD-01)
  The CLI now uses `Adjudicator` as the `verifyingContract` (matching on-chain verification), not `PaymentChannel`.

  3. Hub safety gaps — **Largely fixed** (H-01 through H-09)
  - WebSocket auth: signed envelopes verified, signer bound to message actor, mainnet requires envelopes.
  - Per-channel mutex serializing concurrent route construction.
  - Router rehydrates in-flight routes from DB on restart.
  - Settle/fail bound to persisted route + signer.
  - Dispute handler selects empty-HTLC state.
  - Chain watcher rewritten with reorg protection + chunked log scans.
  - Production defaults fail-fast on known dev keys.

  **Remaining**: hub-advertised fee policy (H-10) and full liquidity-from-states (H-11) are patched but not fully implemented.

  4. Watchtower reliability gaps — **Partially fixed, 2 open**
  - **Fixed**: pending event flusher (WTW-001), durable work items across restart (WTW-002), tx re-broadcast + fee bumping (WTW-003), dev key rejection (WTW-004).
  - **Still open**: `remember()` does not validate signatures before storing state (WTW-005), and the live penalize path bypasses the configured penalty threshold (WTW-006). The happy
    path works; the watchtower cannot yet be relied upon under production stress.

  5. Contract governance — **Open** (human gate)
  - Deployer EOA still owns both UUPS proxies.
  - `DeployTimelock.s.sol` and `TransferOwnership.s.sol` scripts exist but have not been executed on mainnet.
  - Line-by-line human review of patched `PaymentChannel.sol` and `Adjudicator.sol` not done.
  - Smoke channel on mainnet with real USDC not run.

  6. CLI secret handling — **Partially patched**
  Warnings on `--private-key` / env var usage exist. Preimage redaction by default exists. Arv-key rejection in production is not enforced. Keys and preimages can still leak through
  shell history and CI logs in dev mode.

  7. E2E mainnet fork testing — **Fixed in CI**
  Fork tests with USDC whale impersonation wired into CI (`.github/workflows/ci.yml:195-216`). Coverage thresholds not yet enforced.

  8. Operations & infrastructure — **Plans + manifests exist; not deployed**

  **For GKE specifically** — the `infra/k8s/` directory contains well-structured manifests:
  - `00-namespace.yaml` — namespace + LimitRange
  - `01-hub.yaml` — StatefulSet (hub + litestream sidecar), headless Service, ClusterIP Service, Ingress + ManagedCertificate + BackendConfig + FrontendConfig
  - `02-watchtower.yaml` — StatefulSet + headless Service (no public surface)
  - `03-prometheus.yaml` — StatefulSet with 20Gi PVC, 15d retention, scrape configs, full alert rules
  - `04-alertmanager.yaml` — Deployment + ephemeral state, webhook routing by severity
  - `05-grafana.yaml` — Deployment + pre-built dashboards (hub overview, watchtower overview)
  - `secrets-bootstrap.sh` — refuses known dev keys
  - README with complete setup/deploy/rollback instructions

  **BUT** — there is one known blocker in the manifests themselves:

  > **Metrics binding**: Hub and watchtower bind `/metrics` to `127.0.0.1` inside the pod. Prometheus running in a sibling pod cannot reach them. Until the apps are patched to bind
  `0.0.0.0` or `::` (gated by `METRICS_BIND_ADDR`), Prometheus will report `up == 0` for both jobs. This is explicitly documented in both `infra/k8s/README.md` and
  `infra/fly/README.md`.

  **Other GKE gaps**:
  - No deploy workflow for the GKE path (`.github/workflows/deploy.yml` is Fly-only).
  - No `v*`-tagged images in Artifact Registry.
  - No deployed cluster confirmed; all manifests carry `REGION-docker.pkg.dev/PROJECT/pico/hub:VERSION` placeholders.
  - NetworkPolicy not applied (not blocking — the README says it's optional for v1).
  - Alertmanager webhooks point to `localhost:5001` placeholders.
  - `SECURITY.md` contact is still `security@pico.dev` with "not monitored yet."

  9. Security disclosure — **Partially patched**
  `SECURITY.md` rewritten, `pgp-key.asc.placeholder` committed, disclosure runbook exists, CI lint gate in place. But the PGP key is still a placeholder and the inbox is not
  monitored.

  10. Runbooks — **Written but untested**
  Six runbooks exist under `docs/runbooks/` (hub-down, watchtower-down, dispute-response, key-rotation, backup-restore, security-disclosure). Four still carry DRAFT markers. No
  operational drill has been conducted.

  ---

  Audit reconciliation snapshot

  | Status | Count |
  |--------|-------|
  | Fixed | 36 |
  | Patched-not-reaudited | 14 |
  | Open | 6 |
  | Won't-fix | 0 |
  | **Total** | **56** |

  The 6 open findings: PC-09 (deployer owns proxies — human gate), WTW-005 (watchtower skips signature validation), WTW-006 (penalty threshold bypass on live path), WTW-013 (recovery
  test suite incomplete), F-10 (test-only SDK exports on public npm).

  ---

  Launch checklist gates

  | Phase | Description | Status |
  |-------|-------------|--------|
  | 0 | Pre-flight (CI gates, audit fixes, config validation, state admission) | ✅ All checked |
  | A | Governance & contracts (Timelock, ownership transfer, smoke channel) | 🔴 0/5 checked |
  | B | External validation (independent audit firm engaged) | 🔴 0/4 checked |
  | C | Operations (deploy, Prometheus, Alertmanager paging, restore drill, Litestream) | 🔴 0/5 checked |
  | D | Security disclosure (PGP key, disclosure drill, on-call rotation) | 🔴 0/4 checked |
  | E | Launch hygiene (test log, ROADMAP flip, release notes, status page) | 🔴 0/4 checked |

  ---

  What can proceed in parallel right now

  - **GKE cluster creation + image builds** — the manifests are ready to apply once the metrics binding is fixed and image placeholders are substituted. An estimated ~$50/mo on
    Autopilot.
  - **Contract governance execution** — Timelock deployment and ownership transfer scripts are ready; need a human with the deployer key.
  - **External audit firm engagement** — Spearbit / Trail of Bits / Cantina. Independent of engineering.
  - **Learning materials** — parallelizable with everything.
  - **Watchtower WTW-005 / WTW-006 fixes** — pure code changes, no human gates.

  ---

  Bottom line

  The codebase has absorbed the DeepSeek audit (36 of 56 findings fixed, critical path now has validation gates where it previously had none). But the system has never been deployed
  to production, never been tested against deployed mainnet contracts with real USDC, and still carries a deployer-owned proxy and placeholder security contact. The GKE manifests are
  well-structured but untested, blocked on a metrics binding issue and the absence of a deploy pipeline. Real-money readiness requires closing the 10 blockers above — most are
  engineering work; the human gates (auditor, multisig, smoke channel) are the long pole.
