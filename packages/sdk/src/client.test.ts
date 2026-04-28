import type { Address, ChainId, Channel, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { TAIKO_HOODI_CHAIN_ID } from '@tainnel/protocol';
import { computeBalance } from '@tainnel/state-machine';
import { type MockHub, TEST_KEYS, createMockHub } from '@tainnel/test-utils';
import { sha256 } from 'viem';
import { createWalletClient, custom } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { taiko } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChainAdapter,
  CloseCooperativeTxArgs,
  CloseReceipt,
  CloseUnilateralTxArgs,
  OpenChannelReceipt,
  OpenChannelTxArgs,
} from './chain.js';
import { ChannelClient } from './client.js';
import {
  CloseRejectedError,
  PaymentRejectedError,
  PaymentTimeoutError,
  UnknownChannelError,
} from './errors.js';
import { MemoryStorage } from './storage.js';
import { type Transport, createInMemoryPipe } from './transport.js';
import { ViemWalletAdapter, type WalletAdapter } from './wallet.js';

const verifyingContract: Address = '0x1111111111111111111111111111111111111111';
const chainId: ChainId = TAIKO_HOODI_CHAIN_ID;

class MockChainAdapter implements ChainAdapter {
  readonly chainId = chainId;
  readonly opens: OpenChannelTxArgs[] = [];
  readonly cooperativeCloses: CloseCooperativeTxArgs[] = [];
  readonly unilateralCloses: CloseUnilateralTxArgs[] = [];

  constructor(private readonly userA: Address) {}

  async openChannel(args: OpenChannelTxArgs): Promise<OpenChannelReceipt> {
    this.opens.push(args);
    const channelId = `0x${'cd'.repeat(32)}` as ChannelId;
    return {
      channelId,
      userA: this.userA,
      userB: args.userB,
      token: args.token,
      amountA: args.amountA,
      amountB: args.amountB,
      txHash: `0x${'11'.repeat(32)}` as Hex,
      blockTimestamp: 1_700_000_000n,
    };
  }

  async closeCooperative(args: CloseCooperativeTxArgs): Promise<CloseReceipt> {
    this.cooperativeCloses.push(args);
    return { channelId: args.channelId, txHash: `0x${'22'.repeat(32)}` as Hex };
  }

  async closeUnilateral(args: CloseUnilateralTxArgs): Promise<CloseReceipt> {
    this.unilateralCloses.push(args);
    return { channelId: args.channelId, txHash: `0x${'33'.repeat(32)}` as Hex };
  }
}

function makeViemWallet(privateKey: Hex): WalletAdapter {
  const account = privateKeyToAccount(privateKey);
  const transport = custom({
    request: async () => null,
  });
  const walletClient = createWalletClient({ account, chain: taiko, transport });
  return new ViemWalletAdapter({ walletClient });
}

interface Harness {
  client: ChannelClient;
  storage: MemoryStorage;
  chain: MockChainAdapter;
  hub: MockHub;
  hubTransport: Transport;
  cleanup: () => Promise<void>;
}

function makeHarness(overrides: Partial<Parameters<typeof ChannelClient>[0]> = {}): Harness {
  const aliceAddr = TEST_KEYS.alice.address;
  const hubAddr = TEST_KEYS.hub.address;

  const wallet = makeViemWallet(TEST_KEYS.alice.privateKey);
  const storage = new MemoryStorage();
  const pipe = createInMemoryPipe();
  const chain = new MockChainAdapter(aliceAddr);
  const hub = createMockHub({
    hubPrivateKey: TEST_KEYS.hub.privateKey,
    chainId,
    verifyingContract,
  });
  const dispose = hub.attach({
    send: (m) => pipe.server.send(m),
    onMessage: (h) => pipe.server.onMessage(h),
    close: () => pipe.server.close(),
  });

  let counter = 0;
  const client = new ChannelClient({
    wallet,
    transport: pipe.client,
    storage,
    chain,
    hubAddress: hubAddr,
    contract: verifyingContract,
    clock: () => 1_700_000_000_000,
    randomBytes32: () => {
      counter++;
      const hex = counter.toString(16).padStart(64, '0');
      return `0x${hex}` as Hex;
    },
    settleTimeoutMs: 200,
    cooperativeCloseTimeoutMs: 200,
    subscribeTimeoutMs: 200,
    ...overrides,
  });

  return {
    client,
    storage,
    chain,
    hub,
    hubTransport: pipe.server,
    cleanup: async () => {
      dispose();
      await pipe.client.close();
      await pipe.server.close();
    },
  };
}

describe('ChannelClient.list / getBalance', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  it('list returns the empty array initially', async () => {
    expect(await h.client.list()).toEqual([]);
  });

  it('getBalance throws for unknown channel', async () => {
    const unknown: ChannelId = `0x${'0e'.repeat(32)}` as ChannelId;
    await expect(h.client.getBalance(unknown)).rejects.toBeInstanceOf(UnknownChannelError);
  });

  it('getBalance returns zeros for a channel with no signed state yet', async () => {
    const channel: Channel = {
      id: `0x${'aa'.repeat(32)}` as ChannelId,
      chainId,
      contract: verifyingContract,
      userA: TEST_KEYS.alice.address,
      userB: TEST_KEYS.hub.address,
      token: '0x0000000000000000000000000000000000000000',
      status: 'open',
      openedAt: 0n,
      disputeWindowMs: 1_000,
    };
    await h.storage.saveChannel(channel);
    const bal = await h.client.getBalance(channel.id);
    expect(bal.balanceUs).toBe(0n);
    expect(bal.balanceCounterparty).toBe(0n);
    expect(bal.pendingHtlcsTotal).toBe(0n);
  });
});

describe('ChannelClient.open', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  it('opens a channel: calls chain.openChannel, persists, subscribes', async () => {
    const channel = await h.client.open({ amount: 1_000_000n });
    expect(h.chain.opens).toHaveLength(1);
    expect(h.chain.opens[0]?.amountA).toBe(1_000_000n);
    expect(channel.status).toBe('open');
    expect(await h.storage.loadChannel(channel.id)).toBeDefined();
    expect((await h.client.list())[0]?.id).toBe(channel.id);
  });

  it('uses configured hub address when no counterparty is given', async () => {
    const channel = await h.client.open({ amount: 1_000n });
    expect(channel.userB.toLowerCase()).toBe(TEST_KEYS.hub.address.toLowerCase());
  });

  it('uses native token (zero address) when no token is given', async () => {
    const channel = await h.client.open({ amount: 1_000n });
    expect(channel.token).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('ChannelClient.pay', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  async function setupOpenChannel(
    h: Harness,
    balanceA = 1_000_000n,
    balanceB = 1_000_000n,
  ): Promise<Channel> {
    const channel = await h.client.open({ amount: balanceA });
    // seed balanceB-bearing initial state by faking an inbound state
    const seedState: SignedState = {
      state: {
        channelId: channel.id,
        version: 0n,
        balanceA,
        balanceB,
        htlcs: [],
        finalized: false,
      },
      sigA: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
      sigB: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
    };
    // bypass MemoryStorage stale check by using a fresh storage path:
    // saveState requires monotonic versions, so we save version 0n which is the initial.
    await h.storage.saveState(channel.id, {
      ...seedState,
      state: { ...seedState.state, version: 1n },
    });
    return channel;
  }

  it('happy-path: registers preimage, sends pay, receives settle, persists final state', async () => {
    const channel = await setupOpenChannel(h);
    const preimage = `0x${'aa'.repeat(32)}` as Hex;
    const paymentHash = sha256(preimage) as Hex;
    h.hub.registerPreimage(preimage, paymentHash);

    // monkey-patch the SDK's randomBytes32 so the SDK's preimage matches our registered one
    const harness2 = makeHarness({
      randomBytes32: (() => {
        let i = 0;
        return () => {
          i++;
          // alternate: first call = preimage, subsequent calls = htlc id
          return i % 2 === 1 ? preimage : (`0x${i.toString(16).padStart(64, '0')}` as Hex);
        };
      })(),
    });
    const ch2 = await harness2.client.open({ amount: 100n });
    await harness2.storage.saveState(ch2.id, {
      state: {
        channelId: ch2.id,
        version: 1n,
        balanceA: 1_000_000n,
        balanceB: 1_000_000n,
        htlcs: [],
        finalized: false,
      },
      sigA: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
      sigB: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
    });
    harness2.hub.registerPreimage(preimage, paymentHash);
    const result = await harness2.client.pay(ch2.id, {
      to: TEST_KEYS.bob.address,
      amount: 5_000n,
      expiryMs: 9_999_999_999_999n,
    });
    expect(result.preimage).toBe(preimage);

    const stored = await harness2.storage.loadLatestState(ch2.id);
    expect(stored?.state.htlcs.length).toBe(0);
    const totals = computeBalance(stored?.state ?? (channel.userA as never as never));
    expect(totals.totalA + totals.totalB).toBe(2_000_000n);
    await harness2.cleanup();
  });

  it('rejects payment when channel is not open', async () => {
    const channel = await setupOpenChannel(h);
    await h.storage.saveChannel({
      ...((await h.storage.loadChannel(channel.id)) as Channel),
      status: 'closed',
    });
    await expect(
      h.client.pay(channel.id, {
        to: TEST_KEYS.bob.address,
        amount: 1n,
        expiryMs: 9_999_999_999_999n,
      }),
    ).rejects.toBeInstanceOf(PaymentRejectedError);
  });

  it('throws PaymentRejectedError when hub returns payment.fail', async () => {
    const channel = await setupOpenChannel(h);
    // hub has no registered preimage → returns payment.fail
    await expect(
      h.client.pay(channel.id, {
        to: TEST_KEYS.bob.address,
        amount: 1n,
        expiryMs: 9_999_999_999_999n,
      }),
    ).rejects.toBeInstanceOf(PaymentRejectedError);
  });

  it('throws PaymentTimeoutError when hub never replies', async () => {
    // bare wiring with NO mock hub attached — server side just swallows messages
    const wallet = makeViemWallet(TEST_KEYS.alice.privateKey);
    const storage = new MemoryStorage();
    const pipe = createInMemoryPipe();
    const chain = new MockChainAdapter(TEST_KEYS.alice.address);
    // server side: only auto-ack subscribe so open() can complete
    pipe.server.onMessage((msg) => {
      if (msg.kind === 'subscribe') {
        void pipe.server.send({ id: msg.id, kind: 'subscribe.ack', payload: {} });
      }
      // do not respond to anything else → triggers timeout
    });
    let i = 0;
    const client = new ChannelClient({
      wallet,
      transport: pipe.client,
      storage,
      chain,
      hubAddress: TEST_KEYS.hub.address,
      contract: verifyingContract,
      randomBytes32: () => {
        i++;
        return `0x${i.toString(16).padStart(64, '0')}` as Hex;
      },
      settleTimeoutMs: 30,
      subscribeTimeoutMs: 200,
    });
    const ch = await client.open({ amount: 100n });
    await storage.saveState(ch.id, {
      state: {
        channelId: ch.id,
        version: 1n,
        balanceA: 1_000n,
        balanceB: 1_000n,
        htlcs: [],
        finalized: false,
      },
      sigA: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
      sigB: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
    });
    await expect(
      client.pay(ch.id, {
        to: TEST_KEYS.bob.address,
        amount: 1n,
        expiryMs: 9_999_999_999_999n,
      }),
    ).rejects.toBeInstanceOf(PaymentTimeoutError);
    await pipe.client.close();
    await pipe.server.close();
  });

  it('persist-before-send: state is on disk before we wait for the hub reply (D4.3)', async () => {
    // wire a hub that records storage state at the moment the pay message arrives
    const harness = makeHarness();
    const ch = await harness.client.open({ amount: 100n });
    await harness.storage.saveState(ch.id, {
      state: {
        channelId: ch.id,
        version: 1n,
        balanceA: 1_000_000n,
        balanceB: 1_000_000n,
        htlcs: [],
        finalized: false,
      },
      sigA: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
      sigB: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
    });

    let stateAtSendTime: SignedState | undefined;
    harness.hubTransport.onMessage(async (msg) => {
      if (msg.kind === 'pay') {
        stateAtSendTime = await harness.storage.loadLatestState(ch.id);
        await harness.hubTransport.send({
          id: msg.id,
          kind: 'payment.fail',
          payload: { reason: 'irrelevant' },
        });
      }
    });

    await expect(
      harness.client.pay(ch.id, {
        to: TEST_KEYS.bob.address,
        amount: 5n,
        expiryMs: 9_999_999_999_999n,
      }),
    ).rejects.toBeInstanceOf(PaymentRejectedError);

    // by the time the hub saw the pay message, the new state (with htlc) was already persisted
    expect(stateAtSendTime?.state.htlcs.length).toBe(1);
    await harness.cleanup();
  });
});

describe('ChannelClient.close — cooperative', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  it('happy-path: gets counter-sig, calls chain.closeCooperative, marks closed', async () => {
    const channel = await h.client.open({ amount: 1_000n });
    await h.storage.saveState(channel.id, {
      state: {
        channelId: channel.id,
        version: 1n,
        balanceA: 600n,
        balanceB: 400n,
        htlcs: [],
        finalized: false,
      },
      sigA: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
      sigB: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
    });
    await h.client.close(channel.id);
    expect(h.chain.cooperativeCloses).toHaveLength(1);
    const stored = await h.storage.loadChannel(channel.id);
    expect(stored?.status).toBe('closed');
  });

  it('falls back to unilateral close when hub rejects', async () => {
    const harness = makeHarness();
    // re-attach a rejecting hub
    const rejecting = createMockHub({
      hubPrivateKey: TEST_KEYS.hub.privateKey,
      chainId,
      verifyingContract,
      rejectAllCloses: true,
    });
    rejecting.attach({
      send: (m) => harness.hubTransport.send(m),
      onMessage: (cb) => harness.hubTransport.onMessage(cb),
      close: () => harness.hubTransport.close(),
    });
    const channel = await harness.client.open({ amount: 1_000n });
    const ss: SignedState = {
      state: {
        channelId: channel.id,
        version: 1n,
        balanceA: 600n,
        balanceB: 400n,
        htlcs: [],
        finalized: false,
      },
      sigA: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
      sigB: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
    };
    await harness.storage.saveState(channel.id, ss);
    await harness.client.close(channel.id);
    expect(harness.chain.unilateralCloses).toHaveLength(1);
    await harness.cleanup();
  });

  it('cooperative close throws if no signed state exists and hub rejects', async () => {
    const harness = makeHarness();
    const rejecting = createMockHub({
      hubPrivateKey: TEST_KEYS.hub.privateKey,
      chainId,
      verifyingContract,
      rejectAllCloses: true,
    });
    rejecting.attach({
      send: (m) => harness.hubTransport.send(m),
      onMessage: (cb) => harness.hubTransport.onMessage(cb),
      close: () => harness.hubTransport.close(),
    });
    const channel = await harness.client.open({ amount: 1_000n });
    await expect(harness.client.close(channel.id)).rejects.toBeInstanceOf(CloseRejectedError);
    await harness.cleanup();
  });

  it('throws UnknownChannelError when closing a channel we do not have', async () => {
    const unknown: ChannelId = `0x${'fe'.repeat(32)}` as ChannelId;
    await expect(h.client.close(unknown)).rejects.toBeInstanceOf(UnknownChannelError);
  });
});

describe('ChannelClient — persistence survives crash', () => {
  it('after pay sign-and-send, a fresh client with the same FileStorage sees the new state', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'tainnel-crash-'));
    try {
      const { FileStorage } = await import('./storage.js');
      const wallet = makeViemWallet(TEST_KEYS.alice.privateKey);
      const storage = await FileStorage.createNode(dir);
      const pipe = createInMemoryPipe();
      const chain = new MockChainAdapter(TEST_KEYS.alice.address);

      // fail-on-pay hub (simulates a hub crash before reply)
      const hub = createMockHub({
        hubPrivateKey: TEST_KEYS.hub.privateKey,
        chainId,
        verifyingContract,
      });
      hub.attach({
        send: (m) => pipe.server.send(m),
        onMessage: (h) => pipe.server.onMessage(h),
        close: () => pipe.server.close(),
      });

      let i = 0;
      const client = new ChannelClient({
        wallet,
        transport: pipe.client,
        storage,
        chain,
        hubAddress: TEST_KEYS.hub.address,
        contract: verifyingContract,
        randomBytes32: () => {
          i++;
          return `0x${i.toString(16).padStart(64, '0')}` as Hex;
        },
      });
      const channel = await client.open({ amount: 100n });
      await storage.saveState(channel.id, {
        state: {
          channelId: channel.id,
          version: 1n,
          balanceA: 1_000n,
          balanceB: 1_000n,
          htlcs: [],
          finalized: false,
        },
        sigA: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
        sigB: { r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex, v: 0 },
      });
      await expect(
        client.pay(channel.id, {
          to: TEST_KEYS.bob.address,
          amount: 5n,
          expiryMs: 9_999_999_999_999n,
        }),
      ).rejects.toBeInstanceOf(PaymentRejectedError);

      await pipe.client.close();
      await pipe.server.close();

      // simulate process restart: open a fresh storage on the same directory
      const reborn = await FileStorage.createNode(dir);
      const stored = await reborn.loadLatestState(channel.id);
      expect(stored?.state.htlcs.length).toBe(1);
      expect(stored?.state.balanceA).toBe(995n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ChannelClient.close — unilateral', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  it('uses chain.closeUnilateral with the latest signed state', async () => {
    const channel = await h.client.open({ amount: 1_000n });
    await h.storage.saveState(channel.id, {
      state: {
        channelId: channel.id,
        version: 1n,
        balanceA: 600n,
        balanceB: 400n,
        htlcs: [],
        finalized: false,
      },
      sigA: { r: `0x${'aa'.repeat(32)}` as Hex, s: `0x${'bb'.repeat(32)}` as Hex, v: 27 },
      sigB: { r: `0x${'cc'.repeat(32)}` as Hex, s: `0x${'dd'.repeat(32)}` as Hex, v: 28 },
    });
    await h.client.close(channel.id, { cooperative: false });
    expect(h.chain.unilateralCloses).toHaveLength(1);
    expect(h.chain.unilateralCloses[0]?.state.state.balanceA).toBe(600n);
  });
});
