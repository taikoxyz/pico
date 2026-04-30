import { erc20Abi, parseAbi } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AliceBundle,
  type E2EHandle,
  bootE2E,
  buildAliceClient,
  timeWarp,
} from './harness.js';

const paymentChannelStatusAbi = parseAbi([
  'function channels(bytes32) view returns (address userA, address userB, address token, uint256 amountA, uint256 amountB, uint64 openedAt, uint64 disputeDeadline, uint64 postedVersion, uint256 postedBalanceA, uint256 postedBalanceB, bool penalized, uint8 status, address closer)',
]);

const ONE_USDC = 1_000_000n;
const STATUS_OPEN = 1;
const STATUS_CLOSING_UNILATERAL = 2;
const STATUS_CLOSED = 3;

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
    h.hubServer.registerChannel(channel);

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
    h.hubServer.registerChannel(channel);

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
    h.hubServer.registerChannel(channel);

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
    h.hubServer.registerChannel(channel);

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
    h.hubServer.registerChannel(channel);

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

  it('unilateral close → time-warp 24h → finalize pays out posted balances', async () => {
    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
    });
    h.hubServer.registerChannel(channel);

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

describe.skip('e2e — full payment lifecycle (deferred to phase 2)', () => {
  it('open → pay (HTLC) → close (cooperative) — gates on hub router', async () => {
    expect(true).toBe(true);
  });

  it('dispute window: counterparty publishes old state, watchtower penalizes', async () => {
    expect(true).toBe(true);
  });

  it('hub-down recovery: client reconnects through alternate hub', async () => {
    expect(true).toBe(true);
  });
});
