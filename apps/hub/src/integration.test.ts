import type { Address, Channel, ChannelId, Hex } from '@tainnel/protocol';
import { TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';
import { CHANNEL_STATE_TYPES, COOPERATIVE_CLOSE_TYPES, buildDomain } from '@tainnel/protocol';
import { sha256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BuildServerResult, buildServer } from './server.js';

// TODO P10: replace with real anvil run + deployed contracts when launch infra is ready.

const operatorToken = 'integration-token';
const userAKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd11' as Hex;
const userBKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd22' as Hex;
const hubKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd33' as Hex;

const userAAccount = privateKeyToAccount(userAKey);
const userBAccount = privateKeyToAccount(userBKey);

const verifyingContract = '0x07B32f52523Fdf0780821595422DccEF31FA2335' as Address;

let built: BuildServerResult;
let port: number;

import { WebSocketTransport } from '@tainnel/sdk';

interface WireMessage {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}

async function openWs(url: string): Promise<{
  send: (msg: WireMessage) => Promise<void>;
  recv: () => Promise<WireMessage>;
  close: () => Promise<void>;
}> {
  const transport = new WebSocketTransport({ url });
  const queue: WireMessage[] = [];
  const waiters: Array<(m: WireMessage) => void> = [];
  transport.onMessage((m) => {
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  await transport.connect();
  return {
    send: (msg: WireMessage) => transport.send(msg),
    recv: () =>
      new Promise<WireMessage>((res) => {
        const next = queue.shift();
        if (next) res(next);
        else waiters.push(res);
      }),
    close: () => transport.close(),
  };
}

describe('hub integration', () => {
  beforeEach(async () => {
    built = await buildServer({
      env: {
        DB_DRIVER: 'sqlite',
        DB_URL: ':memory:',
        PORT: '0',
        LOG_LEVEL: 'silent',
        HUB_PRIVATE_KEY: hubKey,
        HUB_OPERATOR_TOKEN: operatorToken,
        CHAIN_ID: '167000',
        PAYMENT_CHANNEL_ADDRESS: verifyingContract,
        RPC_URL: 'http://nope',
      },
      disableChainWatcher: true,
    });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = built.app.server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await built.app.close();
  });

  it('answers subscribe with subscribe.ack', async () => {
    const ws = await openWs(`ws://127.0.0.1:${port}/v1/ws`);
    ws.send({
      id: 's1',
      kind: 'subscribe',
      payload: {
        channelId: `0x${'aa'.repeat(32)}`,
      },
    });
    const reply = await ws.recv();
    expect(reply.kind).toBe('subscribe.ack');
    expect((reply.payload as { ok?: boolean }).ok).toBe(true);
    await ws.close();
  });

  it('handles a pay round trip with a registered preimage', async () => {
    const channelId = `0x${'cc'.repeat(32)}` as ChannelId;
    const preimage = `0x${'11'.repeat(32)}` as Hex;
    const paymentHash = sha256(preimage) as Hex;
    const channel: Channel = {
      id: channelId,
      chainId: TAIKO_MAINNET_CHAIN_ID,
      contract: verifyingContract,
      userA: userAAccount.address,
      userB: userBAccount.address,
      token: '0x3333333333333333333333333333333333333333' as Channel['token'],
      status: 'open',
      openedAt: 100n,
      disputeWindowMs: 24 * 60 * 60 * 1000,
    };
    built.channelPool.register(channel);
    built.preimages.register(paymentHash, preimage);

    const stateMessage = {
      channelId,
      version: 1n,
      balanceA: 100n,
      balanceB: 200n,
      htlcsRoot: `0x${'00'.repeat(32)}` as Hex,
      finalized: false,
    };
    const sigA = await userAAccount.signTypedData({
      domain: buildDomain(TAIKO_MAINNET_CHAIN_ID, verifyingContract),
      types: CHANNEL_STATE_TYPES,
      primaryType: 'ChannelState',
      message: stateMessage,
    });
    const sigB = await userBAccount.signTypedData({
      domain: buildDomain(TAIKO_MAINNET_CHAIN_ID, verifyingContract),
      types: CHANNEL_STATE_TYPES,
      primaryType: 'ChannelState',
      message: stateMessage,
    });

    const ws = await openWs(`ws://127.0.0.1:${port}/v1/ws`);
    ws.send({
      id: 'pay-1',
      kind: 'pay',
      payload: {
        channelId,
        to: userBAccount.address,
        amount: '50',
        htlc: {
          id: `0x${'dd'.repeat(32)}`,
          direction: 'AtoB',
          amount: '50',
          paymentHash,
          expiryMs: '999999999',
        },
        state: {
          state: {
            channelId,
            version: '1',
            balanceA: '100',
            balanceB: '200',
            htlcs: [],
            finalized: false,
          },
          sigA,
          sigB,
        },
      },
    });
    const reply = await ws.recv();
    expect(reply.kind).toBe('payment.settle');
    expect((reply.payload as { preimage: Hex }).preimage.toLowerCase()).toBe(
      preimage.toLowerCase(),
    );
    await ws.close();
  });

  it('handles a close.request round trip', async () => {
    const channelId = `0x${'ee'.repeat(32)}` as ChannelId;
    const channel: Channel = {
      id: channelId,
      chainId: TAIKO_MAINNET_CHAIN_ID,
      contract: verifyingContract,
      userA: userAAccount.address,
      userB: userBAccount.address,
      token: '0x3333333333333333333333333333333333333333' as Channel['token'],
      status: 'open',
      openedAt: 100n,
      disputeWindowMs: 24 * 60 * 60 * 1000,
    };
    built.channelPool.register(channel);
    const close = {
      channelId,
      finalBalanceA: 60n,
      finalBalanceB: 40n,
      signedAt: BigInt(Math.floor(Date.now() / 1000)),
    };
    const sigClient = await userAAccount.signTypedData({
      domain: buildDomain(TAIKO_MAINNET_CHAIN_ID, verifyingContract),
      types: COOPERATIVE_CLOSE_TYPES,
      primaryType: 'CooperativeClose',
      message: close,
    });
    const ws = await openWs(`ws://127.0.0.1:${port}/v1/ws`);
    ws.send({
      id: 'cls-1',
      kind: 'close.request',
      payload: {
        channelId,
        close: {
          channelId,
          finalBalanceA: close.finalBalanceA.toString(),
          finalBalanceB: close.finalBalanceB.toString(),
          signedAt: close.signedAt.toString(),
        },
        sig: sigClient,
      },
    });
    const reply = await ws.recv();
    expect(reply.kind).toBe('close.counter');
    const payload = reply.payload as { sig: Hex; finalBalanceA: string };
    expect(payload.sig.startsWith('0x')).toBe(true);
    expect(payload.finalBalanceA).toBe('60');
    await ws.close();
  });

  it('GET /health returns ok', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('GET /v1/channels requires bearer auth', async () => {
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/channels`);
    expect(noAuth.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/channels`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(ok.status).toBe(200);
  });

  it('POST /v1/preimages registers a preimage', async () => {
    const paymentHash = `0x${'fa'.repeat(32)}` as Hex;
    const preimage = `0x${'fb'.repeat(32)}` as Hex;
    const res = await fetch(`http://127.0.0.1:${port}/v1/preimages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${operatorToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ paymentHash, preimage }),
    });
    expect(res.status).toBe(200);
    expect(built.preimages.has(paymentHash)).toBe(true);
  });
});
