import {
  ChannelClient,
  MemoryStorage,
  ViemChainAdapter,
  WebSocketTransport,
  localSigner,
} from '@tainnel/sdk';
import { http, createWalletClient, erc20Abi, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type E2EHandle, bootE2E } from './harness.js';

const paymentChannelStatusAbi = parseAbi([
  'function channels(bytes32) view returns (address userA, address userB, address token, uint256 amountA, uint256 amountB, uint64 openedAt, uint64 disputeDeadline, uint64 postedVersion, uint256 postedBalanceA, uint256 postedBalanceB, bool penalized, uint8 status, address closer)',
]);

describe('e2e — alice→hub 2-party cooperative close', () => {
  let h: E2EHandle;

  beforeAll(async () => {
    h = await bootE2E();
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('opens, pays 5 USDC direct, closes cooperatively, on-chain balances match', async () => {
    const aliceAccount = privateKeyToAccount(h.alice.privateKey);
    const aliceWallet = createWalletClient({
      account: aliceAccount,
      chain: foundry,
      transport: http(h.rpcUrl),
    });

    const transport = new WebSocketTransport({ url: h.hubServer.url, autoReconnect: false });
    const aliceChain = new ViemChainAdapter({
      publicClient: h.publicClient,
      walletClient: aliceWallet,
      paymentChannelAddress: h.paymentChannel,
    });
    const alice = new ChannelClient({
      signer: localSigner(h.alice.privateKey),
      transport,
      storage: new MemoryStorage(),
      chain: aliceChain,
      chainId: h.chainId,
      verifyingContract: h.adjudicator,
      defaultToken: h.usdc,
      settleTimeoutMs: 10_000,
      closeRequestTimeoutMs: 10_000,
    });

    const ONE_USDC = 1_000_000n;
    const channel = await alice.open({
      counterparty: h.hub.address,
      amount: 100n * ONE_USDC,
      token: h.usdc,
    });

    h.hubServer.registerChannel(channel);

    const opened = await h.publicClient.readContract({
      address: h.paymentChannel,
      abi: paymentChannelStatusAbi,
      functionName: 'channels',
      args: [channel.id],
    });
    expect(opened[11]).toBe(1);

    const result = await alice.payDirect(channel.id, { amount: 5n * ONE_USDC });
    expect(result.version).toBe(2n);

    await alice.close(channel.id, { cooperative: true });

    const aliceUsdc = await h.publicClient.readContract({
      address: h.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [h.alice.address],
    });
    const hubUsdc = await h.publicClient.readContract({
      address: h.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [h.hub.address],
    });
    expect(aliceUsdc).toBe(95n * ONE_USDC);
    expect(hubUsdc).toBe(105n * ONE_USDC);

    const closed = await h.publicClient.readContract({
      address: h.paymentChannel,
      abi: paymentChannelStatusAbi,
      functionName: 'channels',
      args: [channel.id],
    });
    expect(closed[11]).toBe(3);

    await transport.close();
  });
});

describe.skip('e2e — full payment lifecycle (deferred)', () => {
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
