# @tainnel/sdk

Client SDK for tainnel payment channels. Works in browsers and Node, depends on
**viem** for chain interaction. Composes the pure `@tainnel/state-machine`
library with pluggable transports (Hub WebSocket, in-memory pipe for tests) and
pluggable persistence (memory, file).

## Quickstart (Node + mock hub for tests)

```ts
import {
  ChannelClient,
  FileStorage,
  ViemWalletAdapter,
  createInMemoryPipe,
} from '@tainnel/sdk';
import { createMockHub, TEST_KEYS } from '@tainnel/test-utils';
import { createWalletClient, custom } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { taiko } from 'viem/chains';

const account = privateKeyToAccount(TEST_KEYS.alice.privateKey);
const walletClient = createWalletClient({
  account,
  chain: taiko,
  transport: custom({ request: async () => null }),
});
const wallet = new ViemWalletAdapter({ walletClient });
const storage = await FileStorage.createNode('./.tainnel/data');

const pipe = createInMemoryPipe();
const hub = createMockHub({
  hubPrivateKey: TEST_KEYS.hub.privateKey,
  chainId: 167009,
  verifyingContract: '0x...',
});
hub.attach({
  send: pipe.server.send.bind(pipe.server),
  onMessage: pipe.server.onMessage.bind(pipe.server),
  close: pipe.server.close.bind(pipe.server),
});

const client = new ChannelClient({
  wallet,
  transport: pipe.client,
  storage,
  chain: yourChainAdapter,
  hubAddress: TEST_KEYS.hub.address,
  contract: '0x...',
});

const channel = await client.open({ amount: 1_000_000n });
await client.pay(channel.id, { to: '0x...', amount: 1_000n, expiryMs: 9_999_999_999_999n });
await client.close(channel.id, { cooperative: true });
```

For production, swap `createInMemoryPipe()` for `new WebSocketTransport({ url: 'wss://hub.example.com' })`.

## Key safety property — D4.3 (persist before send)

`ChannelClient.pay` always persists the new signed state to storage **before**
broadcasting the corresponding payment message to the hub. If the process
crashes after sign-and-send but before persistence, the hub could later post
the new state on-chain and we'd be unable to challenge it. The
`persist-before-send` test in `client.test.ts` enforces this invariant.

## Components

- `MemoryStorage`, `FileStorage` — `ChannelStorage` implementations.
- `WebSocketTransport`, `createInMemoryPipe`, `requestReply` — `Transport`
  primitives. WebSocket has automatic backoff (200 ms → 30 s, jittered),
  heartbeat (every 30 s, reconnect on 2 missed), and pre-open send queueing.
- `ViemWalletAdapter` — `WalletAdapter` over a viem `WalletClient`.
- `ChainAdapter` — interface that abstracts contract calls (open / cooperative
  close / unilateral close) so unit tests can mock without anvil. Production
  callers ship their own (e.g., a `ViemChainAdapter` over a `PublicClient` +
  `WalletClient`).
- `ChannelClient` — the front door: `.open()`, `.pay()`, `.close()`,
  `.list()`, `.getBalance()`.
