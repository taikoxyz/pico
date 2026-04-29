// Runnable end-to-end demo of @tainnel/sdk against a mock hub + mock chain.
// Usage from repo root:
//   pnpm --filter @tainnel/sdk build && pnpm --filter @tainnel/test-utils build
//   pnpm tsx examples/sdk-mock-flow.ts

import { TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';
import {
  ChannelClient,
  MemoryStorage,
  WebSocketTransport,
  generateKeysendKeypair,
} from '@tainnel/sdk';
import { InMemorySigner, MockChainAdapter, startMockHub } from '@tainnel/test-utils';

const ALICE_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const BOB_KEY = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CHAIN_ID = TAIKO_MAINNET_CHAIN_ID;
const VERIFYING_CONTRACT = '0x07B32f52523Fdf0780821595422DccEF31FA2335' as const;
const TOKEN = '0x07d83526730c7438048D55A4fc0b850e2aaB6f0b' as const;

async function main(): Promise<void> {
  const hub = await startMockHub({ chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT });
  console.info(`mock hub listening at ${hub.url}`);

  const aliceSigner = new InMemorySigner(ALICE_KEY);
  const aliceAddress = await aliceSigner.address();
  const aliceStorage = new MemoryStorage();
  const aliceChain = new MockChainAdapter({
    chainId: CHAIN_ID,
    contract: VERIFYING_CONTRACT,
    userA: aliceAddress,
  });
  const aliceTransport = new WebSocketTransport({ url: hub.url, autoReconnect: false });
  const alice = new ChannelClient({
    signer: aliceSigner,
    transport: aliceTransport,
    storage: aliceStorage,
    chain: aliceChain,
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    defaultToken: TOKEN,
  });

  const bobKeysend = generateKeysendKeypair();
  const bobSigner = new InMemorySigner(BOB_KEY);
  const bobAddress = await bobSigner.address();
  const bobStorage = new MemoryStorage();
  const bobChain = new MockChainAdapter({
    chainId: CHAIN_ID,
    contract: VERIFYING_CONTRACT,
    userA: bobAddress,
  });
  const bobTransport = new WebSocketTransport({ url: hub.url, autoReconnect: false });
  const bob = new ChannelClient({
    signer: bobSigner,
    transport: bobTransport,
    storage: bobStorage,
    chain: bobChain,
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    defaultToken: TOKEN,
    encryptionPubkey: bobKeysend.publicKey,
    encryptionSecretKey: bobKeysend.secretKey,
  });

  bob.on('htlc:settled', (e) => console.info(`bob settled htlc ${e.htlc.id} (${e.direction})`));

  console.info('alice opens a channel with bob (amount = 1_000_000)');
  const channel = await alice.open({
    counterparty: bobAddress,
    amount: 1_000_000n,
    token: TOKEN,
  });
  // mirror channel + state to bob's local store; in production bob learns this from the chain
  await bobStorage.saveChannel(channel);
  const aliceInitialState = await aliceStorage.loadLatestState(channel.id);
  if (!aliceInitialState) throw new Error('alice has no initial state after open');
  await bobStorage.saveState(channel.id, aliceInitialState);
  hub.registerChannel(channel);
  await bob.ensureSubscribed([channel.id]);
  console.info(`channel opened: ${channel.id}`);

  console.info('bob creates an invoice for 100');
  const { invoice } = await bob.createInvoice({ amount: 100n, memo: 'tainnel demo' });

  console.info('alice pays the invoice');
  const paid = await alice.pay({ invoice });
  console.info(`payment settled: preimage = ${paid.preimage}`);

  console.info(`bob's incoming balance:`, await bob.getBalance(channel.id));
  console.info(`alice's remaining balance:`, await alice.getBalance(channel.id));

  console.info('alice closes cooperatively');
  await alice.close(channel.id);

  await aliceTransport.close();
  await bobTransport.close();
  await hub.stop();
  console.info('done');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
