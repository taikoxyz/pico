import { http, createWalletClient, erc20Abi, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { taiko } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { type E2EHandle, bootE2E, buildAliceClient, timeWarp } from './harness.js';
import { readUsdcBalance } from './whale.js';

const FORK_URL = process.env.E2E_FORK_URL;
const FORK_BLOCK = process.env.E2E_FORK_BLOCK;
const HAS_WHALE = Boolean(process.env.E2E_USDC_WHALE);

const describeForked = FORK_URL ? describe : describe.skip;

const ONE_USDC = 10n ** 6n;

async function bootFork(): Promise<E2EHandle> {
  return bootE2E({
    forkUrl: FORK_URL as string,
    ...(FORK_BLOCK !== undefined ? { forkBlockNumber: BigInt(FORK_BLOCK) } : {}),
  });
}

describeForked('Taiko mainnet fork lifecycle (gated by E2E_FORK_URL)', () => {
  // Both lifecycle tests need real USDC value flow. Without E2E_USDC_WHALE we
  // skip; this is the documented contract per WS-16.
  it.skipIf(!HAS_WHALE)(
    'opens, pays, cooperatively closes against deployed contracts (USDC value flow)',
    async () => {
      const env = await bootFork();
      try {
        await env.fundAndApproveParty(env.alice.privateKey, 100n * ONE_USDC);
        await env.fundAndApproveParty(env.bob.privateKey, 100n * ONE_USDC);
        await env.fundAndApproveParty(env.hub.privateKey, 200n * ONE_USDC);

        const aliceUsdcBefore = await readUsdcBalance(
          env.publicClient,
          env.usdc,
          env.alice.address,
        );
        const bobUsdcBefore = await readUsdcBalance(env.publicClient, env.usdc, env.bob.address);

        const alice = buildAliceClient(env);
        try {
          const channel = await alice.client.open({
            counterparty: env.hub.address,
            amount: 100n * ONE_USDC,
          });
          const opened = await alice.storage.loadLatestState(channel.id);
          await env.hubServer.registerChannel(channel, opened ?? undefined);

          await alice.client.payDirect(channel.id, { amount: 1n * ONE_USDC });

          await alice.client.close(channel.id, { cooperative: true });

          const aliceUsdcAfter = await readUsdcBalance(
            env.publicClient,
            env.usdc,
            env.alice.address,
          );
          // Alice should be down by exactly 1 USDC (the off-chain payment) once the
          // cooperative close settles. The 100 USDC channel funding goes back as
          // 99 USDC (Alice's share) + 1 USDC (Hub's share of the channel).
          expect(aliceUsdcBefore - aliceUsdcAfter).toBe(1n * ONE_USDC);
        } finally {
          await alice.transport.close();
        }

        const bobUsdcAfter = await readUsdcBalance(env.publicClient, env.usdc, env.bob.address);
        // Bob doesn't appear in this Alice-Hub-only flow; confirm balance is unchanged.
        expect(bobUsdcAfter).toBe(bobUsdcBefore);
      } finally {
        await env.stop();
      }
    },
    180_000,
  );

  it.skipIf(!HAS_WHALE)(
    'stale-state penalty drill: hub posts old state, watchtower wins (deployed contracts)',
    async () => {
      const { startWatchtower } = await import('@inferenceroom/pico-watchtower');

      const env = await bootFork();
      try {
        await env.fundAndApproveParty(env.alice.privateKey, 100n * ONE_USDC);
        await env.fundAndApproveParty(env.hub.privateKey, 200n * ONE_USDC);

        const aliceUsdcBefore = await readUsdcBalance(
          env.publicClient,
          env.usdc,
          env.alice.address,
        );

        const alice = buildAliceClient(env);

        const watchtowerKey =
          '0x0000000000000000000000000000000000000000000000000000000000000ccc' as const;
        const watchtowerAccount = privateKeyToAccount(watchtowerKey);
        await fetch(env.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'anvil_setBalance',
            params: [watchtowerAccount.address, `0x${(10n ** 18n).toString(16)}`],
          }),
        });

        const wt = await startWatchtower({
          rpcUrl: env.rpcUrl,
          privateKey: watchtowerKey,
          paymentChannelAddress: env.paymentChannel,
          chainId: env.chainId,
          pollingIntervalMs: 100,
          confirmations: 1,
          startHttp: false,
        });

        try {
          const channel = await alice.client.open({
            counterparty: env.hub.address,
            amount: 100n * ONE_USDC,
          });
          const v1 = await alice.storage.loadLatestState(channel.id);
          if (v1) await wt.remember(v1);
          await env.hubServer.registerChannel(channel, v1 ?? undefined);

          await alice.client.payDirect(channel.id, { amount: 5n * ONE_USDC });
          const v2 = await alice.storage.loadLatestState(channel.id);
          if (v2) await wt.remember(v2);

          await alice.client.payDirect(channel.id, { amount: 3n * ONE_USDC });
          const v3 = await alice.storage.loadLatestState(channel.id);
          if (v3) await wt.remember(v3);

          const stale = v2;
          if (!stale) throw new Error('no stale state');

          const hubAttackerWallet = createWalletClient({
            account: privateKeyToAccount(env.hub.privateKey),
            chain: taiko,
            transport: http(env.rpcUrl),
          });
          const attackAbi = parseAbi([
            'function closeUnilateral(bytes32 channelId, bytes state, bytes sigCounterparty)',
          ]);
          const { encodeChannelStateForOnChain, signatureToHex } = await import(
            '@inferenceroom/pico-sdk'
          );
          await hubAttackerWallet.writeContract({
            address: env.paymentChannel,
            abi: attackAbi,
            functionName: 'closeUnilateral',
            args: [
              channel.id,
              encodeChannelStateForOnChain(stale.state),
              signatureToHex(stale.sigA),
            ],
          });

          const channelsAbi = parseAbi([
            // M3: refreshed to the v2 19-field Channel layout. The fork test
            // targets the live PaymentChannel proxy, which since v2 returns
            // the extended struct from `channels(bytes32)`. Keeping the old
            // 11-field layout silently read garbage off the right-hand fields.
            'function channels(bytes32) view returns (address userA, address userB, address token, uint256 amountA, uint256 amountB, uint64 openedAt, uint64 disputeDeadline, uint64 postedVersion, uint256 postedBalanceA, uint256 postedBalanceB, bool penalized, uint8 status, address closer, bytes32 postedHtlcsRoot, uint256 htlcsTotalLocked, uint16 htlcsCount, uint64 htlcResolutionDeadline, uint256 pendingPayoutA, uint256 pendingPayoutB)',
          ]);
          let posted = 0n;
          let penalized = false;
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            const row = (await env.publicClient.readContract({
              address: env.paymentChannel,
              abi: channelsAbi,
              functionName: 'channels',
              args: [channel.id],
            })) as readonly [
              `0x${string}`, // userA
              `0x${string}`, // userB
              `0x${string}`, // token
              bigint, // amountA
              bigint, // amountB
              bigint, // openedAt
              bigint, // disputeDeadline
              bigint, // postedVersion
              bigint, // postedBalanceA
              bigint, // postedBalanceB
              boolean, // penalized
              number, // status
              `0x${string}`, // closer
              `0x${string}`, // postedHtlcsRoot
              bigint, // htlcsTotalLocked
              number, // htlcsCount
              bigint, // htlcResolutionDeadline
              bigint, // pendingPayoutA
              bigint, // pendingPayoutB
            ];
            posted = row[7];
            penalized = row[10];
            if (posted === 3n && penalized) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          expect(posted).toBe(3n);
          expect(penalized).toBe(true);

          await timeWarp(env.rpcUrl, 24 * 60 * 60 + 1);

          const aliceWallet = createWalletClient({
            account: privateKeyToAccount(env.alice.privateKey),
            chain: taiko,
            transport: http(env.rpcUrl),
          });
          await aliceWallet.writeContract({
            address: env.paymentChannel,
            abi: parseAbi(['function finalize(bytes32 channelId)']),
            functionName: 'finalize',
            args: [channel.id],
          });

          const aliceUsdcAfter = await readUsdcBalance(
            env.publicClient,
            env.usdc,
            env.alice.address,
          );
          // 100% slash: hub forfeits its entire side of the channel to Alice.
          // Alice's net change = +100 USDC (the slash pot) - 100 USDC (her own
          // deposit, which she gets back) = 0. So her on-chain balance ends up
          // unchanged from before the channel open.
          expect(aliceUsdcAfter).toBe(aliceUsdcBefore);
        } finally {
          await wt.stop();
          await alice.transport.close();
        }
      } finally {
        await env.stop();
      }
    },
    240_000,
  );
});
