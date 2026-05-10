/**
 * End-to-end tests for `docs/inbound-liquidity-scenarios.md`. Each `it`
 * block name matches a scenario heading verbatim. Scenarios that are
 * intrinsically off-chain (mutex serialization, reject/expire flows) or
 * Foundry-only (drain attacks) are documented as `it.skip` here with a
 * pointer to where they ARE covered.
 *
 * Vanilla anvil mode only — these tests deploy fresh PaymentChannel +
 * Adjudicator contracts per `bootE2E()` invocation, then drive the SDK,
 * hub, and chain together.
 */
import type { ChannelId, CooperativeClose } from '@inferenceroom/pico-protocol';
import { encodeCooperativeCloseForOnChain, localSigner } from '@inferenceroom/pico-sdk';
import { http, createWalletClient, erc20Abi, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AliceBundle,
  type BobBundle,
  type ClientBundle,
  type E2EHandle,
  bootE2E,
  buildAliceClient,
  buildBobClient,
  timeWarp,
} from './harness.js';

const ONE_USDC = 1_000_000n;
const STATUS_OPEN = 1;
const STATUS_CLOSING_UNILATERAL = 2;
const STATUS_CLOSED = 3;

// Hub admission policy default; matches DEFAULT_TOPUP_POLICY.defaultOfferAmount
// in apps/hub/src/topup-policy.ts.
const HUB_DEFAULT_TOPUP = 5n * ONE_USDC;

// Chain-watcher polling tuned for fast e2e turnaround. Long enough that the
// watcher cannot fire DURING client.open()'s internal awaits (each anvil tx
// resolves in <100ms), short enough that auto-topUp lands within a few
// seconds.
const FAST_POLL_ENV = {
  CHAIN_POLLING_INTERVAL_MS: '500',
  CHAIN_CONFIRMATIONS: '0',
} as const;

const paymentChannelStatusAbi = parseAbi([
  'function channels(bytes32) view returns (address userA, address userB, address token, uint256 amountA, uint256 amountB, uint64 openedAt, uint64 disputeDeadline, uint64 postedVersion, uint256 postedBalanceA, uint256 postedBalanceB, bool penalized, uint8 status, address closer)',
]);

const paymentChannelCloseAbi = parseAbi([
  'function closeCooperative(bytes32 channelId, bytes closeData, bytes sigA, bytes sigB)',
]);

interface ChannelRow {
  userA: `0x${string}`;
  userB: `0x${string}`;
  token: `0x${string}`;
  amountA: bigint;
  amountB: bigint;
  openedAt: bigint;
  disputeDeadline: bigint;
  postedVersion: bigint;
  postedBalanceA: bigint;
  postedBalanceB: bigint;
  penalized: boolean;
  status: number;
  closer: `0x${string}`;
}

/**
 * Workaround for the SDK / spec gap on first-topUp prev versions:
 * `client.open` saves an opener-only sigA-only `version: 1` state, but the
 * hub's auto-topUp path uses prev `version: 0` (sentinel) when its pool
 * holds amounts only (the hub never receives the opener-only state for the
 * topUp counterparty in production). Bob's SDK then rejects the proposeTopUp
 * envelope as `prev version mismatch (got 0, local 1)`.
 *
 * Production SDKs that opt into auto-topUp would either skip persisting the
 * opener-only state for hub-counterparty channels, or treat sigA-only v=1
 * as equivalent to v=0 sentinel during proposeTopUp validation. For e2e
 * tests we simulate that by deleting the opener state from MemoryStorage.
 */
function clearOpenerOnlyState(bundle: ClientBundle, channelId: ChannelId): void {
  (bundle.storage as unknown as { states: Map<unknown, unknown> }).states.delete(channelId);
}

/**
 * Block until the hub's in-memory channel pool has a co-signed v=1+ state
 * for `channelId`. The hub records the post-topUp state when its
 * chain-watcher observes the `ToppedUp` event (one poll cycle after the
 * tx confirms). The router needs this state to route incoming HTLCs.
 */
async function waitForHubState(
  h: E2EHandle,
  channelId: `0x${string}`,
  predicate: (state: { version: bigint; balanceA: bigint; balanceB: bigint }) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const built = h.hubServer._internal?.built;
  if (!built) throw new Error('hubServer._internal.built not exposed');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = built.channelPool.latest(channelId as `0x${string}`);
    if (latest && predicate(latest.state)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitForHubState timed out after ${timeoutMs}ms for ${channelId}`);
}

async function readChannelRow(h: E2EHandle, channelId: `0x${string}`): Promise<ChannelRow> {
  const row = await h.publicClient.readContract({
    address: h.paymentChannel,
    abi: paymentChannelStatusAbi,
    functionName: 'channels',
    args: [channelId],
  });
  return {
    userA: row[0],
    userB: row[1],
    token: row[2],
    amountA: row[3],
    amountB: row[4],
    openedAt: row[5],
    disputeDeadline: row[6],
    postedVersion: row[7],
    postedBalanceA: row[8],
    postedBalanceB: row[9],
    penalized: row[10],
    status: row[11],
    closer: row[12],
  };
}

async function readUsdcBalance(h: E2EHandle, addr: `0x${string}`): Promise<bigint> {
  return h.publicClient.readContract({
    address: h.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [addr],
  });
}

/** Polls the channel row until `predicate` is satisfied or `timeoutMs` elapses. */
async function waitForChannelRow(
  h: E2EHandle,
  channelId: `0x${string}`,
  predicate: (row: ChannelRow) => boolean,
  timeoutMs = 10_000,
): Promise<ChannelRow> {
  const deadline = Date.now() + timeoutMs;
  let last: ChannelRow | undefined;
  while (Date.now() < deadline) {
    last = await readChannelRow(h, channelId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `waitForChannelRow timed out after ${timeoutMs}ms; last row=${JSON.stringify(last, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    )}`,
  );
}

describe('inbound-liquidity scenarios', () => {
  let h: E2EHandle;
  let alice: AliceBundle;
  let bob: BobBundle;

  beforeEach(async () => {
    h = await bootE2E({ hubEnv: FAST_POLL_ENV });
    alice = buildAliceClient(h);
    bob = buildBobClient(h);
  }, 60_000);

  afterEach(async () => {
    await alice?.transport.close();
    await bob?.transport.close();
    await h?.stop();
  });

  // ───────────── Scenario 1 ─────────────
  it('Scenario 1 — Alice opens a one-sided channel to the hub', async () => {
    const aliceUsdcBefore = await readUsdcBalance(h, h.alice.address);
    const pcUsdcBefore = await readUsdcBalance(h, h.paymentChannel);

    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    const init = await alice.storage.loadLatestState(channel.id);
    await h.hubServer.registerChannel(channel, init ?? undefined);

    const row = await readChannelRow(h, channel.id);
    expect(row.status).toBe(STATUS_OPEN);
    expect(row.userA.toLowerCase()).toBe(h.alice.address.toLowerCase());
    expect(row.userB.toLowerCase()).toBe(h.hub.address.toLowerCase());
    expect(row.amountA).toBe(10n * ONE_USDC);
    expect(row.amountB).toBe(0n);

    expect(await readUsdcBalance(h, h.alice.address)).toBe(aliceUsdcBefore - 10n * ONE_USDC);
    expect(await readUsdcBalance(h, h.paymentChannel)).toBe(pcUsdcBefore + 10n * ONE_USDC);

    const stored = await alice.storage.loadChannel(channel.id);
    expect(stored).toBeDefined();
    const v1 = await alice.storage.loadLatestState(channel.id);
    expect(v1?.state.version).toBe(1n);
    expect(v1?.state.balanceA).toBe(10n * ONE_USDC);
    expect(v1?.state.balanceB).toBe(0n);
  });

  // ───────────── Scenario 2 ─────────────
  it('Scenario 2 — Alice pays the hub directly (`payDirect` 1 USDC)', async () => {
    const channel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    const init = await alice.storage.loadLatestState(channel.id);
    await h.hubServer.registerChannel(channel, init ?? undefined);

    const result = await alice.client.payDirect(channel.id, { amount: 1n * ONE_USDC });
    expect(result.version).toBe(2n);

    const v2 = await alice.storage.loadLatestState(channel.id);
    expect(v2?.state.version).toBe(2n);
    expect(v2?.state.balanceA).toBe(9n * ONE_USDC);
    expect(v2?.state.balanceB).toBe(1n * ONE_USDC);
    // Co-signed: both sigA and sigB are non-zero.
    expect(v2?.sigA.r).not.toMatch(/^0x0+$/);
    expect(v2?.sigB.r).not.toMatch(/^0x0+$/);

    // On-chain unchanged.
    const row = await readChannelRow(h, channel.id);
    expect(row.amountA).toBe(10n * ONE_USDC);
    expect(row.amountB).toBe(0n);
    expect(row.postedVersion).toBe(0n);
  });

  // ───────────── Scenario 3 ─────────────
  it('Scenario 3 — Bob opens a one-sided channel', async () => {
    const aliceChannel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(aliceChannel.id);
      await h.hubServer.registerChannel(aliceChannel, init ?? undefined);
    }

    const bobChannel = await bob.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    {
      const init = await bob.storage.loadLatestState(bobChannel.id);
      await h.hubServer.registerChannel(bobChannel, init ?? undefined);
    }

    expect(bobChannel.id).not.toBe(aliceChannel.id);

    const bobRow = await readChannelRow(h, bobChannel.id);
    expect(bobRow.status).toBe(STATUS_OPEN);
    expect(bobRow.userA.toLowerCase()).toBe(h.bob.address.toLowerCase());
    expect(bobRow.userB.toLowerCase()).toBe(h.hub.address.toLowerCase());
    expect(bobRow.amountA).toBe(10n * ONE_USDC);
    expect(bobRow.amountB).toBe(0n);

    // Total funds in PaymentChannel = 20 USDC (10 from Alice + 10 from Bob).
    expect(await readUsdcBalance(h, h.paymentChannel)).toBe(20n * ONE_USDC);
  });

  // ───────────── Scenario 4 ─────────────
  it('Scenario 4 — Alice tries to pay Bob via the hub (FAILS without top-up)', async () => {
    const aliceChannel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(aliceChannel.id);
      await h.hubServer.registerChannel(aliceChannel, init ?? undefined);
    }

    // Bob opens HONESTLY (amountB=0). To reproduce the "no inbound" gap, we
    // register Bob's channel WITH the opener-only v=1 state (hub-side balance
    // is 0). The hub's auto-topUp will attempt and fail on-chain ("prev bad
    // sig" — the v=1 state is sigA-only) so balanceB stays 0; the router then
    // rejects the pay with "hub liquidity 0".
    const bobChannel = await bob.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    {
      const init = await bob.storage.loadLatestState(bobChannel.id);
      await h.hubServer.registerChannel(bobChannel, init ?? undefined);
    }
    await bob.client.ensureSubscribed([bobChannel.id]);

    const { invoice } = await bob.client.createInvoice({
      amount: 1n * ONE_USDC,
      memo: 'no-liquidity test',
    });

    // Pay should fail. The exact message depends on whether the chain-watcher
    // has polled yet (router: "hub liquidity 0" / "no channel" / "topUp
    // failed" — all valid signals of the §8 inbound gap).
    let rejected = false;
    try {
      await alice.client.pay({ invoice });
    } catch (err) {
      rejected = true;
      const msg = (err as Error).message;
      expect(msg).toMatch(/liquidity|no.*outbound|no channel|outgoing|fail|insufficient/i);
    }
    expect(rejected).toBe(true);
  });

  // ───────────── Scenario 5 ─────────────
  it('Scenario 5 — Hub auto-tops-up Bob’s channel (the new flow)', async () => {
    const bobChannel = await bob.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    // Register WITHOUT the opener-signed v=1 state — only amounts. The hub
    // then uses the sentinel v=0 prev branch in proposeUnderLock and the
    // auto-topUp produces a v=1 fully co-signed state (matches §8.6 spec).
    await h.hubServer.registerChannelWithAmounts(bobChannel, {
      amountA: 10n * ONE_USDC,
      amountB: 0n,
    });
    clearOpenerOnlyState(bob, bobChannel.id);
    await bob.client.ensureSubscribed([bobChannel.id]);

    // Wait for the hub to top-up by polling on-chain. The chain-watcher polls
    // every CHAIN_POLLING_INTERVAL_MS, sees ChannelOpened, fires
    // evaluateNewChannel → proposeTopUp → Bob auto-accepts → on-chain topUp →
    // ToppedUp event → on-chain amountB increases by 5 USDC.
    const row = await waitForChannelRow(
      h,
      bobChannel.id,
      (r) => r.amountB === HUB_DEFAULT_TOPUP && r.postedVersion === 1n,
      15_000,
    );
    expect(row.amountA).toBe(10n * ONE_USDC);
    expect(row.amountB).toBe(HUB_DEFAULT_TOPUP);
    expect(row.postedVersion).toBe(1n);
    expect(row.status).toBe(STATUS_OPEN);
  });

  // ───────────── Scenario 6 ─────────────
  it('Scenario 6 — Alice pays Bob 1 USDC via hub (NOW WORKS)', async () => {
    const aliceChannel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(aliceChannel.id);
      await h.hubServer.registerChannel(aliceChannel, init ?? undefined);
    }

    const bobChannel = await bob.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    await h.hubServer.registerChannelWithAmounts(bobChannel, {
      amountA: 10n * ONE_USDC,
      amountB: 0n,
    });
    clearOpenerOnlyState(bob, bobChannel.id);
    await bob.client.ensureSubscribed([bobChannel.id]);

    // Wait for hub to auto-topUp Bob (Scenario 5 mechanics) and for the hub's
    // pool to record the post-topUp state (router needs it to route HTLCs).
    await waitForChannelRow(
      h,
      bobChannel.id,
      (r) => r.amountB === HUB_DEFAULT_TOPUP && r.postedVersion === 1n,
      15_000,
    );
    await waitForHubState(
      h,
      bobChannel.id,
      (s) => s.version >= 1n && s.balanceB === HUB_DEFAULT_TOPUP,
    );

    // Alice pays Bob 1 USDC via invoice. Hub routes through Bob's now-funded
    // channel.
    const { invoice, preimage: expectedPreimage } = await bob.client.createInvoice({
      amount: 1n * ONE_USDC,
      memo: 'scenario-6 pay',
    });

    const result = await alice.client.pay({ invoice });
    expect(result.preimage).toBe(expectedPreimage);
    expect(result.channelId).toBe(aliceChannel.id);

    // Alice's state: balanceA was 10; after paying 1 USDC (hubFeeBps=0, hubFeeFlat=0)
    // it should be 9.
    const aliceState = await alice.storage.loadLatestState(aliceChannel.id);
    expect(aliceState?.state.htlcs).toEqual([]);
    expect(aliceState?.state.balanceA).toBe(9n * ONE_USDC);
    expect(aliceState?.state.balanceB).toBe(1n * ONE_USDC);

    // Bob's state: balanceA was 10 from open; after receiving 1 USDC his side
    // increases by 1. Hub's side (B) was 5 from topUp; after sending 1 it's 4.
    const bobState = await bob.storage.loadLatestState(bobChannel.id);
    expect(bobState?.state.htlcs).toEqual([]);
    expect(bobState?.state.balanceA).toBe(11n * ONE_USDC);
    expect(bobState?.state.balanceB).toBe(4n * ONE_USDC);
  });

  // ───────────── Scenario 7 ─────────────
  it('Scenario 7 — Cooperative close of both channels', async () => {
    // Replay defense: after a successful coop close, the channel status is
    // Closed. Resubmitting any close (stale or fresh) reverts with `!open`.
    const aliceChannel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(aliceChannel.id);
      await h.hubServer.registerChannel(aliceChannel, init ?? undefined);
    }

    const bobChannel = await bob.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    await h.hubServer.registerChannelWithAmounts(bobChannel, {
      amountA: 10n * ONE_USDC,
      amountB: 0n,
    });
    clearOpenerOnlyState(bob, bobChannel.id);
    await bob.client.ensureSubscribed([bobChannel.id]);

    // Wait for hub auto-topUp on Bob (on-chain + hub-pool consistency).
    await waitForChannelRow(
      h,
      bobChannel.id,
      (r) => r.amountB === HUB_DEFAULT_TOPUP && r.postedVersion === 1n,
      15_000,
    );
    await waitForHubState(
      h,
      bobChannel.id,
      (s) => s.version >= 1n && s.balanceB === HUB_DEFAULT_TOPUP,
    );

    // Alice payDirect 1 USDC (bumps Alice's channel to v=2).
    await alice.client.payDirect(aliceChannel.id, { amount: 1n * ONE_USDC });

    // Alice sends 1 USDC to Bob via HTLC routing (Alice v=4, Bob v=3).
    const { invoice } = await bob.client.createInvoice({
      amount: 1n * ONE_USDC,
      memo: 'scenario-7 setup',
    });
    await alice.client.pay({ invoice });

    const aliceLatest = await alice.storage.loadLatestState(aliceChannel.id);
    const bobLatest = await bob.storage.loadLatestState(bobChannel.id);
    if (!aliceLatest || !bobLatest) throw new Error('missing state');

    // Cooperative close Alice's channel.
    await alice.client.close(aliceChannel.id, { cooperative: true });
    const aliceRowAfter = await readChannelRow(h, aliceChannel.id);
    expect(aliceRowAfter.status).toBe(STATUS_CLOSED);
    expect(aliceRowAfter.postedVersion).toBeGreaterThan(aliceLatest.state.version);

    // Cooperative close Bob's channel.
    await bob.client.close(bobChannel.id, { cooperative: true });
    const bobRowAfter = await readChannelRow(h, bobChannel.id);
    expect(bobRowAfter.status).toBe(STATUS_CLOSED);
    expect(bobRowAfter.postedVersion).toBeGreaterThan(bobLatest.state.version);
    // Bob's channel had postedVersion=1 from topUp; final close version > 1.
    expect(bobRowAfter.postedVersion).toBeGreaterThan(1n);

    // Replay attempt: re-sign a fresh CooperativeClose against Alice's
    // channel, submit it. Expect revert with `!open` since the channel is
    // already Closed. This proves a once-closed channel cannot be re-closed
    // by replaying a stale (or fresh) authorization.
    const stale: CooperativeClose = {
      channelId: aliceChannel.id,
      version: 999n,
      finalBalanceA: aliceRowAfter.amountA,
      finalBalanceB: aliceRowAfter.amountB,
      signedAt: BigInt(Math.floor(Date.now() / 1000)),
      validUntil: BigInt(Math.floor(Date.now() / 1000)) + 3600n,
    };
    const aliceSigner = localSigner(h.alice.privateKey);
    const hubSigner = localSigner(h.hub.privateKey);
    const aliceCloseSig = await aliceSigner.signCooperativeClose(stale, h.chainId, h.adjudicator);
    const hubCloseSig = await hubSigner.signCooperativeClose(stale, h.chainId, h.adjudicator);

    const aliceWallet = createWalletClient({
      account: privateKeyToAccount(h.alice.privateKey),
      chain: foundry,
      transport: http(h.rpcUrl),
    });
    await expect(
      aliceWallet.writeContract({
        address: h.paymentChannel,
        abi: paymentChannelCloseAbi,
        functionName: 'closeCooperative',
        args: [
          aliceChannel.id,
          encodeCooperativeCloseForOnChain(stale),
          aliceCloseSig,
          hubCloseSig,
        ],
      }),
    ).rejects.toThrow(/!open/);
  });

  // ───────────── Scenario 8 ─────────────
  it('Scenario 8 — Hub recovers liquidity (no special call needed)', async () => {
    const hubUsdcStart = await readUsdcBalance(h, h.hub.address);

    const aliceChannel = await alice.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    {
      const init = await alice.storage.loadLatestState(aliceChannel.id);
      await h.hubServer.registerChannel(aliceChannel, init ?? undefined);
    }

    const bobChannel = await bob.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    await h.hubServer.registerChannelWithAmounts(bobChannel, {
      amountA: 10n * ONE_USDC,
      amountB: 0n,
    });
    clearOpenerOnlyState(bob, bobChannel.id);
    await bob.client.ensureSubscribed([bobChannel.id]);

    await waitForChannelRow(
      h,
      bobChannel.id,
      (r) => r.amountB === HUB_DEFAULT_TOPUP && r.postedVersion === 1n,
      15_000,
    );
    await waitForHubState(
      h,
      bobChannel.id,
      (s) => s.version >= 1n && s.balanceB === HUB_DEFAULT_TOPUP,
    );

    // Alice payDirects 1 USDC to hub.
    await alice.client.payDirect(aliceChannel.id, { amount: 1n * ONE_USDC });

    // Alice → Bob 1 USDC via HTLC.
    const { invoice } = await bob.client.createInvoice({
      amount: 1n * ONE_USDC,
      memo: 'scenario-8 setup',
    });
    await alice.client.pay({ invoice });

    // Cooperative close both.
    await alice.client.close(aliceChannel.id, { cooperative: true });
    await bob.client.close(bobChannel.id, { cooperative: true });

    // Net hub USDC: started with 100. Spent 5 on topUp. Got back 2 (Alice's
    // payDirect routed to hub) + 4 (Bob's HTLC fee + topUp recovered). With
    // hubFeeBps=0/hubFeeFlat=0, the only direct value to hub is Alice's
    // payDirect = 1 USDC. Hub finalA on Alice's coop = 2 (1 payDirect + 1
    // routed to Bob held momentarily); hub finalB on Bob's coop = 4 (5 topUp
    // - 1 sent to Bob).
    //
    // hub deltas:
    //   - paid out 5 (topUp).
    //   - received 2 from Alice's coop (Alice 8, Hub 2).
    //   - received 4 from Bob's coop (Bob 11, Hub 4).
    // Net: -5 + 2 + 4 = +1 USDC.
    const hubUsdcEnd = await readUsdcBalance(h, h.hub.address);
    expect(hubUsdcEnd - hubUsdcStart).toBe(1n * ONE_USDC);
  });

  // ───────────── Scenario 9 ─────────────
  it.skip('Scenario 9 — Drain attempts (not possible by construction)', async () => {
    // Covered by Foundry tests in
    //   packages/contracts/test/PaymentChannel.drainAttacks.t.sol
    // which exercises the attacker-driven openChannel and topUp paths
    // against the contract's allowance + msg.sender invariants.
  });

  // ───────────── Scenario 10 ─────────────
  it.skip('Scenario 10 — User declines or never returns a `proposeTopUp`', async () => {
    // Covered by hub-unit tests in
    //   apps/hub/src/topup-handler.test.ts
    // (rejectTopUp + expireDue suites exercise both the explicit-decline and
    // TTL-expiry codepaths). The SDK auto-accepts every well-formed offer
    // it receives, so reproducing a decline e2e would require swapping out
    // the SDK's proposeTopUp handler with a no-op stub.
  });

  // ───────────── Scenario 11 ─────────────
  it('Scenario 11 — Unilateral close from initial state (anti-hostage)', async () => {
    // Anti-hostage: open Bob's channel WITHOUT registering with the hub, so
    // the chain-watcher cannot evaluate it for auto-topUp. Then Bob can
    // recover his deposit via closeUnilateralFromOpen even though the hub
    // never co-signed any state.
    const bobUsdcBefore = await readUsdcBalance(h, h.bob.address);
    const bobChannel = await bob.client.open({
      counterparty: h.hub.address,
      amount: 10n * ONE_USDC,
    });
    // INTENTIONALLY skip h.hubServer.registerChannel — the hub's chain
    // watcher will see the ChannelOpened event but find no entry in its
    // pool, so evaluateNewChannel never fires. (See chain-watcher.ts L268:
    // `if (hubInChannel && known)`.)

    const initialRow = await readChannelRow(h, bobChannel.id);
    expect(initialRow.status).toBe(STATUS_OPEN);
    expect(initialRow.amountB).toBe(0n);

    const closeResult = await bob.client.closeUnilateralFromOpen(bobChannel.id);
    expect(closeResult.disputeDeadlineMs).toBeGreaterThan(0n);

    const closingRow = await readChannelRow(h, bobChannel.id);
    expect(closingRow.status).toBe(STATUS_CLOSING_UNILATERAL);
    expect(closingRow.disputeDeadline).toBeGreaterThan(0n);
    expect(closingRow.postedVersion).toBe(0n);
    expect(closingRow.postedBalanceA).toBe(10n * ONE_USDC);
    expect(closingRow.postedBalanceB).toBe(0n);

    // Warp 24h+1 then finalize.
    await timeWarp(h.rpcUrl, 24 * 60 * 60 + 1);

    // Use the chain adapter to call finalize. The SDK's
    // closeUnilateralFromOpen kicks off a background waitForFinalized but
    // we drive finalize() explicitly to assert end-state.
    type ChainOpts = {
      opts: {
        chain: { finalize: (id: ChannelId) => Promise<unknown> };
      };
    };
    await (bob.client as unknown as ChainOpts).opts.chain.finalize(bobChannel.id);

    const finalRow = await readChannelRow(h, bobChannel.id);
    expect(finalRow.status).toBe(STATUS_CLOSED);
    // Bob got his full deposit back.
    const bobUsdcAfter = await readUsdcBalance(h, h.bob.address);
    expect(bobUsdcAfter).toBe(bobUsdcBefore);
  }, 90_000);

  // ───────────── Scenario 12 ─────────────
  it.skip('Scenario 12 — Concurrent top-up requests across channels', async () => {
    // Covered by hub-unit tests in
    //   apps/hub/src/topup-handler.test.ts → "TopUpHandler concurrency
    //   (Scenario 12)". The mutex serialization is hub-internal and not
    //   observable through the WS API surface; e2e adds no signal beyond
    //   what the unit test already proves.
  });

  // ───────────── Scenario 13 ─────────────
  it.skip('Scenario 13 — Inbound auto-recycle on close', async () => {
    // Covered by hub-unit tests in
    //   apps/hub/src/auto-recycle.test.ts
    // which drives a queued top-up offer + simulated channel close and
    // asserts the recycled propose. End-to-end driving requires precisely
    // controlling the hub's hot-wallet headroom relative to the policy's
    // defaultOfferAmount — doable but adds substantial fixture complexity
    // for a behavior that's hub-internal (the user just sees a delayed
    // proposeTopUp arrive).
  });
});
