import { type Address, EMPTY_HTLCS_ROOT, type Hash, type Hex } from '@pico/protocol';
import {
  type Chain,
  type Log,
  type PublicClient,
  type WalletClient,
  encodeEventTopics,
  pad,
  toHex,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ViemChainAdapter, encodeChannelStateForOnChain } from './chain-adapter.js';
import { paymentChannelAbi } from './contracts-abi.js';

const PAYMENT_CHANNEL = '0x1111111111111111111111111111111111111111' as Address;
const USER_A = '0x00000000000000000000000000000000000000a1' as Address;
const USER_B = '0x00000000000000000000000000000000000000b0' as Address;
const TOKEN = '0x07d83526730c7438048D55A4fc0b850e2aaB6f0b' as Address;
const CHANNEL_ID = '0x000000000000000000000000000000000000000000000000000000000000abcd' as Hex;
const TX_HASH = `0x${'cd'.repeat(32)}` as Hash;
const fakeChain = { id: 167000, name: 'taiko' } as unknown as Chain;

function makeOpenedLog(): Log {
  const topics = encodeEventTopics({
    abi: paymentChannelAbi,
    eventName: 'ChannelOpened',
    args: { channelId: CHANNEL_ID, userA: USER_A, userB: USER_B },
  });
  const data =
    `0x${pad(TOKEN, { size: 32 }).slice(2)}${pad(toHex(1_000_000n), { size: 32 }).slice(2)}${pad(toHex(0n), { size: 32 }).slice(2)}` as Hex;
  return {
    address: PAYMENT_CHANNEL,
    topics: topics as readonly Hex[],
    data,
    blockNumber: 100n,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    blockHash: `0x${'aa'.repeat(32)}` as Hex,
    removed: false,
  } as unknown as Log;
}

describe('ViemChainAdapter.openChannel', () => {
  it('parses ChannelOpened event into the result', async () => {
    const writeContract = vi.fn().mockResolvedValue(TX_HASH);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({
      blockNumber: 100n,
      logs: [makeOpenedLog()],
    });
    const getBlock = vi.fn().mockResolvedValue({ timestamp: 1_700_000_000n });

    const adapter = new ViemChainAdapter({
      paymentChannelAddress: PAYMENT_CHANNEL,
      publicClient: { waitForTransactionReceipt, getBlock } as unknown as PublicClient,
      walletClient: {
        writeContract,
        account: { address: USER_A } as unknown as WalletClient['account'],
        chain: fakeChain,
      } as unknown as WalletClient,
    });

    const res = await adapter.openChannel({
      userB: USER_B,
      token: TOKEN,
      amountA: 1_000_000n,
      amountB: 0n,
    });
    expect(res.channelId).toBe(CHANNEL_ID);
    expect(res.userA.toLowerCase()).toBe(USER_A);
    expect(res.userB.toLowerCase()).toBe(USER_B);
    expect(res.amountA).toBe(1_000_000n);
    expect(res.amountB).toBe(0n);
    expect(res.txHash).toBe(TX_HASH);
    expect(res.openedAtMs).toBe(1_700_000_000_000n);
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'openChannel' }),
    );
  });

  it('throws if walletClient has no account', async () => {
    const adapter = new ViemChainAdapter({
      paymentChannelAddress: PAYMENT_CHANNEL,
      publicClient: {} as unknown as PublicClient,
      walletClient: { account: undefined, chain: fakeChain } as unknown as WalletClient,
    });
    await expect(
      adapter.openChannel({ userB: USER_B, token: TOKEN, amountA: 1n, amountB: 0n }),
    ).rejects.toThrow(/no account/);
  });

  it('throws if walletClient has no chain', async () => {
    const adapter = new ViemChainAdapter({
      paymentChannelAddress: PAYMENT_CHANNEL,
      publicClient: {} as unknown as PublicClient,
      walletClient: {
        account: { address: USER_A } as unknown as WalletClient['account'],
        chain: undefined,
      } as unknown as WalletClient,
    });
    await expect(
      adapter.openChannel({ userB: USER_B, token: TOKEN, amountA: 1n, amountB: 0n }),
    ).rejects.toThrow(/no chain/);
  });
});

describe('encodeChannelStateForOnChain edge cases', () => {
  it('produces the same encoding for two equivalent states', () => {
    const a = encodeChannelStateForOnChain({
      channelId: CHANNEL_ID,
      version: 3n,
      balanceA: 100n,
      balanceB: 50n,
      htlcs: [],
      finalized: true,
    });
    const b = encodeChannelStateForOnChain({
      channelId: CHANNEL_ID,
      version: 3n,
      balanceA: 100n,
      balanceB: 50n,
      htlcs: [],
      finalized: true,
    });
    expect(a).toBe(b);
    expect(a).toContain(EMPTY_HTLCS_ROOT.slice(2));
  });
});
