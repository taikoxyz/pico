import {
  type Address,
  EMPTY_HTLCS_ROOT,
  type Hash,
  type Hex,
  ZERO_ADDRESS,
} from '@inferenceroom/pico-protocol';
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
    const getBlock = vi
      .fn()
      .mockResolvedValue({ timestamp: 1_700_000_000n, baseFeePerGas: 1_000_000_000n });
    const getGasPrice = vi.fn().mockResolvedValue(1_000_000_000n);

    const adapter = new ViemChainAdapter({
      paymentChannelAddress: PAYMENT_CHANNEL,
      publicClient: {
        waitForTransactionReceipt,
        getBlock,
        getGasPrice,
      } as unknown as PublicClient,
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

  it('passes value: amountA when token is native ETH (address(0))', async () => {
    const writeContract = vi.fn().mockResolvedValue(TX_HASH);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({
      blockNumber: 100n,
      logs: [makeOpenedLog()],
    });
    const getBlock = vi
      .fn()
      .mockResolvedValue({ timestamp: 1_700_000_000n, baseFeePerGas: 1_000_000_000n });
    const getGasPrice = vi.fn().mockResolvedValue(1_000_000_000n);

    const adapter = new ViemChainAdapter({
      paymentChannelAddress: PAYMENT_CHANNEL,
      publicClient: {
        waitForTransactionReceipt,
        getBlock,
        getGasPrice,
      } as unknown as PublicClient,
      walletClient: {
        writeContract,
        account: { address: USER_A } as unknown as WalletClient['account'],
        chain: fakeChain,
      } as unknown as WalletClient,
    });

    await adapter.openChannel({
      userB: USER_B,
      token: ZERO_ADDRESS,
      amountA: 12_345n,
      amountB: 0n,
    });
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'openChannel', value: 12_345n }),
    );
  });

  it('inflates maxFeePerGas to 4× basefee + tip on EIP-1559 chains', async () => {
    const writeContract = vi.fn().mockResolvedValue(TX_HASH);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({
      blockNumber: 100n,
      logs: [makeOpenedLog()],
    });
    const getBlock = vi
      .fn()
      .mockResolvedValue({ timestamp: 1_700_000_000n, baseFeePerGas: 50_000_000n });
    const getGasPrice = vi.fn().mockResolvedValue(50_000_000n);

    const adapter = new ViemChainAdapter({
      paymentChannelAddress: PAYMENT_CHANNEL,
      publicClient: {
        waitForTransactionReceipt,
        getBlock,
        getGasPrice,
      } as unknown as PublicClient,
      walletClient: {
        writeContract,
        account: { address: USER_A } as unknown as WalletClient['account'],
        chain: fakeChain,
      } as unknown as WalletClient,
    });

    await adapter.openChannel({
      userB: USER_B,
      token: TOKEN,
      amountA: 1_000n,
      amountB: 0n,
    });

    const call = writeContract.mock.calls[0]?.[0] as {
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
      gasPrice?: bigint;
    };
    // 50_000_000 * 4 + 1_000_000 (tip) = 201_000_000
    expect(call?.maxFeePerGas).toBe(201_000_000n);
    expect(call?.maxPriorityFeePerGas).toBe(1_000_000n);
    expect(call?.gasPrice).toBeUndefined();
  });

  it('falls back to gasPrice when block has no baseFeePerGas', async () => {
    const writeContract = vi.fn().mockResolvedValue(TX_HASH);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({
      blockNumber: 100n,
      logs: [makeOpenedLog()],
    });
    // baseFeePerGas omitted (pre-EIP-1559 chain)
    const getBlock = vi.fn().mockResolvedValue({ timestamp: 1_700_000_000n });
    const getGasPrice = vi.fn().mockResolvedValue(100_000_000n);

    const adapter = new ViemChainAdapter({
      paymentChannelAddress: PAYMENT_CHANNEL,
      publicClient: {
        waitForTransactionReceipt,
        getBlock,
        getGasPrice,
      } as unknown as PublicClient,
      walletClient: {
        writeContract,
        account: { address: USER_A } as unknown as WalletClient['account'],
        chain: fakeChain,
      } as unknown as WalletClient,
    });

    await adapter.openChannel({
      userB: USER_B,
      token: TOKEN,
      amountA: 1_000n,
      amountB: 0n,
    });

    const call = writeContract.mock.calls[0]?.[0] as {
      gasPrice?: bigint;
      maxFeePerGas?: bigint;
    };
    // 100_000_000 * 4 = 400_000_000
    expect(call?.gasPrice).toBe(400_000_000n);
    expect(call?.maxFeePerGas).toBeUndefined();
  });

  it('does not pass value when token is an ERC-20', async () => {
    const writeContract = vi.fn().mockResolvedValue(TX_HASH);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({
      blockNumber: 100n,
      logs: [makeOpenedLog()],
    });
    const getBlock = vi
      .fn()
      .mockResolvedValue({ timestamp: 1_700_000_000n, baseFeePerGas: 1_000_000_000n });
    const getGasPrice = vi.fn().mockResolvedValue(1_000_000_000n);

    const adapter = new ViemChainAdapter({
      paymentChannelAddress: PAYMENT_CHANNEL,
      publicClient: {
        waitForTransactionReceipt,
        getBlock,
        getGasPrice,
      } as unknown as PublicClient,
      walletClient: {
        writeContract,
        account: { address: USER_A } as unknown as WalletClient['account'],
        chain: fakeChain,
      } as unknown as WalletClient,
    });

    await adapter.openChannel({
      userB: USER_B,
      token: TOKEN,
      amountA: 1_000_000n,
      amountB: 0n,
    });
    const call = writeContract.mock.calls[0]?.[0] as { value?: bigint };
    expect(call?.value ?? 0n).toBe(0n);
  });
});

describe('ViemChainAdapter.topUp', () => {
  function makeToppedUpLog(newVersion = 2n, amount = 500n): Log {
    const topics = encodeEventTopics({
      abi: paymentChannelAbi,
      eventName: 'ToppedUp',
      args: { channelId: CHANNEL_ID, depositor: USER_A },
    });
    const data =
      `0x${pad(toHex(amount), { size: 32 }).slice(2)}${pad(toHex(newVersion), { size: 32 }).slice(2)}` as Hex;
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

  const sentinelSig = {
    r: `0x${'00'.repeat(32)}` as Hex,
    s: `0x${'00'.repeat(32)}` as Hex,
    v: 0n,
    yParity: 0,
  } as const;
  const prev = {
    state: {
      channelId: CHANNEL_ID,
      version: 1n,
      balanceA: 1_000n,
      balanceB: 0n,
      htlcs: [],
      htlcsCount: 0,
      htlcsTotalLocked: 0n,
      finalized: false,
    },
    sigA: sentinelSig,
    sigB: sentinelSig,
  };
  const next = {
    state: {
      channelId: CHANNEL_ID,
      version: 2n,
      balanceA: 1_500n,
      balanceB: 0n,
      htlcs: [],
      htlcsCount: 0,
      htlcsTotalLocked: 0n,
      finalized: false,
    },
    sigA: sentinelSig,
    sigB: sentinelSig,
  };

  it('skips approve and passes value: amount when token is native ETH', async () => {
    const writeContract = vi.fn().mockResolvedValue(TX_HASH);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({
      blockNumber: 100n,
      logs: [makeToppedUpLog()],
    });

    const adapter = new ViemChainAdapter({
      paymentChannelAddress: PAYMENT_CHANNEL,
      publicClient: {
        waitForTransactionReceipt,
        getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 1_000_000_000n }),
        getGasPrice: vi.fn().mockResolvedValue(1_000_000_000n),
        readContract: vi.fn().mockResolvedValue({ status: 1 }),
      } as unknown as PublicClient,
      walletClient: {
        writeContract,
        account: { address: USER_A } as unknown as WalletClient['account'],
        chain: fakeChain,
      } as unknown as WalletClient,
    });

    await adapter.topUp({
      channelId: CHANNEL_ID,
      token: ZERO_ADDRESS,
      amount: 500n,
      prev,
      next,
    });

    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'topUp', value: 500n }),
    );
  });

  it('calls approve and omits value when token is an ERC-20', async () => {
    const writeContract = vi.fn().mockResolvedValue(TX_HASH);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({
      blockNumber: 100n,
      logs: [makeToppedUpLog()],
    });

    const adapter = new ViemChainAdapter({
      paymentChannelAddress: PAYMENT_CHANNEL,
      publicClient: {
        waitForTransactionReceipt,
        getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 1_000_000_000n }),
        getGasPrice: vi.fn().mockResolvedValue(1_000_000_000n),
        readContract: vi.fn().mockResolvedValue({ status: 1 }),
      } as unknown as PublicClient,
      walletClient: {
        writeContract,
        account: { address: USER_A } as unknown as WalletClient['account'],
        chain: fakeChain,
      } as unknown as WalletClient,
    });

    await adapter.topUp({
      channelId: CHANNEL_ID,
      token: TOKEN,
      amount: 500n,
      prev,
      next,
    });

    expect(writeContract).toHaveBeenCalledTimes(2);
    expect(writeContract.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ functionName: 'approve' }),
    );
    const topupCall = writeContract.mock.calls[1]?.[0] as { value?: bigint };
    expect(topupCall?.value ?? 0n).toBe(0n);
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
      htlcsCount: 0,
      htlcsTotalLocked: 0n,
      finalized: true,
    });
    const b = encodeChannelStateForOnChain({
      channelId: CHANNEL_ID,
      version: 3n,
      balanceA: 100n,
      balanceB: 50n,
      htlcs: [],
      htlcsCount: 0,
      htlcsTotalLocked: 0n,
      finalized: true,
    });
    expect(a).toBe(b);
    expect(a).toContain(EMPTY_HTLCS_ROOT.slice(2));
  });
});
