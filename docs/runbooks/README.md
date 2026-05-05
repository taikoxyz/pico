# Pico runbooks (DRAFT — verify before mainnet)

These runbooks are **draft** scaffolds. They list the steps an on-call operator
should take, the files/commands involved, and the verification checks. Treat each
as a fill-in-the-blanks template until the mainnet smoke channel signs off.
Finalization is tracked under
[issue #21](https://github.com/dantaik/pico/issues/21).

| Runbook | Trigger | Severity |
|---|---|---|
| [hub-incident.md](./hub-incident.md) | hub stops accepting WS connections, returns 5xx, or alerts fire | critical |
| [watchtower-down.md](./watchtower-down.md) | watchtower process down, RPC up failing, or oldest pending tx age > deadline / 3 | critical |
| [dispute-response.md](./dispute-response.md) | a unilateral close was observed against one of our channels | critical |
| [key-rotation.md](./key-rotation.md) | scheduled rotation, or suspected hot-key compromise | high |
| [backup-restore.md](./backup-restore.md) | hub DB lost, corrupt, or rolled back; restore from litestream | critical |
| [ownership-transfer.md](./ownership-transfer.md) | one-time mainnet handoff to multisig+timelock, or routine governed upgrade | critical |

Common touch-points:

- Hub config: `apps/hub/.env.example` and `apps/hub/src/config.ts`.
- Watchtower config: `apps/watchtower/.env.example` and `apps/watchtower/src/config.ts`.
- Hub DB: SQLite + litestream in v1.
- Metrics: `/metrics` on the hub; `/metrics` and `/health` on the watchtower.
- Logs: structured pino JSON; tail with `kubectl logs -n pico ...` on GKE,
  `docker logs -f` locally, or the platform UI.

Replace the `TODO(infra)` / `TODO(contact)` placeholders in individual
runbooks with real GKE, PagerDuty/Linear, and maintainer endpoints, and
validate each runbook with a fire drill before running real funds. Tracked under
[issue #21](https://github.com/dantaik/pico/issues/21).
