# @tainnel/sdk

Client SDK for tainnel payment channels. Works in browsers and Node, depends on **viem**
for chain interaction. Composes the pure `@tainnel/state-machine` library with pluggable
transports (Hub WebSocket, Nostr relay) and pluggable persistence (memory, IndexedDB,
file).

## Quickstart

```ts
import { ChannelClient, MemoryStorage, WebSocketTransport } from '@tainnel/sdk';
import { createWalletClient, http } from 'viem';

const wallet = createWalletClient({ account, chain, transport: http() });
const client = new ChannelClient({
  wallet,
  storage: new MemoryStorage(),
  transport: new WebSocketTransport('wss://hub.example.com'),
});

await client.open({ counterparty: hubAddress, amount: 100_000_000n });
await client.pay({ to: '0xrecipient', amount: 1_000_000n });
```
