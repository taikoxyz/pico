# Pico v1.0 release notes draft

Status: PENDING. Do not publish until issue #49 passes and all high/medium gates
under issue #21 are closed.

## Highlights

- Trustless 1-hop state channel payments on Taiko mainnet.
- CLI-first agent runtime for opening channels, paying, listening, and closing.
- Hub and watchtower deployed through versioned GKE releases.
- Litestream-backed SQLite recovery for hub and watchtower.
- Prometheus, Alertmanager, and Grafana monitoring stack.

## Launch evidence required before publication

- `docs/launch-log.md` complete.
- `docs/mainnet-e2e-test-log.md` committed with real tx hashes.
- PGP key published and `SECURITY.md` fingerprint filled.
- Production restore, paging, and security disclosure drills recorded.
- Deployer/current-owner key custody documented.

## Known limits

- No native token, governance, bridges, MCP, or x402 integration.
- GKE production operation is v1's supported deployment path.
- Low-priority post-GA audit polish remains tracked on GitHub.
