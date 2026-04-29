import type { Address, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import {
  type Chain,
  type PublicClient,
  type WalletClient,
  decodeFunctionData,
  encodeEventTopics,
  encodeFunctionData,
  toBytes,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { taikoHoodi } from 'viem/chains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERC20_ABI, PAYMENT_CHANNEL_ABI, ViemChainAdapter } from './chain-viem.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const account = privateKeyToAccount(PK);
const counterparty = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const contract = '0x1111111111111111111111111111111111111111' as Address;
const token = '0x2222222222222222222222222222222222222222' as Address;
const channelId = `0x${'cd'.repeat(32)}` as ChannelId;
const txHash = `0x${'11'.repeat(32)}` as Hex;

interface CapturedTx {
  to: Address;
  data: Hex;
}

interface MockClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  txs: CapturedTx[];
  reads: Array<{ address: Address; functionName: string }>;
  setAllowance(value: bigint): void;
  setOpenedReceipt(): void;
  setPlainReceipt(): void;
  setRevertedReceipt(): void;
  setBlockTimestamp(ts: bigint): void;
  setEvents(events: ReadonlyArray<Record<string, unknown>>): void;
  setBlockNumber(n: bigint): void;
}

function makeClients(): MockClients {
  const txs: CapturedTx[] = [];
  const reads: Array<{ address: Address; functionName: string }> = [];
  let allowance = 0n;
  let receiptStatus: 'success' | 'reverted' = 'success';
  let receiptLogs: ReadonlyArray<{ address: Address; data: Hex; topics: Hex[] }> = [];
  let blockTs = 1_700_000_000n;
  let events: ReadonlyArray<Record<string, unknown>> = [];
  let blockNumber = 100n;

  const publicClient = {
    async readContract(args: { address: Address; functionName: string }) {
      reads.push({ address: args.address, functionName: args.functionName });
      if (args.functionName === 'allowance') return allowance;
      throw new Error(`unhandled readContract ${args.functionName}`);
    },
    async waitForTransactionReceipt() {
      return {
        status: receiptStatus,
        transactionHash: txHash,
        blockNumber,
        logs: receiptLogs,
      };
    },
    async getBlock() {
      return { timestamp: blockTs };
    },
    async getBlockNumber() {
      return blockNumber;
    },
    async getContractEvents() {
      return events;
    },
  } as unknown as PublicClient;

  const walletClient = {
    async sendTransaction(args: { to: Address; data: Hex }) {
      txs.push({ to: args.to, data: args.data });
      return txHash;
    },
  } as unknown as WalletClient;

  return {
    publicClient,
    walletClient,
    txs,
    reads,
    setAllowance(v) {
      allowance = v;
    },
    setOpenedReceipt() {
      const topics = encodeEventTopics({
        abi: PAYMENT_CHANNEL_ABI,
        eventName: 'ChannelOpened',
        args: { channelId, userA: account.address, userB: counterparty },
      });
      // Encode the non-indexed args (token, amountA, amountB) into data
      const data = encodeFunctionData({
        abi: PAYMENT_CHANNEL_ABI,
        functionName: 'openChannel',
        args: [counterparty, token, 5_000_000n, 0n],
      });
      // Replace the function selector area with non-indexed event data — easier:
      // build the data via abi-encoded fallback. The decodeEventLog call only
      // needs (token, amountA, amountB) as non-indexed; encode them directly.
      const nonIndexed = encodeNonIndexedChannelOpened(token, 5_000_000n, 0n);
      void data;
      receiptLogs = [{ address: contract, data: nonIndexed, topics: topics as Hex[] }];
    },
    setPlainReceipt() {
      receiptLogs = [];
    },
    setRevertedReceipt() {
      receiptStatus = 'reverted';
    },
    setBlockTimestamp(ts) {
      blockTs = ts;
    },
    setEvents(e) {
      events = e;
    },
    setBlockNumber(n) {
      blockNumber = n;
    },
  };
}

function encodeNonIndexedChannelOpened(tokenAddr: Address, amountA: bigint, amountB: bigint): Hex {
  // ABI-encode (address, uint256, uint256) for the non-indexed event params.
  const padHex = (h: string) => h.padStart(64, '0');
  const stripAddress = tokenAddr.slice(2).toLowerCase();
  const encA = amountA.toString(16);
  const encB = amountB.toString(16);
  return `0x${padHex(stripAddress)}${padHex(encA)}${padHex(encB)}` as Hex;
}

function makeAdapter(clients: MockClients) {
  return new ViemChainAdapter({
    walletClient: clients.walletClient,
    publicClient: clients.publicClient,
    chain: taikoHoodi as Chain,
    account,
    finalizePollMs: 1,
  });
}

function makeSignedState(): SignedState {
  return {
    state: {
      channelId,
      version: 3n,
      balanceA: 4_000_000n,
      balanceB: 1_000_000n,
      htlcs: [],
      finalized: true,
    },
    sigA: { r: `0x${'aa'.repeat(32)}` as Hex, s: `0x${'bb'.repeat(32)}` as Hex, v: 27 },
    sigB: { r: `0x${'cc'.repeat(32)}` as Hex, s: `0x${'dd'.repeat(32)}` as Hex, v: 28 },
  };
}

describe('ViemChainAdapter', () => {
  let clients: MockClients;
  beforeEach(() => {
    clients = makeClients();
  });

  it('exposes the chainId from the chain definition', () => {
    const adapter = makeAdapter(clients);
    expect(adapter.chainId).toBe(taikoHoodi.id);
  });

  describe('openChannel', () => {
    it('skips approve when allowance is sufficient', async () => {
      clients.setAllowance(10_000_000n);
      clients.setOpenedReceipt();
      const adapter = makeAdapter(clients);
      const receipt = await adapter.openChannel({
        contract,
        userB: counterparty,
        token,
        amountA: 5_000_000n,
        amountB: 0n,
      });
      // One sendTx for openChannel only (no approve)
      expect(clients.txs).toHaveLength(1);
      const decoded = decodeFunctionData({
        abi: PAYMENT_CHANNEL_ABI,
        data: clients.txs[0]?.data,
      });
      expect(decoded.functionName).toBe('openChannel');
      expect(receipt.channelId).toBe(channelId);
      expect(receipt.userA.toLowerCase()).toBe(account.address.toLowerCase());
      expect(receipt.userB).toBe(counterparty);
      expect(receipt.txHash).toBe(txHash);
    });

    it('submits an approve tx when the allowance is short', async () => {
      clients.setAllowance(0n);
      clients.setOpenedReceipt();
      const adapter = makeAdapter(clients);
      await adapter.openChannel({
        contract,
        userB: counterparty,
        token,
        amountA: 5_000_000n,
        amountB: 0n,
      });
      expect(clients.txs).toHaveLength(2);
      const approve = decodeFunctionData({
        abi: ERC20_ABI,
        data: clients.txs[0]?.data,
      });
      expect(approve.functionName).toBe('approve');
      expect(approve.args?.[0]).toBe(contract);
      expect(approve.args?.[1]).toBe(5_000_000n);
      expect(clients.txs[0]?.to).toBe(token);
      expect(clients.txs[1]?.to).toBe(contract);
    });

    it('skips approve entirely when amountA is zero', async () => {
      clients.setAllowance(0n);
      clients.setOpenedReceipt();
      const adapter = makeAdapter(clients);
      await adapter.openChannel({
        contract,
        userB: counterparty,
        token,
        amountA: 0n,
        amountB: 5_000_000n,
      });
      // Only the openChannel tx; no approve, no allowance read
      expect(clients.txs).toHaveLength(1);
      expect(clients.reads.find((r) => r.functionName === 'allowance')).toBeUndefined();
    });

    it('skips approve when autoApprove is false', async () => {
      clients.setAllowance(0n);
      clients.setOpenedReceipt();
      const adapter = new ViemChainAdapter({
        walletClient: clients.walletClient,
        publicClient: clients.publicClient,
        chain: taikoHoodi as Chain,
        account,
        autoApprove: false,
      });
      await adapter.openChannel({
        contract,
        userB: counterparty,
        token,
        amountA: 5_000_000n,
        amountB: 0n,
      });
      expect(clients.txs).toHaveLength(1);
    });

    it('throws when no ChannelOpened event is found in the receipt logs', async () => {
      clients.setAllowance(10_000_000n);
      clients.setPlainReceipt();
      const adapter = makeAdapter(clients);
      await expect(
        adapter.openChannel({
          contract,
          userB: counterparty,
          token,
          amountA: 5_000_000n,
          amountB: 0n,
        }),
      ).rejects.toThrow(/ChannelOpened/);
    });

    it('throws when the tx reverts', async () => {
      clients.setAllowance(10_000_000n);
      clients.setRevertedReceipt();
      const adapter = makeAdapter(clients);
      await expect(
        adapter.openChannel({
          contract,
          userB: counterparty,
          token,
          amountA: 5_000_000n,
          amountB: 0n,
        }),
      ).rejects.toThrow(/reverted/);
    });
  });

  describe('closeCooperative', () => {
    it('encodes both signatures and the state struct', async () => {
      const adapter = makeAdapter(clients);
      const state = makeSignedState();
      const receipt = await adapter.closeCooperative({ contract, channelId, state });
      expect(clients.txs).toHaveLength(1);
      const decoded = decodeFunctionData({
        abi: PAYMENT_CHANNEL_ABI,
        data: clients.txs[0]?.data,
      });
      expect(decoded.functionName).toBe('closeCooperative');
      const args = decoded.args as readonly [Hex, Hex, Hex, Hex];
      expect(args[0]).toBe(channelId);
      // sigA + sigB are 65-byte packed hex strings
      expect(args[2].length).toBe(2 + 130);
      expect(args[3].length).toBe(2 + 130);
      // sigA starts with our state.sigA.r
      expect(args[2].toLowerCase()).toContain('aa'.repeat(32));
      expect(args[3].toLowerCase()).toContain('cc'.repeat(32));
      expect(receipt.txHash).toBe(txHash);
      expect(receipt.channelId).toBe(channelId);
    });
  });

  describe('closeUnilateral', () => {
    it('passes sigB as counterparty when closer is A', async () => {
      const adapter = makeAdapter(clients);
      const state = makeSignedState();
      await adapter.closeUnilateral({ contract, channelId, state, closerSide: 'A' });
      const decoded = decodeFunctionData({
        abi: PAYMENT_CHANNEL_ABI,
        data: clients.txs[0]?.data,
      });
      const args = decoded.args as readonly [Hex, Hex, Hex];
      expect(args[2].toLowerCase()).toContain('cc'.repeat(32));
    });

    it('passes sigA as counterparty when closer is B', async () => {
      const adapter = makeAdapter(clients);
      const state = makeSignedState();
      await adapter.closeUnilateral({ contract, channelId, state, closerSide: 'B' });
      const decoded = decodeFunctionData({
        abi: PAYMENT_CHANNEL_ABI,
        data: clients.txs[0]?.data,
      });
      const args = decoded.args as readonly [Hex, Hex, Hex];
      expect(args[2].toLowerCase()).toContain('aa'.repeat(32));
    });
  });

  describe('waitForFinalized', () => {
    it('returns the receipt once the ChannelFinalized event appears', async () => {
      const adapter = makeAdapter(clients);
      clients.setEvents([
        {
          args: { channelId, paidA: 4_000_000n, paidB: 1_000_000n },
          transactionHash: txHash,
        },
      ]);
      const receipt = await adapter.waitForFinalized(channelId, { timeoutMs: 100 });
      expect(receipt.channelId).toBe(channelId);
      expect(receipt.paidA).toBe(4_000_000n);
      expect(receipt.paidB).toBe(1_000_000n);
      expect(receipt.txHash).toBe(txHash);
    });

    it('times out when the event does not appear', async () => {
      const adapter = makeAdapter(clients);
      clients.setEvents([]);
      await expect(adapter.waitForFinalized(channelId, { timeoutMs: 10 })).rejects.toThrow(
        /timed out/,
      );
    });
  });

  it('avoids leaking the private key in the constructor footprint', () => {
    void zeroAddress;
    void toBytes;
    void vi;
    const adapter = makeAdapter(clients);
    const serialized = JSON.stringify(adapter, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(serialized).not.toContain(PK.slice(2));
  });
});
