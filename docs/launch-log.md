# Pico launch log

This file is the public launch evidence index. Entries stay `PENDING` until the
operator records the UTC timestamp, command output, tx hashes, or drill artifact
links. Do not mark v1 GA until every high/medium gate under issue #21 is closed.

## Current owner custody

- Status: PENDING
- Expected owner address:
- Owner code check:
- Safe threshold / signer set:
- Evidence:

## Deployer EOA retirement

- Status: PENDING
- Deployer address:
- Final balance after sweep:
- Sweep tx:
- Cold-storage / destruction method:
- Hot-copy locations checked:
- Performed by:
- UTC timestamp:

## Production restore drill

- Status: PENDING
- Workflow run:
- Hub restore artifact:
- Watchtower restore artifact:
- Result:

## Paging drill

- Status: PENDING
- Synthetic alert:
- Alertmanager receiver:
- Acknowledgement timestamp:
- Result:

## Security disclosure drill

- Status: PENDING
- PGP fingerprint:
- Drill advisory:
- Arrival/decrypt/page/ack evidence:
- Result:

## Real-USDC mainnet smoke

- Status: PENDING
- Log file: `docs/mainnet-e2e-test-log.md`
- Run directory:
- Result:

## Round-2 mainnet smoke (ETH + PTST)

- Status: PARTIAL — open + close succeeded on-chain; pay flow blocked by hub indexer gap; ETH lifecycle blocked by CLI/SDK gap. See report for findings.
- Date (UTC): 2026-05-13
- Log file: `docs/mainnet-smoke-round-2-eth-ptst.md`
- Run directory: `.context/round-2-logs/`
- Result: 8 findings (2 HIGH: hub indexer, CLI/SDK ETH). 4 PTST locked in `ClosingUnilateral` channels — recoverable via `finalize` after 2026-05-14.
