/**
 * End-to-end example: open → pay → close against the real-WebSocket mock hub.
 *
 * Run via:
 *   pnpm --filter @tainnel/examples sdk-mock-flow
 *
 * No anvil, no live chain — uses an in-memory ChainAdapter so the entire flow
 * runs in a single Node process.
 */
import {
  type Address,
  type ChainId,
  type Channel,
  type ChannelId,
  type Hex,
  TAIKO_HOODI_CHAIN_ID,
} from '@tainnel/protocol';
import {
  type ChainAdapter,
  ChannelClient,
  type CloseCooperativeTxArgs,
  type CloseReceipt,
  type CloseUnilateralTxArgs,
  MemoryStorage,
  type OpenChannelReceipt,
  type OpenChannelTxArgs,
  ViemWalletAdapter,
  WebSocketTransport,
} from '@tainnel/sdk';
import { TEST_KEYS, startMockHub } from '@tainnel/test-utils';
import { sha256 } from 'viem';
import { createWalletClient, custom } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { taiko } from 'viem/chains';

const verifyingContract: Address = '0x1111111111111111111111111111111111111111';
const chainId: ChainId = TAIKO_HOODI_CHAIN_ID;

class InMemoryChainAdapter implements ChainAdapter {
  readonly chainId = chainId;
  constructor(private readonly userA: Address) {}

  async openChannel(args: OpenChannelTxArgs): Promise<OpenChannelReceipt> {
    return {
      channelId: `0x${'cd'.repeat(32)}` as ChannelId,
      userA: this.userA,
      userB: args.userB,
      token: args.token,
      amountA: args.amountA,
      amountB: args.amountB,
      txHash: `0x${'11'.repeat(32)}` as Hex,
      blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    };
  }
  async closeCooperative(args: CloseCooperativeTxArgs): Promise<CloseReceipt> {
    return { channelId: args.channelId, txHash: `0x${'22'.repeat(32)}` as Hex };
  }
  async closeUnilateral(args: CloseUnilateralTxArgs): Promise<CloseReceipt> {
    return { channelId: args.channelId, txHash: `0x${'33'.repeat(32)}` as Hex };
  }
}

async function main(): Promise<void> {
  // 1. start the mock hub on a free port
  const hub = await startMockHub({
    hubPrivateKey: TEST_KEYS.hub.privateKey,
    chainId,
    verifyingContract,
  });
  console.info(`mock hub listening at ${hub.url}`);

  // 2. register a preimage so the hub can settle our payment
  const preimage = `0x${'aa'.repeat(32)}` as Hex;
  const paymentHash = sha256(preimage) as Hex;
  hub.hub.registerPreimage(preimage, paymentHash);

  // 3. wire up the SDK: viem-backed wallet, in-memory storage, WS transport,
  //    and the in-memory chain adapter.
  const account = privateKeyToAccount(TEST_KEYS.alice.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: taiko,
    transport: custom({ request: async () => null }),
  });
  const wallet = new ViemWalletAdapter({ walletClient });
  const storage = new MemoryStorage();
  const transport = new WebSocketTransport({ url: hub.url });
  const chain = new InMemoryChainAdapter(TEST_KEYS.alice.address);

  let counter = 0;
  const client = new ChannelClient({
    wallet,
    transport,
    storage,
    chain,
    hubAddress: TEST_KEYS.hub.address,
    contract: verifyingContract,
    randomBytes32: () => {
      counter++;
      // first call → preimage we registered, second → htlc id
      return counter === 1 ? preimage : (`0x${counter.toString(16).padStart(64, '0')}` as Hex);
    },
  });

  // 4. open
  const channel: Channel = await client.open({ amount: 1_000_000n });
  console.info(`opened channel ${channel.id}`);
  await storage.saveState(channel.id, {
    state: {
      channelId: channel.id,
      version: 1n,
      balanceA: 1_000_000n,
      balanceB: 1_000_000n,
      htlcs: [],
      finalized: false,
    },
    sigA: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
    sigB: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
  });
  console.info('initial balance:', await client.getBalance(channel.id));

  // 5. pay
  const result = await client.pay(channel.id, {
    to: TEST_KEYS.bob.address,
    amount: 50_000n,
    expiryMs: BigInt(Date.now() + 60_000),
  });
  console.info(`payment settled: htlc=${result.htlcId} preimage=${result.preimage}`);
  console.info('post-pay balance:', await client.getBalance(channel.id));

  // 6. close (cooperative)
  await client.close(channel.id, { cooperative: true });
  const stored = await storage.loadChannel(channel.id);
  console.info(`channel ${channel.id} status=${stored?.status}`);

  // 7. shutdown
  await transport.close();
  await hub.stop();
  console.info('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
