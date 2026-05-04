# @pico/sdk

Browser- and Node-compatible client SDK for opening, paying, and closing pico
1-hop payment channels on Taiko L2.

## Quickstart

```ts
import { TAIKO_MAINNET_CHAIN_ID, CONTRACT_ADDRESSES, USDC_TOKENS } from '@pico/protocol';
import {
  ChannelClient,
  FileStorage,
  ViemChainAdapter,
  WebSocketTransport,
} from '@pico/sdk';
import { InMemorySigner } from '@pico/test-utils'; // or your own Signer
import { createPublicClient, createWalletClient, http } from 'viem';
import { taiko } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.PRIV_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: taiko, transport: http() });
const walletClient = createWalletClient({ chain: taiko, transport: http(), account });

const client = new ChannelClient({
  signer: new InMemorySigner(process.env.PRIV_KEY as `0x${string}`),
  transport: new WebSocketTransport({ url: 'wss://hub.example.com/v1' }),
  storage: new FileStorage({ root: '~/.pico/state' }),
  chain: new ViemChainAdapter({
    publicClient,
    walletClient,
    // PaymentChannel is the on-chain entrypoint for open/close/dispute calls.
    paymentChannelAddress: CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID].PaymentChannel,
  }),
  chainId: TAIKO_MAINNET_CHAIN_ID,
  // EIP-712 verifyingContract is the Adjudicator: that contract verifies signed
  // states on-chain via verifyDualSig(). Using PaymentChannel here would produce
  // signatures the deployed contracts reject.
  verifyingContract: CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID].Adjudicator,
  defaultToken: USDC_TOKENS[TAIKO_MAINNET_CHAIN_ID].address,
});

const channel = await client.open({ counterparty: HUB_ADDRESS, amount: 10_000_000n });
const result = await client.pay({ invoice });   // pattern A: invoice
// or: client.pay({ to, amount, keysend: true, recipientEncryptionPubkey });
await client.close(channel.id);
```

A full runnable example against a mock hub lives at
[`examples/sdk-mock-flow.ts`](../../examples/sdk-mock-flow.ts) (no network or
Anvil needed).

## What's in the box

- `ChannelClient` — open/pay/close + listen-mode HTLC handling + typed events.
- `Signer` interface — single key-custody seam. v1 ships `InMemorySigner` from
  `@pico/test-utils` for tests; the production hot-key backend lives in
  `apps/cli`. Phase-2 backends (KMS, Turnkey, Nitro Enclave, EIP-7702) implement
  the same interface with no SDK changes.
- Three storage backends: `MemoryStorage`, `FileStorage` (Node, atomic-rename),
  and `IndexedDBStorage` (browser, hand-rolled — no Dexie/idb in your bundle).
- Real `WebSocketTransport`: isomorphic (browser global or `ws` in Node),
  exponential-backoff reconnect (200ms→30s, jittered), heartbeat ping every
  30s, request/response framing, multi-handler dispatch, reconnect callback
  for state replay.
- `ChainAdapter` interface plus `ViemChainAdapter` (real on-chain) and
  `MockChainAdapter` (test-utils) — both let `ChannelClient` stay a pure-logic
  layer over a swappable chain seam.
- `HubMessage` discriminated union — single source of truth for the SDK↔hub
  wire format. The mock hub in `@pico/test-utils` and the production hub
  in `apps/hub` (P5) both consume this.
- Invoice (Pattern A) + keysend (Pattern B) flows. Keysend payloads are NaCl
  sealed boxes (`tweetnacl`) addressed to a recipient X25519 pubkey published
  in the subscribe handshake.

## Safety guarantees

**Persist-before-send.** `ChannelClient.pay()` writes the new signed state to
storage *before* shipping the signature to the hub. If the SDK signs and then
crashes, the next process startup finds the new state on disk and resumes
correctly. Never the other way around: a hub holding a signature for a state
the SDK has lost is the worst case (the hub could post that state on-chain
without the SDK being able to dispute). See `client.crash.test.ts` for the
test that asserts this.

**Same-address invariant.** `Signer.address()` MUST return one of the channel's
parties (`channel.userA` or `channel.userB`). Otherwise EIP-712 signature
verification fails on-chain. The SDK signs `ChannelState`, `Update`,
`CooperativeClose`, `Htlc`, and `Invoice` typed-data structures — every
signature must come from a key whose address matches the on-chain party.

## Not the right fit?

If you don't want to write TypeScript, the `pico` CLI (P7, in
`apps/cli`) shells out to the same SDK and exposes `pico pay`,
`pico listen`, `pico close`. Use `--json` for structured output you can
parse from any language.
