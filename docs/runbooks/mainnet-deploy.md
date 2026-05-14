# Runbook: Taiko mainnet + GKE production deploy

**Status:** template — every step below requires the named operator to execute it
with verified key custody. **Do NOT run this end-to-end without first
completing all gates in §0.**

Replace `<paging-contact>` with your PagerDuty/Opsgenie escalation policy before
mainnet operations.

## §0 Pre-flight gates (all must be DONE before §1)

| Gate | Status | Owner | Evidence |
|------|--------|-------|----------|
| External audit (Spearbit / Trail of Bits / Cantina) signed off on `v2` contracts + hub/watchtower runtime | ☐ | @dantaik | Audit report PDF + commit hash audited |
| PC-09: contract owner is a `TimelockController(48h)` with operator Safe as proposer/executor | ☐ | @dantaik | Etherscan link showing `owner()` is a contract with `getMinDelay() ≥ 172800` |
| Deployer EOA retired (no balance, no operator pulls from this address) | ☐ | @dantaik | Etherscan link showing 0 balance |
| Real PGP key published, fingerprint replaces `<PICO_PGP_FINGERPRINT_TODO>` in `SECURITY.md` | ☐ | @dantaik | PGP public key URL + `security-md-lint.yml` passing |
| Real-USDC mainnet smoke completed (full open → topUp → pay → close cycle on real USDC) | ☐ | @dantaik | `docs/mainnet-smoke-round-N.md` |
| Restore drill: destroy hub volume, restore from R2 litestream replica, verify channels resume | ☐ | infra | Recorded session + post-drill notes |
| Paging drill: synthetic alert routes to `<paging-contact>` and is acked within SLA | ☐ | ops | Alert + acks |
| Security disclosure drill: ingest a real submission via `security@taiko.xyz` and walk the runbook | ☐ | @dantaik | Hall-of-fame test entry + post-drill notes |
| Second CODEOWNER added; paging rotation has ≥ 2 humans | ☐ | @dantaik | `.github/CODEOWNERS` + PagerDuty rotation export |
| GH secrets provisioned: `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`, `R2_*`, `RPC_URL_TAIKO`, `HUB_PRIVATE_KEY`, `WATCHTOWER_PRIVATE_KEY` (latter two **NOT** the deployer EOA) | ☐ | infra | `gh secret list -R taikoxyz/pico` |
| GCP project ready: `pico-mainnet-prod`, Artifact Registry, GKE Autopilot cluster, WIF provider, KMS keyring | ☐ | infra | `bootstrap-gcp.sh` log archived |
| `gcloud compute security-policies create pico-hub-armor` provisioned (Cloud Armor rules attached) | ☐ | infra | `gcloud compute security-policies describe pico-hub-armor` |
| `gcloud compute ssl-policies create pico-hub-ssl --profile MODERN --min-tls-version=1.2` | ☐ | infra | `gcloud compute ssl-policies describe pico-hub-ssl` |
| DNS: `hub.pico.taiko.xyz` `A` record targets the GCE LB static IP; ManagedCertificate validates | ☐ | infra | `dig hub.pico.taiko.xyz` + cert status `Active` |
| App-side change: hub + watchtower read `PICO_SECRETS_DIR` for file-mounted secrets (manifests already mount; app shim is a separate PR) | ☐ | runtime | PR merged + image rebuilt |
| Hot wallet ETH funded: ≥ 1 ETH on hub address, ≥ 1 ETH on watchtower address (mainnet) | ☐ | infra | Etherscan |
| `PICO_PAYMENT_MAX_RAW` + `PICO_PAYMENT_DAILY_RAW` defined for any agent that will use the CLI in prod | ☐ | per-agent | Agent's deploy config |

**Until every row above shows `✅`, STOP.** Each unchecked row is a finding the
audit identified as a GA blocker.

## §1 Cut the release

From your laptop, on `main`:

```bash
# 1.1 Verify the branch is at the audited commit
git fetch origin
git switch main
git pull --ff-only origin main
EXPECTED_SHA="$(audit_signoff_commit_sha)"   # paste from the audit report
test "$(git rev-parse HEAD)" = "$EXPECTED_SHA" || { echo "main is not at audited SHA"; exit 1; }

# 1.2 Bump versions via changesets (do NOT skip changeset)
pnpm changeset
pnpm changeset version
pnpm install --lockfile-only
git add . && git commit -m "release: vX.Y.Z mainnet GA"

# 1.3 Tag and push
git tag -s "vX.Y.Z" -m "pico vX.Y.Z — mainnet GA"
git push origin main
git push origin "vX.Y.Z"
```

The `gke-images.yml` workflow fires on tag push: builds + Trivy + syft + cosign
sign. **Verify the workflow run is green** before proceeding. If Cosign signing
fails because `COSIGN_PRIVATE_KEY` is missing, fix the secret first; do NOT
re-run with signing skipped.

## §2 Deploy contracts (one-time per chain)

Pre-requisites: deployer EOA funded with ≥ 0.1 ETH on Taiko mainnet (chain id
`167000`). The deployer EOA is BURNED after this section — it never owns
anything in production.

```bash
cd packages/contracts

# 2.1 Deploy timelock first (independent of PaymentChannel / Adjudicator)
forge script script/DeployTimelock.s.sol \
  --rpc-url "$RPC_URL_TAIKO" \
  --private-key "$DEPLOYER_KEY" \
  --broadcast --verify

# Note the printed TimelockController address; export it for §2.2:
export TIMELOCK_ADDR=0x...

# 2.2 Deploy PaymentChannel + Adjudicator with `owner = TIMELOCK_ADDR`
forge script script/Deploy.s.sol \
  --rpc-url "$RPC_URL_TAIKO" \
  --private-key "$DEPLOYER_KEY" \
  --broadcast --verify \
  --sig 'run(address)' "$TIMELOCK_ADDR"

# 2.3 Verify on Etherscan that PaymentChannel.owner() == $TIMELOCK_ADDR
# and TimelockController.getMinDelay() >= 172800 (48h)
cast call $PAYMENT_CHANNEL_ADDR "owner()(address)" --rpc-url "$RPC_URL_TAIKO"
cast call $TIMELOCK_ADDR "getMinDelay()(uint256)" --rpc-url "$RPC_URL_TAIKO"

# 2.4 Allowlist USDC and ETH (token == address(0))
# This is a 48h-delayed Safe-proposed timelock operation, NOT a direct call.
# Use the Safe UI to propose:
#   target: $PAYMENT_CHANNEL_ADDR
#   calldata: setTokenAllowed(USDC_TAIKO, true, MIN_USDC_RAW)
#   calldata: setTokenAllowed(0x0, true, MIN_ETH_WEI)

# 2.5 Update packages/protocol/src/constants.ts with the deployed addresses,
# bump version, cut a follow-up release tag (e.g. vX.Y.Z+1) so apps pick up
# the new addresses.

# 2.6 BURN the deployer EOA: empty its balance to a designated burn address
# (or just leave at 0 ETH; never use this EOA again).
cast send $BURN_ADDR --value $(cast balance $DEPLOYER_ADDR --rpc-url "$RPC_URL_TAIKO") \
  --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL_TAIKO"
```

## §3 Provision GKE production cluster

```bash
# 3.1 Authenticate
gcloud auth login
gcloud config set project pico-mainnet-prod

# 3.2 Run the bootstrap (creates Autopilot cluster, AR repo, WIF provider, KMS)
cd infra/k8s
bash bootstrap-gcp.sh

# 3.3 Verify cluster + WIF
gcloud container clusters list
gcloud iam workload-identity-pools providers list-oidc \
  --workload-identity-pool=pico-mainnet-pool --location=global

# 3.4 Provision Cloud Armor + SSL policy if not done in §0
gcloud compute security-policies create pico-hub-armor \
  --description "Pico hub L7 WAF"
gcloud compute security-policies rules create 1000 \
  --security-policy pico-hub-armor \
  --src-ip-ranges "*" \
  --action "rate-based-ban" --rate-limit-threshold-count 100 \
  --rate-limit-threshold-interval-sec 60 \
  --ban-duration-sec 600 \
  --conform-action allow --exceed-action deny-429

gcloud compute ssl-policies create pico-hub-ssl \
  --profile MODERN --min-tls-version=1.2

# 3.5 Provision K8s secrets
kubectl create ns pico
bash secrets-bootstrap.sh    # rejects known dev keys; will fail if you tried
                              # to seed an Anvil key. Good.
```

## §4 Deploy hub + watchtower

```bash
# 4.1 Manually trigger the deploy workflow on the tagged release
gh workflow run deploy.yml -R taikoxyz/pico -f tag=vX.Y.Z

# 4.2 Watch the run
gh run watch -R taikoxyz/pico

# 4.3 Verify rollout
kubectl -n pico rollout status statefulset/pico-hub --timeout=10m
kubectl -n pico rollout status statefulset/pico-watchtower --timeout=10m

# 4.4 Verify the secret-as-file mounts are present (defense-in-depth check)
kubectl -n pico exec sts/pico-hub -- ls -la /etc/pico/secrets/

# 4.5 Verify metrics are scraping
kubectl -n pico port-forward svc/pico-prometheus 9090:9090 &
curl 'http://127.0.0.1:9090/api/v1/query?query=pico_hub_chain_watcher_lag_blocks'
curl 'http://127.0.0.1:9090/api/v1/query?query=pico_hub_hot_wallet_eth_balance_wei'
curl 'http://127.0.0.1:9090/api/v1/query?query=pico_watchtower_hot_wallet_eth_balance_wei'
# All three must return a non-empty `result`.

# 4.6 Confirm alerts loaded
curl 'http://127.0.0.1:9090/api/v1/rules' | jq '.data.groups[].rules[].name' | sort -u
# Expected: HubHotWalletGasLow, WatchtowerHotWalletGasLow, ChainWatcherLagging,
# WatchtowerOldestPendingTxStale, etc.
```

## §5 Post-deploy smoke

```bash
# 5.1 Open a small real-USDC channel from a test agent
pnpm pico keys init
pnpm pico channel open --hub https://hub.pico.taiko.xyz --amount 1   # 1 USDC

# 5.2 Pay yourself (channel A → channel B both yours)
pnpm pico pay --to $RECIPIENT --amount 0.10 --json
# Expect: settled: true, preimage redacted

# 5.3 Cooperative close
pnpm pico channel close --channel <id>

# 5.4 Repeat for ETH (token == address(0))
pnpm pico channel open --hub https://hub.pico.taiko.xyz --amount 0.001 --token ETH
pnpm pico pay --to $RECIPIENT --amount 0.0001 --json
pnpm pico channel close --channel <id>
```

If any step in §5 fails, **immediately**:
1. Page `<paging-contact>`.
2. Run `kubectl -n pico logs sts/pico-hub --tail=500` and capture.
3. Snapshot the SQLite DB: `kubectl -n pico exec sts/pico-hub -- sqlite3 /data/hub.db .dump > /tmp/hub.dump.sql`.
4. Open a Sev1 incident; do NOT take more user traffic until root-caused.

## §6 Steady-state monitoring

After §5 succeeds, monitor for at least 72 hours before opening to public traffic:

- All 17+ Prometheus alerts silent
- `pico_hub_chain_watcher_lag_blocks < 5` sustained
- `pico_hub_hot_wallet_eth_balance_wei > 5e16` (0.05 ETH) sustained
- `pico_watchtower_pending_tx_count` stays at 0 outside actual penalty events
- Litestream replication lag < 60s
- No CrashLoopBackOff in any pod

Then announce GA.

## §7 Rollback

If a regression appears after deploy:

```bash
# 7.1 Identify the previous tag
PREV_TAG=$(git tag --sort=-creatordate | sed -n '2p')

# 7.2 Re-run deploy.yml on the previous tag
gh workflow run deploy.yml -R taikoxyz/pico -f tag=$PREV_TAG

# 7.3 Verify
kubectl -n pico rollout status statefulset/pico-hub --timeout=10m
```

If contracts are buggy, rollback is NOT just redeploy: timelock-propose
`pause(openChannel)` + `pause(topUp)` from the Safe (48h delay), let in-flight
channels close cooperatively, and prepare a v2.x contract upgrade through the
timelock. **Do not under any circumstances** transfer ownership back to an EOA
"to move faster" — that's the gate that protects user funds.

## §8 Comms

After §5 passes and §6 has been clean for 72h, announce on:
- Taiko Discord / Telegram operator channel
- Twitter from `@picopay` (or chosen handle)
- GitHub release notes
- Status page

Template at `docs/runbooks/README.md` → "Communication templates".

---

**Last reviewed:** 2026-05-14 (auto-generated as part of PR #127 gap-closure).
Update this runbook whenever any of the §0 gates, §1-§4 commands, or §5
post-deploy expectations change.
