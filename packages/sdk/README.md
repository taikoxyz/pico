# @tainnel/sdk

Client SDK for tainnel payment channels. Works in browsers and Node, depends on
**viem** for chain interaction. Composes the pure `@tainnel/state-machine`
library with pluggable transports (Hub WebSocket, in-memory pipe for tests),
pluggable persistence (Memory, File, IndexedDB), and pluggable wallets
(`ViemWalletAdapter`, `BrowserWalletAdapter`).

## Wallet adapter must match a channel party

Sign-typed-data calls go to whatever `WalletAdapter` you pass. **The address
the adapter exposes must be `userA` or `userB` of the channel.** If it isn't,
the contract's `Adjudicator.verifyDualSig` will reject every signature and the
hub will reject every state update — payments will fail, closes will not
finalize. Always confirm `await adapter.getAddress()` matches a channel party
before calling `open`/`pay`/`close`.

## Quickstart

The runnable end-to-end version of this snippet lives at
`examples/sdk-mock-flow.ts` (run via
`pnpm --filter @tainnel/examples sdk-mock-flow`). It boots a real-WebSocket
mock hub, opens a channel, pays, and closes — all in-process, no anvil.

```ts
import { ChannelClient, MemoryStorage, ViemWalletAdapter, WebSocketTransport } from '@tainnel/sdk';
import { TEST_KEYS, startMockHub } from '@tainnel/test-utils';
import { createWalletClient, custom, sha256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { taiko } from 'viem/chains';

const hub = await startMockHub({
  hubPrivateKey: TEST_KEYS.hub.privateKey,
  chainId: 167009,
  verifyingContract: '0x...',
});
const preimage = '0x' + 'aa'.repeat(32);
hub.hub.registerPreimage(preimage, sha256(preimage));

const account = privateKeyToAccount(TEST_KEYS.alice.privateKey);
const walletClient = createWalletClient({ account, chain: taiko, transport: custom({ request: async () => null }) });
const wallet = new ViemWalletAdapter({ walletClient });

const client = new ChannelClient({
  wallet,
  storage: new MemoryStorage(),
  transport: new WebSocketTransport({ url: hub.url }),
  chain: yourChainAdapter, // see InMemoryChainAdapter in examples/sdk-mock-flow.ts
  hubAddress: TEST_KEYS.hub.address,
  contract: '0x...',
});

const channel = await client.open({ amount: 1_000_000n });
await client.pay(channel.id, { to: '0x...recipient', amount: 50_000n });
await client.close(channel.id, { cooperative: true });

await hub.stop();
```

## Components

- **Storage** — `MemoryStorage`, `FileStorage` (Node atomic-rename),
  `IndexedDBStorage` (browser; pass `opts.indexedDB` for tests).
- **Transport** — `WebSocketTransport`, `createInMemoryPipe`,
  `requestReply`. WebSocket has automatic backoff (200 ms → 30 s, jittered),
  heartbeat (30 s, reconnect on 2 missed), and pre-open send queueing.
- **Wallet** — `ViemWalletAdapter` (over a viem `WalletClient`),
  `BrowserWalletAdapter` (EIP-1193, e.g. `window.ethereum`).
- **ChainAdapter** — interface that abstracts contract calls (open /
  cooperative close / unilateral close / optional `waitForFinalized`).
  Production callers ship their own concrete implementation; tests use a
  mock.
- **ChannelClient** — `.open()`, `.pay()`, `.close()`, `.list()`,
  `.getBalance()`, `.waitForFinalized()`.

## Key safety property — D4.3 (persist before send)

`ChannelClient.pay` always persists the new signed state to storage **before**
broadcasting the corresponding payment message to the hub. If the process
crashes after sign-and-send but before persistence, the hub could later post
the new state on-chain and we'd be unable to challenge it. The
`persist-before-send` test in `client.test.ts` enforces this invariant.

If the hub never replies, the SDK's `pay()` runs a local `failHtlc`,
re-signs the failed-state, persists it, and then throws
`PaymentTimeoutError`. The on-disk state is always consistent with what the
hub has seen.

## Finalization semantics — `waitForFinalized`

- **Cooperative close** finalizes on the receipt of `closeCooperative` —
  `client.close(id, { cooperative: true })` returns once status is `closed`.
- **Unilateral close** opens a dispute window (configured per channel,
  default 24 h). After the window, anyone can call `finalize()` on the
  contract; this emits `ChannelFinalized`. `client.close(id, { cooperative:
  false })` returns immediately after the unilateral tx is mined; callers
  may opt into `await client.waitForFinalized(id)` to block until the
  on-chain `ChannelFinalized` event arrives. The chain adapter must
  implement the optional `waitForFinalized` method, otherwise the call
  throws `WaitForFinalizedUnsupportedError`.
