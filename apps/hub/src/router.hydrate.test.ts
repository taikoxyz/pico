import type {
  Channel,
  ChannelState,
  Hex,
  Htlc,
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

function makeChannel(id: Hex, userA: `0x${string}`, userB: `0x${string}`): Channel {
  return {
    id,
    chainId: 31337,
    contract: VERIFYING_CONTRACT,
    userA,
    userB,
    token: '0x0000000000000000000000000000000000000099',
    status: 'open',
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

describe('Router.hydrate', () => {
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

  function buildRouter(): Router {
    return new Router({
      channelPool: pool,
      feePolicy: new FlatPlusBpsFeePolicy(0n, 0n),
      hubAccount,
      chainId: 31337,
      verifyingContract: VERIFYING_CONTRACT,
      logger,
    });
  }

  async function persistInflightRoute(): Promise<{
    incomingHtlcId: HtlcId;
    outgoingHtlcId: HtlcId;
    paymentHash: PaymentHash;
    outgoingHtlc: Htlc;
  }> {
    const incomingHtlcId = bytes32('cc', 1) as HtlcId;
    const outgoingHtlcId = bytes32('dd', 1) as HtlcId;
    const paymentHash = bytes32('ee', 1) as PaymentHash;
    const expiryMs = BigInt(Date.now() + 60 * 60 * 1000);
    const outgoingHtlc: Htlc = {
      id: outgoingHtlcId,
      direction: 'AtoB',
      amount: 10n,
      paymentHash,
      expiryMs,
    };
    await h.repos.routes.insert({
      incomingChannelId: aliceHubChannel.id,
      incomingHtlcId,
      outgoingChannelId: hubBobChannel.id,
      outgoingHtlcId,
      sender: alice,
      recipient: bob,
      paymentHash,
      incomingSignedState: signed(aliceHubChannel, 90n, 0n, 2n),
      outgoingHubSigned: signed(hubBobChannel, 40n, 0n, 2n),
      outgoingHtlc,
    });
    return { incomingHtlcId, outgoingHtlcId, paymentHash, outgoingHtlc };
  }

  it('rebuilds inflight maps so settle for a pre-restart route succeeds', async () => {
    const { incomingHtlcId, outgoingHtlcId, paymentHash, outgoingHtlc } =
      await persistInflightRoute();

    const router = buildRouter();
    expect(router.peekByOutgoingId(outgoingHtlcId)).toBeUndefined();

    await router.hydrate(h.repos);

    const peeked = router.peekByOutgoingId(outgoingHtlcId);
    expect(peeked).toBeDefined();
    expect(peeked?.incomingChannelId).toBe(aliceHubChannel.id);
    expect(peeked?.incomingHtlcId).toBe(incomingHtlcId);
    expect(peeked?.outgoingChannelId).toBe(hubBobChannel.id);
    expect(peeked?.recipient.toLowerCase()).toBe(bob.toLowerCase());
    expect(peeked?.outgoingHtlc.amount).toBe(outgoingHtlc.amount);
    expect(peeked?.outgoingHtlc.paymentHash).toBe(paymentHash);

    expect(router.pendingForRecipient(bob)).toHaveLength(1);

    const taken = router.takeByOutgoingId(outgoingHtlcId);
    expect(taken?.incomingHtlcId).toBe(incomingHtlcId);
    expect(router.takeByOutgoingId(outgoingHtlcId)).toBeUndefined();
    expect(router.pendingForRecipient(bob)).toHaveLength(0);
  });

  it('ignores routes that are no longer inflight (settled / failed)', async () => {
    const { outgoingHtlcId } = await persistInflightRoute();
    await h.repos.routes.markSettled(outgoingHtlcId);

    const router = buildRouter();
    await router.hydrate(h.repos);

    expect(router.peekByOutgoingId(outgoingHtlcId)).toBeUndefined();
    expect(router.pendingForRecipient(bob)).toHaveLength(0);
  });

  it('is a no-op when there are no persisted routes', async () => {
    const router = buildRouter();
    await router.hydrate(h.repos);
    expect(router.pendingForRecipient(bob)).toHaveLength(0);
    expect(router.pendingForRecipient(alice)).toHaveLength(0);
  });

  it('hydrates multiple inflight routes and indexes them by both incoming and outgoing id', async () => {
    const carol = '0x00000000000000000000000000000000000000C0' as const;
    const hubCarolChannel = makeChannel(bytes32('cf', 1), hubAccount.address, carol);
    await pool.register(hubCarolChannel, signed(hubCarolChannel, 50n, 0n), {
      amountA: 50n,
      amountB: 1_000n,
    });

    const expiryMs = BigInt(Date.now() + 60 * 60 * 1000);
    const r1 = {
      incomingHtlcId: bytes32('11', 1) as HtlcId,
      outgoingHtlcId: bytes32('21', 1) as HtlcId,
      paymentHash: bytes32('31', 1) as PaymentHash,
    };
    const r2 = {
      incomingHtlcId: bytes32('12', 1) as HtlcId,
      outgoingHtlcId: bytes32('22', 1) as HtlcId,
      paymentHash: bytes32('32', 1) as PaymentHash,
    };
    await h.repos.routes.insert({
      incomingChannelId: aliceHubChannel.id,
      incomingHtlcId: r1.incomingHtlcId,
      outgoingChannelId: hubBobChannel.id,
      outgoingHtlcId: r1.outgoingHtlcId,
      sender: alice,
      recipient: bob,
      paymentHash: r1.paymentHash,
      incomingSignedState: signed(aliceHubChannel, 90n, 0n, 2n),
      outgoingHubSigned: signed(hubBobChannel, 40n, 0n, 2n),
      outgoingHtlc: {
        id: r1.outgoingHtlcId,
        direction: 'AtoB',
        amount: 10n,
        paymentHash: r1.paymentHash,
        expiryMs,
      },
    });
    await h.repos.routes.insert({
      incomingChannelId: aliceHubChannel.id,
      incomingHtlcId: r2.incomingHtlcId,
      outgoingChannelId: hubCarolChannel.id,
      outgoingHtlcId: r2.outgoingHtlcId,
      sender: alice,
      recipient: carol,
      paymentHash: r2.paymentHash,
      incomingSignedState: signed(aliceHubChannel, 85n, 0n, 3n),
      outgoingHubSigned: signed(hubCarolChannel, 45n, 0n, 2n),
      outgoingHtlc: {
        id: r2.outgoingHtlcId,
        direction: 'AtoB',
        amount: 5n,
        paymentHash: r2.paymentHash,
        expiryMs,
      },
    });

    const router = buildRouter();
    await router.hydrate(h.repos);

    expect(router.peekByOutgoingId(r1.outgoingHtlcId)?.recipient.toLowerCase()).toBe(
      bob.toLowerCase(),
    );
    expect(router.peekByOutgoingId(r2.outgoingHtlcId)?.recipient.toLowerCase()).toBe(
      carol.toLowerCase(),
    );
    expect(router.pendingForRecipient(bob)).toHaveLength(1);
    expect(router.pendingForRecipient(carol)).toHaveLength(1);
  });
});
