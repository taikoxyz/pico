# Pico runbooks

Operational playbooks for hub and watchtower on-call. Each runbook lists the
trigger conditions, triage steps, containment, recovery checks, and the
post-mortem template. Replace `<paging-contact>` markers with your real
PagerDuty/Opsgenie escalation policy before mainnet operations.

Mainnet readiness is tracked under
[issue #21](https://github.com/taikoxyz/pico/issues/21).

## Runbook index

| Runbook | Trigger | Severity |
|---|---|---|
| [hub-incident.md](./hub-incident.md) | hub stops accepting WS connections, returns 5xx, or alerts fire | sev1 |
| [watchtower-down.md](./watchtower-down.md) | watchtower process down, RPC up failing, or oldest pending tx age > deadline / 3 | sev1 |
| [dispute-response.md](./dispute-response.md) | a unilateral close was observed against one of our channels | sev1 |
| [key-rotation.md](./key-rotation.md) | scheduled rotation, or routine handoff between maintainers | sev2 |
| [backup-restore.md](./backup-restore.md) | hub or watchtower DB lost, corrupt, or rolled back; restore from litestream | sev1 |
| [ownership-transfer.md](./ownership-transfer.md) | one-time mainnet handoff to multisig+timelock, or routine governed upgrade | sev1 |
| [security-disclosure.md](./security-disclosure.md) | inbound vulnerability report received | sev1 |
| [hub-key-compromise.md](./hub-key-compromise.md) | hub signing key suspected leaked or misused | sev1 |
| [watchtower-key-compromise.md](./watchtower-key-compromise.md) | watchtower signing key suspected leaked or misused | sev1 |
| [usdc-blocklist.md](./usdc-blocklist.md) | Circle blocklists the hub hot wallet | sev1 |
| [hot-wallet-drain.md](./hot-wallet-drain.md) | hub or watchtower hot wallet drained (bug or attack) | sev1 |
| [dispute-storm.md](./dispute-storm.md) | N simultaneous unilateral closes | sev1 |
| [false-positive-penalty.md](./false-positive-penalty.md) | watchtower submitted penalty against a legitimate state | sev1 |

## Common touch-points

- Hub config: `apps/hub/.env.example` and `apps/hub/src/config.ts`.
- Watchtower config: `apps/watchtower/.env.example` and `apps/watchtower/src/config.ts`.
- Hub DB: SQLite at `data/hub.sqlite`; replicated by litestream.
- Watchtower DB: SQLite at `data/watchtower.sqlite`; replicated separately.
- Metrics: `/metrics` on the hub; `/metrics` and `/health` on the watchtower.
  Key gauges:
  - `pico_hub_chain_watcher_lag_blocks`
  - `pico_hub_hot_wallet_eth_balance_wei`
  - `pico_watchtower_oldest_pending_tx_age_ms`
  - `pico_watchtower_oldest_closing_deadline_remaining_ms`
  - `pico_watchtower_pending_tx_count`
  - `pico_watchtower_submission_failed_total`
  - `pico_watchtower_hot_wallet_eth_balance_wei`
- Logs: structured pino JSON; tail with `kubectl logs -n pico ...` on GKE,
  `docker logs -f` locally, or the platform UI.
- Cluster: GKE. Cluster ops use `gcloud container clusters ...`; pod ops use
  `kubectl ... -n pico`.

## Escalation matrix

| Severity | Definition | Page | Response |
|---|---|---|---|
| **Sev1** | Funds at risk, settlement halted, or active exploit | Page primary on-call via `<paging-contact>` | War-room open within 15 min; status page updated within 30 min |
| **Sev2** | Degraded but funds safe (e.g. metrics gap, replica lag, one-of-two RPC down) | Page primary via `<paging-contact>` | Assess within 30 min; status page if user-visible |
| **Sev3** | Minor (cosmetic alerts, low-pri config drift, lint failures) | File ticket; do not page | Address in normal business hours |

Default to over-paging. If unsure between sev2 and sev1, treat as sev1.

## Communication templates

### Status page — degraded service

```
[INVESTIGATING] <UTC ts> — We are investigating reports of degraded
performance on the pico hub. Channel opens and payments may be slow or
fail. Funds in open channels are unaffected. Next update in 30 min.
```

### Status page — incident resolved

```
[RESOLVED] <UTC ts> — The pico hub incident reported at <start ts> has
been resolved. Service is fully restored. A post-mortem will be published
within 5 business days at <link>.
```

### Status page — funds-at-risk

```
[MAJOR INCIDENT] <UTC ts> — We have identified a security incident
affecting the pico hub. <Short description of user impact and what
users should do, e.g. "Do not open new channels at this time.">.
Existing channels can be closed unilaterally via the SDK; see
<docs link>. Next update in 30 min.
```

### Post-mortem template skeleton

```markdown
# <YYYY-MM-DD> — <short title> post-mortem

- Severity: sev1 / sev2 / sev3
- Duration: <start UTC> – <end UTC>
- Author: <name>
- Status: draft / final

## Summary

One-paragraph plain-language description of what happened.

## Impact

- Users affected: count, % of active channels
- Funds at risk: yes/no; amount
- Downtime: duration
- Status-page entries: links

## Timeline (UTC)

- HH:MM — Event
- HH:MM — Event
- HH:MM — Mitigation applied
- HH:MM — Verified resolved

## Root cause

What broke and why. Include code/config references.

## What went well

## What went poorly

## Action items

| ID | Action | Owner | Due | Issue |
|---|---|---|---|---|

## Appendix

Relevant log lines, graphs, tx hashes.
```

Save post-mortems under `docs/incidents/YYYY-MM-DD-<slug>.md`.
