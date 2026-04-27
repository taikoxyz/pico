# @tainnel/watchtower

Standalone monitoring service that subscribes to `PaymentChannel` events on-chain,
detects when a counterparty publishes an old (fraudulent) state, and submits a penalty
transaction before the dispute window closes. Stores encrypted state backups so it can
respond on behalf of the user even when the user is offline.

Two run modes:

- **Self-hosted** — single user, local key, watches only that user's channels.
- **Service** — multi-tenant, accepts encrypted state blobs from many users.
