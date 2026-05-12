import type {
  Channel,
  ChannelState,
  Hex,
  HtlcId,
  PaymentHash,
  Signature,
  SignedState,
} from '@inferenceroom/pico-protocol';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelPool } from './channel-pool.js';
import { type TestDb, makeTestDb } from './db/repos/_test-helpers.js';
import { FlatPlusBpsFeePolicy } from './fee-policy.js';
import { logger } from './logger.js';
import { Router } from './router.js';

const ZERO_SIG: Signature = { r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}`, v: 27 };
const HUB_PK = '0x00000000000000000000000000000000000000000000000000000000000000bb' as const;
const VERIFYING_CONTRACT = '0x0000000000000000000000000000000000000001' as const;

function bytes32(prefix: string, idx: number): Hex {
  return `0x${prefix}${String(idx).padStart(64 - prefix.length, '0')}` as Hex;
}

function makeChannel(
  id: Hex,
  userA: `0x${string}`,
  userB: `0x${string}`,
  status: Channel['status'] = 'open',
): Channel {
  return {
    id,
    chainId: 31337,
    contract: VERIFYING_CONTRACT,
    userA,
    userB,
    token: '0x0000000000000000000000000000000000000099',
    status,
    openedAt: 0n,
    disputeWindowMs: 86_400_000,
  };
}

function signed(channel: Channel, balanceA: bigint, balanceB: bigint, version = 1n): SignedState {
  const state: ChannelState = {
    channelId: channel.id,
    version,
    balanceA,
    balanceB,
    htlcs: [],
    htlcsCount: 0,
    htlcsTotalLocked: 0n,
    finalized: false,
  };
  return { state, sigA: ZERO_SIG, sigB: ZERO_SIG };
}

describe('Router', () => {
  let h: TestDb;
  let pool: ChannelPool;
  const hubAccount = privateKeyToAccount(HUB_PK);
  const alice = '0x00000000000000000000000000000000000000A1' as const;
  const bob = '0x00000000000000000000000000000000000000B0' as const;
  const aliceHubChannel = makeChannel(bytes32('aa', 1), alice, hubAccount.address);
  const hubBobChannel = makeChannel(bytes32('bb', 1), hubAccount.address, bob);

  beforeEach(async () => {
    h = await makeTestDb();
    pool = new ChannelPool({
      logger,
      channelRepo: h.repos.channels,
      stateRepo: h.repos.states,
    });
    // Provide on-chain amounts so the §4.3 per-channel value cap admits
    // these test routes (cap = min(amountA, amountB)). For the hub→Bob
    // channel, we model 50 USDC outbound on the hub side and 1000 USDC of
    // user-side capacity so the cap admits up to ~50 USDC HTLCs.
    await pool.register(aliceHubChannel, signed(aliceHubChannel, 100n, 0n), {
      amountA: 100n,
      amountB: 1_000n,
    });
    await pool.register(hubBobChannel, signed(hubBobChannel, 50n, 0n), {
      amountA: 50n,
      amountB: 1_000n,
    });
  });
  afterEach(async () => h.cleanup());

  function buildRouter() {
    return new Router({
      channelPool: pool,
      feePolicy: new FlatPlusBpsFeePolicy(0n, 0n),
      hubAccount,
      chainId: 31337,
      verifyingContract: VERIFYING_CONTRACT,
      logger,
    });
  }

  it('routes a valid payment, signs the outgoing state, and tracks inflight', async () => {
    const router = buildRouter();
    const incomingHtlc = {
      id: bytes32('cc', 1) as HtlcId,
      direction: 'AtoB' as const,
      amount: 10n,
      paymentHash: bytes32('dd', 1) as PaymentHash,
      expiryMs: BigInt(Date.now() + 60 * 60 * 1000),
    };
    const result = await router.route({
      incomingChannel: aliceHubChannel,
      incomingSignedState: signed(aliceHubChannel, 100n, 0n),
      incomingHtlc,
      recipient: bob,
      amount: 10n,
      paymentHash: incomingHtlc.paymentHash,
    });
    expect(result.outgoingChannel.id).toBe(hubBobChannel.id);
    expect(result.outgoingHtlc.amount).toBe(10n);
    expect(result.outgoingHubSigned.state.version).toBe(2n);

    router.recordInflight({
      incomingChannelId: aliceHubChannel.id,
      incomingHtlcId: incomingHtlc.id,
      incomingSignedState: signed(aliceHubChannel, 100n, 0n),
      incomingSenderAddress: alice,
      outgoingChannelId: result.outgoingChannel.id,
      outgoingHtlcId: result.outgoingHtlc.id,
      outgoingHtlc: result.outgoingHtlc,
      outgoingHubSigned: result.outgoingHubSigned,
      recipient: bob,
    });
    expect(router.pendingForRecipient(bob)).toHaveLength(1);
    const taken = router.takeByOutgoingId(result.outgoingHtlc.id);
    expect(taken?.incomingHtlcId).toBe(incomingHtlc.id);
    expect(router.takeByOutgoingId(result.outgoingHtlc.id)).toBeUndefined();
  });

  it('rejects when there is no channel to the recipient', async () => {
    const router = buildRouter();
    const incomingHtlc = {
      id: bytes32('cc', 2) as HtlcId,
      direction: 'AtoB' as const,
      amount: 10n,
      paymentHash: bytes32('dd', 2) as PaymentHash,
      expiryMs: BigInt(Date.now() + 60 * 60 * 1000),
    };
    await expect(
      router.route({
        incomingChannel: aliceHubChannel,
        incomingSignedState: signed(aliceHubChannel, 100n, 0n),
        incomingHtlc,
        recipient: '0x00000000000000000000000000000000000000FF',
        amount: 10n,
        paymentHash: incomingHtlc.paymentHash,
      }),
    ).rejects.toThrow(/no channel between hub/);
  });

  it('rejects when expiry is too tight', async () => {
    const router = buildRouter();
    const incomingHtlc = {
      id: bytes32('cc', 3) as HtlcId,
      direction: 'AtoB' as const,
      amount: 10n,
      paymentHash: bytes32('dd', 3) as PaymentHash,
      expiryMs: BigInt(Date.now()),
    };
    await expect(
      router.route({
        incomingChannel: aliceHubChannel,
        incomingSignedState: signed(aliceHubChannel, 100n, 0n),
        incomingHtlc,
        recipient: bob,
        amount: 10n,
        paymentHash: incomingHtlc.paymentHash,
      }),
    ).rejects.toThrow(/expiry/);
  });

  it('rejects when hub liquidity is insufficient on the outbound channel', async () => {
    const router = buildRouter();
    const incomingHtlc = {
      id: bytes32('cc', 4) as HtlcId,
      direction: 'AtoB' as const,
      amount: 999n,
      paymentHash: bytes32('dd', 4) as PaymentHash,
      expiryMs: BigInt(Date.now() + 60 * 60 * 1000),
    };
    await expect(
      router.route({
        incomingChannel: aliceHubChannel,
        incomingSignedState: signed(aliceHubChannel, 100n, 0n),
        incomingHtlc,
        recipient: bob,
        amount: 999n,
        paymentHash: incomingHtlc.paymentHash,
      }),
    ).rejects.toThrow(/liquidity/);
  });

  it('rejects when amount does not exceed the fee', async () => {
    const router = new Router({
      channelPool: pool,
      feePolicy: new FlatPlusBpsFeePolicy(0n, 50n),
      hubAccount,
      chainId: 31337,
      verifyingContract: VERIFYING_CONTRACT,
      logger,
    });
    const incomingHtlc = {
      id: bytes32('cc', 5) as HtlcId,
      direction: 'AtoB' as const,
      amount: 5n,
      paymentHash: bytes32('dd', 5) as PaymentHash,
      expiryMs: BigInt(Date.now() + 60 * 60 * 1000),
    };
    await expect(
      router.route({
        incomingChannel: aliceHubChannel,
        incomingSignedState: signed(aliceHubChannel, 100n, 0n),
        incomingHtlc,
        recipient: bob,
        amount: 5n,
        paymentHash: incomingHtlc.paymentHash,
      }),
    ).rejects.toThrow(/amount.*fee/);
  });
});
