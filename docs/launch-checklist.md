# Tainnel mainnet launch checklist

The single source of truth for what must be true before tainnel custodies real
USDC on Taiko mainnet. Each phase ends with a 🛑 GATE — do not proceed past
that gate until every item above is checked. Items are tagged
`[human]` / `[agent]` / `[ci]` to indicate the verifier and `verify by:` lines
point at a specific tx hash, file path, or command.

For the per-finding audit reconciliation see
[`docs/audit-status.md`](./audit-status.md).

## Phase 0 — Pre-flight ✅ (verifiable now)

- [x] `[ci]` All P1–P8 plans green per `ROADMAP.md` status table.
      _verify by: `cat ROADMAP.md`._
- [x] `[ci]` DeepSeek audit fixes landed.
      _verify by: `git log --oneline e9bf7ec c4e4cd1 a87ab4b 7706169 80fda25`._
- [x] `[ci]` Fork e2e wired into CI behind `TAIKO_MAINNET_RPC_URL`.
      _verify by: `.github/workflows/ci.yml:195-216`._
- [x] `[ci]` Hub mainnet config gates fail-fast on dev keys / unsigned envelopes.
      _verify by: `apps/hub/src/config-validate.ts:32-51`._
- [x] `[ci]` Watchtower mainnet config gates fail-fast on dev keys.
      _verify by: `apps/watchtower/src/config-validate.ts:29-38`._
- [x] `[ci]` Per-channel mutex serializing route construction in the hub.
      _verify by: `apps/hub/src/router.ts` (search for the per-channel mutex)._
- [x] `[ci]` State acceptance gates wired into the SDK.
      _verify by: `packages/state-machine/src/admit.ts:141-271` + SDK callers in
      `packages/sdk/src/client.ts`._

🛑 **GATE 0** — every box above must remain checked before any later phase
proceeds. If a regression flips one back, halt.

## Phase A — Governance and contracts

- [ ] `[human]` TimelockController deployed via
      `packages/contracts/script/DeployTimelock.s.sol`. _verify by: deploy tx
      hash field on Taikoscan._
- [ ] `[human]` Source verified on Taikoscan with the expected constructor
      args (`MIN_DELAY`, `[Safe]`, `[Safe]`, `address(0)`).
- [ ] `[human]` Proxy ownership transferred to the Timelock via
      `packages/contracts/script/TransferOwnership.s.sol`. _verify by:
      `cast call <proxy> "owner()(address)" == $TIMELOCK` for both proxies._
- [ ] `[human]` Deployer key revoked / cold-stored. _verify by: incident log
      entry with timestamp + key destruction method._
- [ ] `[human]` Mainnet smoke channel run end-to-end and recorded in
      `docs/mainnet-e2e-test-log.md`. _verify by: file exists and lists tx
      hashes for open, pay, settle, cooperative-close, dispute drill._

🛑 **GATE A** — no payment activity on mainnet until ownership is held by the
Timelock.

## Phase B — External validation

- [ ] `[human]` Independent audit firm engaged (Spearbit / Trail of Bits /
      Cantina or equivalent). _verify by: signed engagement letter; not a
      DeepSeek follow-up._
- [ ] `[human]` Audit report received and committed under
      `docs/audit/<vendor>-<date>.pdf`.
- [ ] `[human]` All critical and high findings addressed; addresses linked
      from `docs/audit-status.md`.
- [ ] `[human]` Auditor's second pass acknowledges the fixes.

🛑 **GATE B** — no GA without an external auditor's sign-off on the patched
contracts.

## Phase C — Operations

- [ ] `[ci]` Fly apps `tainnel-hub-prod` and `tainnel-watchtower-prod`
      deployed from a `v*` tagged release via
      `.github/workflows/deploy.yml`.
- [ ] `[human]` Prometheus is scraping both targets (no `up == 0` flapping).
      _verify by: Prometheus `up{job=~"tainnel-(hub|watchtower)"}`._
- [ ] `[human]` Alertmanager paging tested via a synthetic alert that
      reaches the actual on-call channel.
- [ ] `[ci]` Restore drill green within the last 30 days.
      _verify by: `.github/workflows/backup-drill.yml` last successful run +
      no open `backup-drill: ... failed` issues._
- [ ] `[human]` Litestream replication confirmed for both hub and watchtower
      (snapshot lag < 1h, retention 30d).

🛑 **GATE C** — no GA without monitored, alerted, recoverable infra.

## Phase D — Security disclosure

- [ ] `[human]` `SECURITY.md` no longer carries the `<TAINNEL_PGP_FINGERPRINT_TODO>`
      placeholder; `pgp-key.asc.placeholder` removed; `pgp-key.asc` committed.
      _verify by: `.github/workflows/security-md-lint.yml` passes on the swap
      PR._
- [ ] `[human]` PGP key published to keys.openpgp.org and discoverable.
- [ ] `[human]` Dry-run disclosure drill completed end-to-end per
      `docs/runbooks/security-disclosure.md`.
- [ ] `[human]` On-call rotation populated (PagerDuty / Linear schedule URL
      filled into the runbook); `CODEOWNERS` reflects current maintainers.

🛑 **GATE D** — no GA without a tested, monitored disclosure channel.

## Phase E — Launch hygiene

- [ ] `[human]` `docs/mainnet-e2e-test-log.md` complete with addresses, tx
      hashes, and any incident notes per `docs/plans/10-launch.md`.
- [ ] `[human]` `ROADMAP.md` flipped to GA.
- [ ] `[human]` Release notes drafted and reviewed.
- [ ] `[human]` Status page configured (even a static GitHub Pages page is
      acceptable for v1).

🛑 **GATE E** — last gate. Once green, GA.

## Authority

Maintainers may add or tighten items. Items can only be unchecked by writing
an entry in the incident log explaining why. The default for ambiguous
states is unchecked.
