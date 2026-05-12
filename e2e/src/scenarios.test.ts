import {
  encodeChannelStateForOnChain,
  generateKeysendKeypair,
  signatureToHex,
} from '@inferenceroom/pico-sdk';
import { http, createWalletClient, erc20Abi, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AliceBundle,
  type ClientBundle,
  type E2EHandle,
  bootE2E,
  buildAliceClient,
  buildClient,
  timeWarp,
} from './harness.js';

const paymentChannelStatusAbi = parseAbi([
  'function channels(bytes32) view returns (address userA, address userB, address token, uint256 amountA, uint256 amountB, uint64 openedAt, uint64 disputeDeadline, uint64 postedVersion, uint256 postedBalanceA, uint256 postedBalanceB, bool penalized, uint8 status, address closer, bytes32 postedHtlcsRoot, uint256 htlcsTotalLocked, uint16 htlcsCount, uint64 htlcResolutionDeadline, uint256 pendingPayoutA, uint256 pendingPayoutB)',
]);

const paymentChannelAttackAbi = parseAbi([
  'function closeUnilateral(bytes32 channelId, bytes state, bytes sigCounterparty)',
  'function dispute(bytes32 channelId, bytes state, bytes sigA, bytes sigB)',
]);

const ONE_USDC = 1_000_000n;
const STATUS_OPEN = 1;
const STATUS_CLOSING_UNILATERAL = 2;
// v2 inserted ResolvingHtlcs = 3 between ClosingUnilateral and Closed; the
// `STATUS_RESOLVING_HTLCS` constant is exported for future tests that exercise
// the post-dispute-window HTLC settlement phase.
const STATUS_RESOLVING_HTLCS = 3;
const STATUS_CLOSED = 4;

async function readUsdcBalance(h: E2EHandle, addr: `0x${string}`): Promise<bigint> {
  return h.publicClient.readContract({
    address: h.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [addr],
  });
}

async function readChannelStatus(h: E2EHandle, channelId: `0x${string}`): Promise<number> {
  const row = await h.publicClient.readContract({
    address: h.paymentChannel,
    abi: paymentChannelStatusAbi,
    functionName: 'channels',
    args: [channelId],
  });
  return row[11];
}

describe('e2e — phase 1 alice→hub scenarios on vanilla anvil', () => {
  let h: E2EHandle;
  let alice: AliceBundle;

  beforeEach(async () => {
    h = await bootE2E();
    alice = buildAliceClient(h);
  }, 60_000);

  afterEach(async () => {
    await alice?.transport.close();
    await h?.stop();
  });

  it('happy path: open 100, payDirect 5, cooperative close → alice 95 / hub 105', async () => {
    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(channel.id);
      await h.hubServer.registerChannel(channel, init ?? undefined);
    }

    expect(await readChannelStatus(h, channel.id)).toBe(STATUS_OPEN);

    const result = await alice.client.payDirect(channel.id, { amount: 5n * ONE_USDC });
    expect(result.version).toBe(2n);

    await alice.client.close(channel.id, { cooperative: true });

    expect(await readUsdcBalance(h, h.alice.address)).toBe(95n * ONE_USDC);
    expect(await readUsdcBalance(h, h.hub.address)).toBe(105n * ONE_USDC);
    expect(await readChannelStatus(h, channel.id)).toBe(STATUS_CLOSED);
  });

  it('sequential payDirect: 5 + 3 + 2 USDC, version increments, conserved balance', async () => {
    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(channel.id);
      await h.hubServer.registerChannel(channel, init ?? undefined);
    }

    const r1 = await alice.client.payDirect(channel.id, { amount: 5n * ONE_USDC });
    const r2 = await alice.client.payDirect(channel.id, { amount: 3n * ONE_USDC });
    const r3 = await alice.client.payDirect(channel.id, { amount: 2n * ONE_USDC });
    expect([r1.version, r2.version, r3.version]).toEqual([2n, 3n, 4n]);

    const stored = await alice.storage.loadLatestState(channel.id);
    expect(stored?.state.balanceA).toBe(90n * ONE_USDC);
    expect(stored?.state.balanceB).toBe(10n * ONE_USDC);

    await alice.client.close(channel.id, { cooperative: true });
    expect(await readUsdcBalance(h, h.alice.address)).toBe(90n * ONE_USDC);
    expect(await readUsdcBalance(h, h.hub.address)).toBe(110n * ONE_USDC);
  });

  it('no-payment cooperative close: open then close, both deposits returned', async () => {
    const aliceBefore = await readUsdcBalance(h, h.alice.address);
    const hubBefore = await readUsdcBalance(h, h.hub.address);

    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(channel.id);
      await h.hubServer.registerChannel(channel, init ?? undefined);
    }

    await alice.client.close(channel.id, { cooperative: true });

    expect(await readUsdcBalance(h, h.alice.address)).toBe(aliceBefore);
    expect(await readUsdcBalance(h, h.hub.address)).toBe(hubBefore);
    expect(await readChannelStatus(h, channel.id)).toBe(STATUS_CLOSED);
  });

  it('both-deposit channel: alice 60, hub 40, payDirect 10, close → wallets restored to 90/110', async () => {
    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 60n * ONE_USDC,
      counterpartyAmount: 40n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(channel.id);
      await h.hubServer.registerChannel(channel, init ?? undefined);
    }

    expect(await readUsdcBalance(h, h.alice.address)).toBe(40n * ONE_USDC);
    expect(await readUsdcBalance(h, h.hub.address)).toBe(60n * ONE_USDC);

    await alice.client.payDirect(channel.id, { amount: 10n * ONE_USDC });
    await alice.client.close(channel.id, { cooperative: true });

    expect(await readUsdcBalance(h, h.alice.address)).toBe(90n * ONE_USDC);
    expect(await readUsdcBalance(h, h.hub.address)).toBe(110n * ONE_USDC);
    expect(await readChannelStatus(h, channel.id)).toBe(STATUS_CLOSED);
  });

  it('insufficient balance: payDirect throws, channel still cleanly closeable', async () => {
    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(channel.id);
      await h.hubServer.registerChannel(channel, init ?? undefined);
    }

    await expect(alice.client.payDirect(channel.id, { amount: 20n * ONE_USDC })).rejects.toThrow(
      /insufficient balance/i,
    );

    const stored = await alice.storage.loadLatestState(channel.id);
    expect(stored?.state.version).toBe(1n);
    expect(stored?.state.balanceA).toBe(10n * ONE_USDC);

    await alice.client.close(channel.id, { cooperative: true });
    expect(await readUsdcBalance(h, h.alice.address)).toBe(100n * ONE_USDC);
    expect(await readUsdcBalance(h, h.hub.address)).toBe(100n * ONE_USDC);
  });

  it('replay attack: dispute with same posted version reverts stale', async () => {
    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(channel.id);
      await h.hubServer.registerChannel(channel, init ?? undefined);
    }

    await alice.client.payDirect(channel.id, { amount: 5n * ONE_USDC });
    const v2 = await alice.storage.loadLatestState(channel.id);
    if (!v2) throw new Error('no v2 state');
    expect(v2.state.version).toBe(2n);

    await alice.client.close(channel.id, { cooperative: false });
    expect(await readChannelStatus(h, channel.id)).toBe(STATUS_CLOSING_UNILATERAL);

    const aliceWallet = createWalletClient({
      account: privateKeyToAccount(h.alice.privateKey),
      chain: foundry,
      transport: http(h.rpcUrl),
    });
    await expect(
      aliceWallet.writeContract({
        address: h.paymentChannel,
        abi: paymentChannelAttackAbi,
        functionName: 'dispute',
        args: [
          channel.id,
          encodeChannelStateForOnChain(v2.state),
          signatureToHex(v2.sigA),
          signatureToHex(v2.sigB),
        ],
      }),
    ).rejects.toThrow(/stale/i);

    expect(await readChannelStatus(h, channel.id)).toBe(STATUS_CLOSING_UNILATERAL);
  });

  it('replay attack: closeUnilateral on already-closed channel reverts !open', async () => {
    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(channel.id);
      await h.hubServer.registerChannel(channel, init ?? undefined);
    }

    await alice.client.payDirect(channel.id, { amount: 5n * ONE_USDC });
    const v2 = await alice.storage.loadLatestState(channel.id);
    if (!v2) throw new Error('no v2 state');

    await alice.client.close(channel.id, { cooperative: true });
    expect(await readChannelStatus(h, channel.id)).toBe(STATUS_CLOSED);

    const aliceWallet = createWalletClient({
      account: privateKeyToAccount(h.alice.privateKey),
      chain: foundry,
      transport: http(h.rpcUrl),
    });
    await expect(
      aliceWallet.writeContract({
        address: h.paymentChannel,
        abi: paymentChannelAttackAbi,
        functionName: 'closeUnilateral',
        args: [channel.id, encodeChannelStateForOnChain(v2.state), signatureToHex(v2.sigB)],
      }),
    ).rejects.toThrow(/!open/);

    expect(await readChannelStatus(h, channel.id)).toBe(STATUS_CLOSED);
  });

  it('unilateral close → time-warp 24h → finalize pays out posted balances', async () => {
    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(channel.id);
      await h.hubServer.registerChannel(channel, init ?? undefined);
    }

    await alice.client.payDirect(channel.id, { amount: 5n * ONE_USDC });

    await alice.client.close(channel.id, { cooperative: false });
    expect(await readChannelStatus(h, channel.id)).toBe(STATUS_CLOSING_UNILATERAL);

    await timeWarp(h.rpcUrl, 24 * 60 * 60 + 1);

    const finalized = await alice.client
      .list()
      .then((channels) => channels.find((c) => c.id === channel.id));
    expect(finalized).toBeDefined();

    const finalizedResult = await (
      alice.client as unknown as { opts: { chain: { finalize: (id: string) => Promise<unknown> } } }
    ).opts.chain.finalize(channel.id);
    expect(finalizedResult).toBeDefined();

    expect(await readUsdcBalance(h, h.alice.address)).toBe(95n * ONE_USDC);
    expect(await readUsdcBalance(h, h.hub.address)).toBe(105n * ONE_USDC);
    expect(await readChannelStatus(h, channel.id)).toBe(STATUS_CLOSED);
  });
});

describe('e2e — phase 2B agent-pay-agent (3-party HTLC)', () => {
  let h: E2EHandle;
  let alice: AliceBundle;
  let bob: ClientBundle;

  beforeEach(async () => {
    h = await bootE2E();
    alice = buildAliceClient(h);
    const bobKeysend = generateKeysendKeypair();
    bob = buildClient(h, h.bob, { encryption: bobKeysend });
  }, 60_000);

  afterEach(async () => {
    await alice?.transport.close();
    await bob?.transport.close();
    await h?.stop();
  });

  // Skipped: this test used the dual-funded open pattern (counterpartyAmount > 0)
  // which violates spec §1 ("amountB MUST be 0"). Inbound liquidity is now
  // provisioned via §8 topUp. Equivalent coverage:
  // - inbound-liquidity.scenarios.test.ts > Scenario 6 (Alice → Hub → Bob via topUp)
  it.skip('alice → hub → bob: invoice pay through real hub router', async () => {
    const aliceChannel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(aliceChannel.id);
      await h.hubServer.registerChannel(aliceChannel, init ?? undefined);
    }

    const bobChannel = await bob.client.open({
      counterparty: h.hub.address,
      amount: 0n,
      counterpartyAmount: 10n * ONE_USDC,
    });
    {
      const init = await bob.storage.loadLatestState(bobChannel.id);
      await h.hubServer.registerChannel(bobChannel, init ?? undefined);
    }
    await bob.client.ensureSubscribed([bobChannel.id]);

    const { invoice, preimage: expectedPreimage } = await bob.client.createInvoice({
      amount: 5n * ONE_USDC,
      memo: 'agent-pay-agent test',
    });

    const result = await alice.client.pay({ invoice });
    expect(result.preimage).toBe(expectedPreimage);
    expect(result.channelId).toBe(aliceChannel.id);

    const aliceState = await alice.storage.loadLatestState(aliceChannel.id);
    expect(aliceState?.state.htlcs).toEqual([]);
    const aliceBalance = aliceState?.state.balanceA ?? 0n;
    expect(aliceBalance).toBeLessThanOrEqual(100n * ONE_USDC - 5n * ONE_USDC);
    expect(aliceBalance).toBeGreaterThan(94n * ONE_USDC);

    const bobState = await bob.storage.loadLatestState(bobChannel.id);
    expect(bobState?.state.htlcs).toEqual([]);
    expect(bobState?.state.balanceA).toBeGreaterThanOrEqual(5n * ONE_USDC);

    const bobInvoice = await bob.storage.loadInvoice(invoice.paymentHash);
    expect(bobInvoice?.consumedAt).toBeGreaterThan(0);
  });
});

describe('e2e — phase 2C dispute → finalize (watchtower wins)', () => {
  let h: E2EHandle;
  let alice: AliceBundle;

  beforeEach(async () => {
    h = await bootE2E();
    alice = buildAliceClient(h);
  }, 60_000);

  afterEach(async () => {
    await alice?.transport.close();
    await h?.stop();
  });

  it('hub posts stale v3, watchtower penalty-proofs v6, finalize → alice gets 100% slash pot', async () => {
    const { startWatchtower } = await import('@inferenceroom/pico-watchtower');

    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
    });
    const v1 = await alice.storage.loadLatestState(channel.id);
    await h.hubServer.registerChannel(channel, v1 ?? undefined);

    const watchtowerKey =
      '0x0000000000000000000000000000000000000000000000000000000000000ccc' as const;
    const watchtowerAccount = privateKeyToAccount(watchtowerKey);
    const wtFundHex = `0x${(10n ** 18n).toString(16)}` as `0x${string}`;
    await fetch(h.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'anvil_setBalance',
        params: [watchtowerAccount.address, wtFundHex],
      }),
    });

    const wt = await startWatchtower({
      rpcUrl: h.rpcUrl,
      privateKey: watchtowerKey,
      paymentChannelAddress: h.paymentChannel,
      chainId: h.chainId,
      pollingIntervalMs: 100,
      confirmations: 1,
      thresholdRatio: 0,
      startHttp: false,
    });

    try {
      if (v1) await wt.remember(v1);

      await alice.client.payDirect(channel.id, { amount: 5n * ONE_USDC });
      const v2 = await alice.storage.loadLatestState(channel.id);
      if (v2) await wt.remember(v2);

      await alice.client.payDirect(channel.id, { amount: 3n * ONE_USDC });
      const v3 = await alice.storage.loadLatestState(channel.id);
      if (v3) await wt.remember(v3);

      await alice.client.payDirect(channel.id, { amount: 2n * ONE_USDC });
      const v4 = await alice.storage.loadLatestState(channel.id);
      if (v4) await wt.remember(v4);

      await alice.client.payDirect(channel.id, { amount: 4n * ONE_USDC });
      const v5 = await alice.storage.loadLatestState(channel.id);
      if (v5) await wt.remember(v5);

      await alice.client.payDirect(channel.id, { amount: 1n * ONE_USDC });
      const v6 = await alice.storage.loadLatestState(channel.id);
      if (v6) await wt.remember(v6);
      expect(v6?.state.version).toBe(6n);

      const stale = v3;
      if (!stale) throw new Error('no stale state');

      const hubAttackerWallet = createWalletClient({
        account: privateKeyToAccount(h.hub.privateKey),
        chain: foundry,
        transport: http(h.rpcUrl),
      });
      const closeHash = await hubAttackerWallet.writeContract({
        address: h.paymentChannel,
        abi: paymentChannelAttackAbi,
        functionName: 'closeUnilateral',
        args: [channel.id, encodeChannelStateForOnChain(stale.state), signatureToHex(stale.sigA)],
      });
      await h.publicClient.waitForTransactionReceipt({ hash: closeHash });
      expect(await readChannelStatus(h, channel.id)).toBe(STATUS_CLOSING_UNILATERAL);

      let posted = 0n;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const row = await h.publicClient.readContract({
          address: h.paymentChannel,
          abi: paymentChannelStatusAbi,
          functionName: 'channels',
          args: [channel.id],
        });
        posted = row[7];
        const penalized = row[10];
        if (posted === 6n && penalized) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(posted).toBe(6n);

      await timeWarp(h.rpcUrl, 24 * 60 * 60 + 1);

      const aliceWallet = createWalletClient({
        account: privateKeyToAccount(h.alice.privateKey),
        chain: foundry,
        transport: http(h.rpcUrl),
      });
      const finalizeAbi = parseAbi(['function finalize(bytes32 channelId)']);
      const fHash = await aliceWallet.writeContract({
        address: h.paymentChannel,
        abi: finalizeAbi,
        functionName: 'finalize',
        args: [channel.id],
      });
      await h.publicClient.waitForTransactionReceipt({ hash: fHash });

      expect(await readChannelStatus(h, channel.id)).toBe(STATUS_CLOSED);
      const aliceUsdc = await readUsdcBalance(h, h.alice.address);
      const hubUsdc = await readUsdcBalance(h, h.hub.address);
      expect(aliceUsdc).toBe(100n * ONE_USDC);
      expect(hubUsdc).toBe(100n * ONE_USDC);
    } finally {
      await wt.stop();
    }
  });
});

describe('e2e — phase 2D hot-key rotation', () => {
  let h: E2EHandle;

  beforeEach(async () => {
    h = await bootE2E();
  }, 60_000);

  afterEach(async () => {
    await h?.stop();
  });

  it('alice rotates to a new key, opens a fresh channel, on-chain ChannelOpened reflects new userA', async () => {
    const k1Bundle = buildClient(h, h.alice);
    try {
      const ch1 = await k1Bundle.client.open({
        counterparty: h.hub.address,
        amount: 100n * ONE_USDC,
      });
      {
        const init = await k1Bundle.storage.loadLatestState(ch1.id);
        await h.hubServer.registerChannel(ch1, init ?? undefined);
      }
      await k1Bundle.client.payDirect(ch1.id, { amount: 5n * ONE_USDC });
      await k1Bundle.client.close(ch1.id, { cooperative: true });
      expect(await readUsdcBalance(h, h.alice.address)).toBe(95n * ONE_USDC);
    } finally {
      await k1Bundle.transport.close();
    }

    const newKey = '0x000000000000000000000000000000000000000000000000000000000000aaaa' as const;
    const newParty = await h.fundAndApproveParty(newKey, 50n * ONE_USDC);
    expect(newParty.address.toLowerCase()).not.toBe(h.alice.address.toLowerCase());

    const k2Bundle = buildClient(h, newParty);
    try {
      const ch2 = await k2Bundle.client.open({
        counterparty: h.hub.address,
        amount: 50n * ONE_USDC,
      });
      {
        const init = await k2Bundle.storage.loadLatestState(ch2.id);
        await h.hubServer.registerChannel(ch2, init ?? undefined);
      }

      const onChainCh = await h.publicClient.readContract({
        address: h.paymentChannel,
        abi: paymentChannelStatusAbi,
        functionName: 'channels',
        args: [ch2.id],
      });
      const userA = onChainCh[0];
      expect(userA.toLowerCase()).toBe(newParty.address.toLowerCase());

      await k2Bundle.client.payDirect(ch2.id, { amount: 3n * ONE_USDC });
      await k2Bundle.client.close(ch2.id, { cooperative: true });

      expect(await readUsdcBalance(h, newParty.address)).toBe(47n * ONE_USDC);
    } finally {
      await k2Bundle.transport.close();
    }
  });
});

describe('e2e — phase 2D hub-down recovery', () => {
  let h: E2EHandle;
  let alice: AliceBundle;

  beforeEach(async () => {
    h = await bootE2E();
    alice = buildAliceClient(h);
  }, 60_000);

  afterEach(async () => {
    await alice?.transport.close();
    await h?.stop();
  });

  it('hub restarts; SDK auto-reconnects + re-subscribes; subsequent payDirect succeeds', async () => {
    const { startRealHub } = await import('./harness.js');

    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(channel.id);
      await h.hubServer.registerChannel(channel, init ?? undefined);
    }

    await alice.client.payDirect(channel.id, { amount: 5n * ONE_USDC });
    const v2 = await alice.storage.loadLatestState(channel.id);
    expect(v2?.state.version).toBe(2n);

    const portMatch = h.hubServer.url.match(/:(\d+)\//);
    if (!portMatch || !portMatch[1]) throw new Error('cannot parse hub port');
    const port = Number(portMatch[1]);
    await h.hubServer.stop();
    await alice.transport.close();

    const reborn = await startRealHub({
      hubPrivateKey: h.hub.privateKey,
      rpcUrl: h.rpcUrl,
      chainId: h.chainId,
      paymentChannelAddress: h.paymentChannel,
      adjudicatorAddress: h.adjudicator,
      port,
    });
    try {
      await reborn.registerChannel(channel, v2 ?? undefined);

      const reconnected = buildClient(h, h.alice);
      try {
        await reconnected.storage.saveChannel(channel);
        if (v2) await reconnected.storage.saveState(channel.id, v2);
        await reconnected.client.ensureSubscribed([channel.id]);

        await reconnected.client.payDirect(channel.id, { amount: 3n * ONE_USDC });
        const v3 = await reconnected.storage.loadLatestState(channel.id);
        expect(v3?.state.version).toBe(3n);
        expect(v3?.state.balanceA).toBe(92n * ONE_USDC);
      } finally {
        await reconnected.transport.close();
      }
    } finally {
      await reborn.stop();
    }
  });
});

describe('e2e — phase 2D receiver offline then resume', () => {
  let h: E2EHandle;
  let alice: AliceBundle;
  let bob: ClientBundle;

  beforeEach(async () => {
    h = await bootE2E({
      hubEnv: { CHAIN_POLLING_INTERVAL_MS: '500', CHAIN_CONFIRMATIONS: '0' },
    });
    alice = buildAliceClient(h);
    const bobKeysend = generateKeysendKeypair();
    bob = buildClient(h, h.bob, { encryption: bobKeysend });
  }, 60_000);

  afterEach(async () => {
    await alice?.transport.close();
    await bob?.transport.close();
    await h?.stop();
  });

  it('hub queues HTLC while bob is offline; bob reconnects, replays via subscribeAck.pendingHtlcs, settles', async () => {
    // Alice opens single-sided per spec §1 (amountB MUST be 0).
    const aliceChannel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(aliceChannel.id);
      await h.hubServer.registerChannel(aliceChannel, init ?? undefined);
    }

    // Bob opens single-sided; the hub auto-tops-up Bob's channel via §8 so
    // the router has outbound liquidity for HTLC routing. Wait for the topUp
    // to confirm before issuing the invoice. Register WITHOUT the
    // opener-signed v=1 state (matches inbound-liquidity Scenario 5/6
    // pattern) so the hub uses its sentinel v=0 prev branch and produces a
    // v=1 fully co-signed state.
    const bobChannel = await bob.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    await h.hubServer.registerChannelWithAmounts(bobChannel, {
      amountA: 10n * ONE_USDC,
      amountB: 0n,
    });
    await bob.client.ensureSubscribed([bobChannel.id]);

    const deadline = Date.now() + 15_000;
    let topUpAmountB = 0n;
    while (Date.now() < deadline) {
      const row = await h.publicClient.readContract({
        address: h.paymentChannel,
        abi: paymentChannelStatusAbi,
        functionName: 'channels',
        args: [bobChannel.id],
      });
      if (row[4] > 0n && row[7] >= 1n) {
        topUpAmountB = row[4];
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(topUpAmountB).toBeGreaterThan(0n);

    // Wait for the hub's chain-watcher to ingest the ToppedUp event so the
    // router has the post-topUp state for Bob's channel. Without this, the
    // pay below races and fails with "no signed state for outgoing channel".
    const built = h.hubServer._internal?.built;
    if (!built) throw new Error('hubServer._internal.built not exposed');
    const stateDeadline = Date.now() + 10_000;
    while (Date.now() < stateDeadline) {
      const latest = built.channelPool.latest(bobChannel.id);
      if (latest && latest.state.version >= 1n && latest.state.balanceB > 0n) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Invoice amount must fit inside the hub's outbound liquidity (= the
    // top-up amount). 1 USDC ≪ default 5 USDC top-up.
    const invoiceAmount = 1n * ONE_USDC;
    const { invoice, preimage: expectedPreimage } = await bob.client.createInvoice({
      amount: invoiceAmount,
      memo: 'offline-resume test',
    });

    await bob.transport.close();

    const payPromise = alice.client.pay({ invoice });

    await new Promise((r) => setTimeout(r, 200));

    const bobReborn = buildClient(h, h.bob);
    try {
      await bobReborn.storage.saveChannel(bobChannel);
      const bobInit = await bob.storage.loadLatestState(bobChannel.id);
      if (bobInit) await bobReborn.storage.saveState(bobChannel.id, bobInit);
      await bobReborn.storage.saveInvoice(invoice, expectedPreimage);
      await bobReborn.client.ensureSubscribed([bobChannel.id]);

      const result = await payPromise;
      expect(result.preimage).toBe(expectedPreimage);

      const aliceState = await alice.storage.loadLatestState(aliceChannel.id);
      expect(aliceState?.state.htlcs).toEqual([]);

      const consumed = await bobReborn.storage.loadInvoice(invoice.paymentHash);
      expect(consumed?.consumedAt).toBeGreaterThan(0);
    } finally {
      await bobReborn.transport.close();
    }
  }, 30_000);
});
