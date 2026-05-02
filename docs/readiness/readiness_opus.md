# Production Readiness — Opus snapshot

**Overall: Not Ready (~40%).** Codebase has absorbed the DeepSeek audit and the GKE manifest set is complete, but the system has never moved real USDC on Taiko mainnet, no human-firm audit has signed off, and the GKE path has a known metrics-binding bug that prevents Prometheus from scraping. Companion file: `readiness_deepseek.md` (long-form audit reconciliation).

---

## Taiko mainnet — what's done

- Protocol spec frozen: 1-hop topology, EIP-712 signing, SHA-256 HTLC (`docs/protocol-spec.md`).
- Contracts deployed and Taikoscan-verified (`packages/contracts/`, Solidity 0.8.26, Foundry/UUPS).
- DeepSeek audit landed: **36 fixed / 14 patched-not-reaudited / 6 open** of 56 findings (`docs/audit-status.md`).
- CI gates green on every PR: lint (Biome), typecheck (TS 5.5 strict), build (Turbo), TS tests (vitest), Solidity (`forge test`), and **USDC fork e2e** with whale impersonation (`.github/workflows/ci.yml`, `e2e/src/scenarios.fork.test.ts`).
- Hub + watchtower production config gates fail-fast on dev keys and unsigned envelopes.
- State admission gates from `@tainnel/state-machine` are wired into all SDK signed-state ingestion paths (`packages/sdk/src/client.ts`).

## Taiko mainnet — what's blocking

| # | Item | Type |
|---|------|------|
| 1 | Deployer EOA still owns both UUPS proxies; `DeployTimelock.s.sol` + `TransferOwnership.s.sol` exist but **not executed** on mainnet | human gate |
| 2 | External audit firm sign-off on patched contracts (Spearbit / Trail of Bits / Cantina) — only DeepSeek (AI) has reviewed | human gate |
| 3 | Smoke channel with real USDC on mainnet not yet executed | human gate |
| 4 | 4 of 6 runbooks still carry DRAFT markers (`hub-incident.md`, `watchtower-down.md`, `dispute-response.md`, `key-rotation.md`); no operational drill performed | ops |
| 5 | PGP key still placeholder (`pgp-key.asc.placeholder`); security inbox not monitored | ops |

### Just landed in code (patched-not-reaudited)

| ID | Item | Where |
|----|------|-------|
| WTW-005 | `remember()` now validates SignedState (EIP-712 sigA/sigB against on-chain userA/userB, empty HTLCs, balance conservation, `finalized=false`); channel invariants cached per channelId | `apps/watchtower/src/index.ts` |
| WTW-006 | Live close-event handler defers to scheduler when `Date.now() < submitByMs`; configured `PENALTY_THRESHOLD` honored on every path | `apps/watchtower/src/index.ts` |
| F-10 | SDK no longer publishes `./signer.test-only` or `./_test`; helpers moved to `@tainnel/test-utils`; `npm pack` tarball verified clean | `packages/sdk/package.json`, `packages/test-utils/src/` |
| WTW-013 | New 9-scenario recovery suite covering WTW-002/003/005/006/010 regressions | `apps/watchtower/src/recovery.test.ts` |

---

## Google GKE — what's done

- Full manifest set in `infra/k8s/` (Autopilot, single-region us-central1, ~$50/mo estimate):
  - `00-namespace.yaml` — namespace + LimitRange
  - `01-hub.yaml` — StatefulSet (hub + litestream sidecar), headless + ClusterIP Services, Ingress + ManagedCertificate + BackendConfig + FrontendConfig
  - `02-watchtower.yaml` — StatefulSet + headless Service (no public surface)
  - `03-prometheus.yaml` — StatefulSet, 20Gi PVC, 15d retention, scrape configs, alert rules
  - `04-alertmanager.yaml` — Deployment + ephemeral state, severity-routed webhooks
  - `05-grafana.yaml` — Deployment + auto-provisioned Hub Overview / Watchtower Overview dashboards
- `secrets-bootstrap.sh` refuses known dev keys and creates `tainnel-hub-secrets` + `tainnel-watchtower-secrets`.
- Litestream sidecar replicates SQLite to Cloudflare R2 with 30-day retention (parity with Fly.io path).
- Ingress + ManagedCertificate provides automatic HTTPS for the hub; watchtower internal-only.
- Setup, deploy, and rollback documented end-to-end in `infra/k8s/README.md`.

## Google GKE — what's blocking

| # | Item | Type |
|---|------|------|
| 1 | **Metrics binding bug**: hub + watchtower bind `/metrics` to `127.0.0.1` inside the pod, so Prometheus in a sibling pod can't reach them. Both `up` targets will report 0. Need `METRICS_BIND_ADDR=::` (code change in `apps/hub/` and `apps/watchtower/`). **Single biggest GKE blocker.** Documented in `infra/k8s/README.md` and `infra/monitoring/README.md`. | code |
| 2 | No GKE deploy workflow — `.github/workflows/deploy.yml` is Fly.io-only (flyctl) | CI |
| 3 | No `v*`-tagged images in Artifact Registry; manifests carry `REGION-docker.pkg.dev/PROJECT/tainnel/{hub,watchtower}:VERSION` placeholders | ops |
| 4 | GKE cluster not yet created; gcloud / Artifact Registry repo / R2 bucket / DNS prerequisites documented but not executed | ops |
| 5 | Alertmanager webhooks point to `localhost:5001` placeholder; need real on-call channel URL | ops |
| 6 | No restore-drill or paging test executed against GKE | ops |
| 7 | NetworkPolicy not applied (README marks optional for v1) | ops, optional |

---

## Audit reconciliation snapshot

| Status | Count |
|--------|-------|
| Fixed | 36 |
| Patched-not-reaudited (incl. WTW-005, WTW-006, WTW-013, F-10 just-landed) | 18 |
| Open | 2 |
| Won't-fix | 0 |
| **Total** | **56** |

Open: PC-09 (deployer owns proxies — human gate) and the configured-fee-policy follow-up. `docs/audit-status.md` still labels the four newly-closed items as Open pending its own re-classification.

## Launch checklist gates (`docs/launch-checklist.md`)

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Pre-flight (CI, audit fixes, config validation, state admission) | ✅ All checked |
| A | Governance & contracts (Timelock, ownership transfer, smoke channel) | 🔴 0/5 |
| B | External validation (independent audit firm) | 🔴 0/4 |
| C | Operations (deploy, Prometheus, Alertmanager paging, restore drill, Litestream) | 🔴 0/5 |
| D | Security disclosure (PGP key, disclosure drill, on-call rotation) | 🔴 0/4 |
| E | Launch hygiene (test log, ROADMAP flip, release notes, status page) | 🔴 0/4 |

---

## Parallelizable work that can proceed right now

- **GKE cluster + image builds** — manifests are ready to apply once the metrics-binding fix lands and image placeholders are substituted.
- **Metrics binding fix** — small code change in two apps; unlocks GKE Prometheus scrape.
- **Timelock deploy + ownership transfer** — scripts exist; needs the deployer key holder.
- **External audit firm engagement** — independent of engineering; the patched-not-reaudited set just grew (WTW-005/006/013, F-10).
- **Runbook drafts → finalize + drill** — independent of engineering velocity.

---

## Bottom line

**Taiko mainnet:** ~45% ready (up from ~40% after the WTW-005/006/013 + F-10 work landed). Engineering side is now substantially done; the long pole is human-gate items (independent audit firm, multisig + Timelock ownership transfer, smoke channel). The watchtower fixes that previously gated mainnet readiness are in code with regression tests; until they are re-audited and the human gates close, the system still cannot safely custody real USDC.

**Google GKE:** Manifests and monitoring are well-structured and documented; the single technical blocker is the metrics-binding code fix in hub + watchtower. After that, deployment is mechanical: build + push tagged images, create the cluster, add a GKE workflow, swap webhook URLs, run a restore-drill.
