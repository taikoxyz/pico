import type { Channel, ChannelState, Signature, SignedState } from '@pico/protocol';
import type { PublicClient, WalletClient } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelPool } from './channel-pool.js';
import { type TestDb, makeTestDb } from './db/repos/_test-helpers.js';
import { DisputeHandler } from './dispute-handler.js';
import { logger } from './logger.js';

const ZERO_SIG: Signature = { r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}`, v: 27 };

const HUB_PK = '0x00000000000000000000000000000000000000000000000000000000000000bb' as const;

const SAMPLE: Channel = {
  id: `0x${'aa'.repeat(32)}`,
  chainId: 31337,
  contract: '0x0000000000000000000000000000000000000001',
  userA: '0x00000000000000000000000000000000000000A1',
  userB: '0x00000000000000000000000000000000000000B0',
  token: '0x0000000000000000000000000000000000000099',
  status: 'open',
  openedAt: 0n,
  disputeWindowMs: 86_400_000,
};

function signed(version: bigint): SignedState {
  const state: ChannelState = {
    channelId: SAMPLE.id,
    version,
    balanceA: 100n,
    balanceB: 0n,
    htlcs: [],
    finalized: false,
  };
  return { state, sigA: ZERO_SIG, sigB: ZERO_SIG };
}

class FakeWallet {
  calls: Array<{ args: unknown[] }> = [];
  failuresRemaining = 0;
  async writeContract(args: { args: readonly unknown[] }): Promise<`0x${string}`> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('rpc transient error');
    }
    this.calls.push({ args: [...args.args] });
    return '0xfeedface';
  }
}

class FakePublic {
  closer: `0x${string}`;
  disputeDeadlineSec: bigint;
  constructor(closer: `0x${string}`, disputeDeadlineSec = 0n) {
    this.closer = closer;
    this.disputeDeadlineSec = disputeDeadlineSec;
  }
  async readContract(): Promise<unknown[]> {
    return [
      SAMPLE.userA,
      SAMPLE.userB,
      SAMPLE.token,
      0n,
      0n,
      0n,
      this.disputeDeadlineSec,
      3n,
      0n,
      0n,
      false,
      0,
      this.closer,
    ];
  }
  async waitForTransactionReceipt(): Promise<{ status: 'success' }> {
    return { status: 'success' };
  }
}

describe('DisputeHandler', () => {
  let h: TestDb;
  let pool: ChannelPool;

  beforeEach(async () => {
    h = await makeTestDb();
    pool = new ChannelPool({
      logger,
      channelRepo: h.repos.channels,
      stateRepo: h.repos.states,
    });
    await pool.register(SAMPLE, signed(1n));
  });
  afterEach(async () => h.cleanup());

  it('skips dispute when our state is not newer (logs lost)', async () => {
    const wallet = new FakeWallet();
    const handler = new DisputeHandler({
      logger,
      repos: h.repos,
      channelPool: pool,
      rpcUrl: 'http://test',
      chainId: 31337,
      paymentChannelAddress: SAMPLE.contract,
      hubPrivateKey: HUB_PK,
      publicClient: new FakePublic(SAMPLE.userA) as unknown as PublicClient,
      walletClient: wallet as unknown as WalletClient,
    });
    await handler.handle({ channelId: SAMPLE.id, attackerVersion: 5n, observedAtMs: Date.now() });
    expect(wallet.calls).toHaveLength(0);
    const disputes = await h.repos.disputes.list();
    expect(disputes[0]?.resolution).toBe('lost');
  });

  it('submits dispute tx and records win when our state is newer', async () => {
    await pool.recordState(SAMPLE.id, signed(7n));
    const wallet = new FakeWallet();
    const handler = new DisputeHandler({
      logger,
      repos: h.repos,
      channelPool: pool,
      rpcUrl: 'http://test',
      chainId: 31337,
      paymentChannelAddress: SAMPLE.contract,
      hubPrivateKey: HUB_PK,
      publicClient: new FakePublic(SAMPLE.userA) as unknown as PublicClient,
      walletClient: wallet as unknown as WalletClient,
    });
    await handler.handle({ channelId: SAMPLE.id, attackerVersion: 3n, observedAtMs: Date.now() });
    expect(wallet.calls).toHaveLength(1);
    const disputes = await h.repos.disputes.list();
    expect(disputes[0]?.resolution).toBe('won');
    expect(disputes[0]?.responseTxHash).toBe('0xfeedface');
  });

  it('retries transient tx errors within a single handle() call', async () => {
    await pool.recordState(SAMPLE.id, signed(7n));
    const wallet = new FakeWallet();
    wallet.failuresRemaining = 2;
    const handler = new DisputeHandler({
      logger,
      repos: h.repos,
      channelPool: pool,
      rpcUrl: 'http://test',
      chainId: 31337,
      paymentChannelAddress: SAMPLE.contract,
      hubPrivateKey: HUB_PK,
      publicClient: new FakePublic(SAMPLE.userA) as unknown as PublicClient,
      walletClient: wallet as unknown as WalletClient,
      maxAttemptsPerCall: 3,
      retryBackoffMs: 1,
    });
    await handler.handle({ channelId: SAMPLE.id, attackerVersion: 3n, observedAtMs: Date.now() });
    expect(wallet.calls).toHaveLength(1);
    expect((await h.repos.disputes.list())[0]?.resolution).toBe('won');
  });

  it('leaves resolution pending when all attempts fail; retryPending succeeds later', async () => {
    await pool.recordState(SAMPLE.id, signed(7n));
    const wallet = new FakeWallet();
    wallet.failuresRemaining = 5;
    const handler = new DisputeHandler({
      logger,
      repos: h.repos,
      channelPool: pool,
      rpcUrl: 'http://test',
      chainId: 31337,
      paymentChannelAddress: SAMPLE.contract,
      hubPrivateKey: HUB_PK,
      publicClient: new FakePublic(SAMPLE.userA) as unknown as PublicClient,
      walletClient: wallet as unknown as WalletClient,
      maxAttemptsPerCall: 2,
      retryBackoffMs: 1,
    });
    await handler.handle({ channelId: SAMPLE.id, attackerVersion: 3n, observedAtMs: Date.now() });
    let disputes = await h.repos.disputes.list();
    expect(disputes[0]?.resolution).toBe('pending');
    expect(disputes[0]?.respondedAt).toBeUndefined();

    wallet.failuresRemaining = 0;
    await handler.retryPending();
    disputes = await h.repos.disputes.list();
    expect(disputes[0]?.resolution).toBe('won');
    expect(disputes[0]?.responseTxHash).toBe('0xfeedface');
  });

  it('marks lost when on-chain dispute deadline has elapsed', async () => {
    await pool.recordState(SAMPLE.id, signed(7n));
    const wallet = new FakeWallet();
    const fixedNowMs = 10_000_000;
    const handler = new DisputeHandler({
      logger,
      repos: h.repos,
      channelPool: pool,
      rpcUrl: 'http://test',
      chainId: 31337,
      paymentChannelAddress: SAMPLE.contract,
      hubPrivateKey: HUB_PK,
      publicClient: new FakePublic(SAMPLE.userA, 1n) as unknown as PublicClient,
      walletClient: wallet as unknown as WalletClient,
      nowMs: () => fixedNowMs,
    });
    await handler.handle({ channelId: SAMPLE.id, attackerVersion: 3n, observedAtMs: fixedNowMs });
    expect(wallet.calls).toHaveLength(0);
    expect((await h.repos.disputes.list())[0]?.resolution).toBe('lost');
  });
});
