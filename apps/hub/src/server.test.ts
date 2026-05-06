import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Channel,
  ChannelState,
  CooperativeClose,
  Hex,
  PaymentHash,
  Signature,
  SignedState,
} from '@pico/protocol';
import {
  decodeHubMessage,
  encodeHubMessage,
  hexToSignature,
  randomHtlcId,
  signatureToHex,
} from '@pico/sdk';
import { buildChannelStateTypedData, buildCooperativeCloseTypedData } from '@pico/state-machine';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type BuildServerResult, buildServer } from './server.js';

const ALICE_PK = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const HUB_PK = '0x00000000000000000000000000000000000000000000000000000000000000bb' as const;
const VERIFYING_CONTRACT = '0x0000000000000000000000000000000000000001' as const;

const ZERO_SIG: Signature = { r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}`, v: 27 };

function bytes32(prefix: string): Hex {
  return `0x${prefix}${'0'.repeat(64 - prefix.length)}` as Hex;
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

async function aliceSign(state: ChannelState): Promise<Signature> {
  return signStateBy(ALICE_PK, state);
}

async function signStateBy(privateKey: `0x${string}`, state: ChannelState): Promise<Signature> {
  const account = privateKeyToAccount(privateKey);
  const sig = await account.signTypedData(
    buildChannelStateTypedData(state, 31337, VERIFYING_CONTRACT),
  );
  return hexToSignature(sig);
}

async function aliceSignClose(close: CooperativeClose): Promise<Signature> {
  const account = privateKeyToAccount(ALICE_PK);
  const sig = await account.signTypedData(
    buildCooperativeCloseTypedData(close, 31337, VERIFYING_CONTRACT),
  );
  return hexToSignature(sig);
}

async function buildAliceState(
  channel: Channel,
  balanceA: bigint,
  balanceB: bigint,
  version = 1n,
): Promise<SignedState> {
  const state: ChannelState = {
    channelId: channel.id,
    version,
    balanceA,
    balanceB,
    htlcs: [],
    finalized: false,
  };
  return { state, sigA: await aliceSign(state), sigB: ZERO_SIG };
}

async function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket open timed out for ${url}`)), 1_000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`unexpected websocket response ${res.statusCode}`));
    });
    ws.on('close', (code, reason) => {
      reject(new Error(`websocket closed before open ${code} ${reason.toString('utf8')}`));
    });
  });
  return ws;
}

function nextHubMessage(ws: WebSocket): Promise<ReturnType<typeof decodeHubMessage>> {
  return new Promise((resolve) => {
    ws.once('message', (raw: Buffer) => resolve(decodeHubMessage(raw.toString('utf8'))));
  });
}

describe('buildServer integration', () => {
  let tmp: string;
  let built: BuildServerResult;
  let baseUrl: string;
  let wsUrl: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'hub-srv-'));
    built = await buildServer({
      DB_DRIVER: 'sqlite',
      DB_URL: join(tmp, 'test.sqlite'),
      HUB_PRIVATE_KEY: HUB_PK,
      RPC_URL: 'http://127.0.0.1:1', // intentionally unreachable
      CHAIN_ID: '31337',
      PAYMENT_CHANNEL_ADDRESS: VERIFYING_CONTRACT,
      ADJUDICATOR_ADDRESS: VERIFYING_CONTRACT,
      HUB_FEE_BPS: '0',
      HUB_FEE_FLAT: '0',
      LOG_LEVEL: 'silent',
      CHAIN_POLLING_INTERVAL_MS: '999999',
      PICO_DEV_ALLOW_ZERO_ADDRESS: 'true',
      PICO_SKIP_PROD_ASSERT: 'true',
      PROMETHEUS_PORT: '0',
    } as NodeJS.ProcessEnv);
    baseUrl = await built.app.listen({ port: 0, host: '127.0.0.1' });
    wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;
  });

  afterEach(async () => {
    await built.app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports degraded health when chain is unreachable', async () => {
    const r = await fetch(`${baseUrl}/v1/health`);
    const json = (await r.json()) as { status: string; checks: Record<string, string> };
    expect(r.status).toBe(503);
    expect(json.status).toBe('degraded');
    expect(json.checks.db).toBe('ok');
    expect(json.checks.chain).not.toBe('ok');
  });

  it('exposes Prometheus metrics', async () => {
    const r = await fetch(`${baseUrl}/metrics`);
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).toMatch(/pico_hub_channels_total/);
    expect(text).toMatch(/pico_hub_payments_total/);
  });

  it('GET /v1/channels lists registered channels', async () => {
    const alice = privateKeyToAccount(ALICE_PK).address;
    const hub = privateKeyToAccount(HUB_PK).address;
    const ch = makeChannel(bytes32('aa'), alice, hub);
    const initial = await buildAliceState(ch, 100n, 0n);
    await built.api.ws.registerChannel(ch, initial);

    const r = await fetch(`${baseUrl}/v1/channels`);
    const json = (await r.json()) as { channels: { id: Hex; status: string }[] };
    expect(json.channels).toHaveLength(1);
    expect(json.channels[0]?.id).toBe(ch.id);
  });

  it('POST /v1/channels/open registers the channel', async () => {
    const alice = privateKeyToAccount(ALICE_PK).address;
    const hub = privateKeyToAccount(HUB_PK).address;
    const ch = makeChannel(bytes32('bb'), alice, hub);
    const r = await fetch(`${baseUrl}/v1/channels/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: { ...ch, openedAt: ch.openedAt.toString() },
      }),
    });
    const json = (await r.json()) as { channelId: Hex };
    expect(r.status).toBe(200);
    expect(json.channelId).toBe(ch.id);
    expect(built.channelPool.get(ch.id)?.id).toBe(ch.id);
  });

  it('POST /v1/payments returns 501 (use WebSocket)', async () => {
    const r = await fetch(`${baseUrl}/v1/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(501);
  });

  it('GET /v1/stats reports channel breakdown and lifetime counters', async () => {
    const alice = privateKeyToAccount(ALICE_PK).address;
    const hub = privateKeyToAccount(HUB_PK).address;
    const open = makeChannel(bytes32('a1'), alice, hub, 'open');
    const closed = makeChannel(bytes32('a2'), alice, hub, 'closed');
    await built.api.ws.registerChannel(open, await buildAliceState(open, 100n, 0n));
    await built.api.ws.registerChannel(closed, await buildAliceState(closed, 100n, 0n));

    await built.repos.stats.addBigint('payments_settled', 3n);
    await built.repos.stats.addBigint('payments_failed', 1n);
    await built.repos.stats.addBigint('usdc_settled', 1_234_567n);
    await built.repos.stats.addBigint('fees_collected', 89n);

    const r = await fetch(`${baseUrl}/v1/stats`);
    const json = (await r.json()) as {
      version: number;
      channels: {
        total: number;
        open: number;
        byStatus: Record<string, number>;
      };
      payments: { total: number; settled: number; failed: number; inFlightHtlcs: number };
      usdc: { settled: string; feesCollected: string };
      disputes: { total: number };
    };
    expect(r.status).toBe(200);
    expect(json.version).toBe(1);
    expect(json.channels.total).toBe(2);
    expect(json.channels.open).toBe(1);
    expect(json.channels.byStatus.open).toBe(1);
    expect(json.channels.byStatus.closed).toBe(1);
    expect(json.payments).toEqual({ total: 4, settled: 3, failed: 1, inFlightHtlcs: 0 });
    expect(json.usdc).toEqual({ settled: '1234567', feesCollected: '89' });
    expect(json.disputes.total).toBe(0);
  });

  it('GET /v1/stats returns zero counters in initial state', async () => {
    const r = await fetch(`${baseUrl}/v1/stats`);
    const json = (await r.json()) as {
      version: number;
      channels: { total: number; open: number; byStatus: Record<string, number> };
      payments: { total: number; settled: number; failed: number; inFlightHtlcs: number };
      usdc: { settled: string; feesCollected: string };
      disputes: { total: number };
    };
    expect(r.status).toBe(200);
    expect(json).toEqual({
      version: 1,
      channels: {
        total: 0,
        open: 0,
        byStatus: {
          pending: 0,
          open: 0,
          'closing-cooperative': 0,
          'closing-unilateral': 0,
          disputed: 0,
          closed: 0,
        },
      },
      payments: { total: 0, settled: 0, failed: 0, inFlightHtlcs: 0 },
      usdc: { settled: '0', feesCollected: '0' },
      disputes: { total: 0 },
    });
  });

  it('GET /v1/stats serializes USDC sums as decimal strings', async () => {
    await built.repos.stats.addBigint('usdc_settled', 42n);
    await built.repos.stats.addBigint('fees_collected', 1n);
    const r = await fetch(`${baseUrl}/v1/stats`);
    const json = (await r.json()) as { usdc: { settled: unknown; feesCollected: unknown } };
    expect(typeof json.usdc.settled).toBe('string');
    expect(typeof json.usdc.feesCollected).toBe('string');
    expect(json.usdc.settled).toBe('42');
    expect(json.usdc.feesCollected).toBe('1');
  });

  it('GET /v1/stats reflects in-flight HTLCs and observed disputes', async () => {
    const alice = privateKeyToAccount(ALICE_PK).address;
    const hub = privateKeyToAccount(HUB_PK).address;
    const ch = makeChannel(bytes32('e1'), alice, hub);
    await built.api.ws.registerChannel(ch, await buildAliceState(ch, 100n, 0n));

    await built.repos.htlcs.save({
      htlc: {
        id: bytes32('aa') as Hex,
        direction: 'AtoB',
        amount: 10n,
        paymentHash: bytes32('bb') as PaymentHash,
        expiryMs: BigInt(Date.now() + 60_000),
      },
      channelId: ch.id,
      state: 'inflight',
    });
    await built.repos.disputes.record(ch.id, 5n, Date.now());

    const r = await fetch(`${baseUrl}/v1/stats`);
    const json = (await r.json()) as {
      payments: { inFlightHtlcs: number };
      disputes: { total: number };
    };
    expect(json.payments.inFlightHtlcs).toBe(1);
    expect(json.disputes.total).toBe(1);
  });

  it('GET /v1/stats lifetime counters are not reset by payment row pruning', async () => {
    const alice = privateKeyToAccount(ALICE_PK).address;
    const hub = privateKeyToAccount(HUB_PK).address;
    const ch = makeChannel(bytes32('e2'), alice, hub);
    await built.api.ws.registerChannel(ch, await buildAliceState(ch, 100n, 0n));

    // Simulate three settled payments contributing to lifetime counters; the
    // payment rows themselves are then pruned out of the payments table.
    for (let i = 0; i < 3; i++) {
      await built.repos.payments.create({
        id: `pay-${i}`,
        paymentHash: bytes32(`c${i}`) as PaymentHash,
        incomingChannelId: ch.id,
        outgoingChannelId: ch.id,
        recipient: alice,
        amount: 100n,
        fee: 1n,
        status: 'settled',
      });
      await built.repos.stats.addBigint('payments_settled', 1n);
      await built.repos.stats.addBigint('usdc_settled', 100n);
      await built.repos.stats.addBigint('fees_collected', 1n);
    }

    const removed = await built.repos.payments.prunePerChannel(1);
    expect(removed).toBeGreaterThan(0);

    const r = await fetch(`${baseUrl}/v1/stats`);
    const json = (await r.json()) as {
      payments: { settled: number; total: number };
      usdc: { settled: string; feesCollected: string };
    };
    expect(json.payments.settled).toBe(3);
    expect(json.payments.total).toBe(3);
    expect(json.usdc.settled).toBe('300');
    expect(json.usdc.feesCollected).toBe('3');
  });

  it('GET /v1/stats counters survive a restart', async () => {
    await built.repos.stats.addBigint('payments_settled', 7n);
    await built.repos.stats.addBigint('usdc_settled', 9_999_999_999_999_999n); // > MAX_SAFE_INTEGER

    await built.app.close();
    built = await buildServer({
      DB_DRIVER: 'sqlite',
      DB_URL: join(tmp, 'test.sqlite'),
      HUB_PRIVATE_KEY: HUB_PK,
      RPC_URL: 'http://127.0.0.1:1',
      CHAIN_ID: '31337',
      PAYMENT_CHANNEL_ADDRESS: VERIFYING_CONTRACT,
      ADJUDICATOR_ADDRESS: VERIFYING_CONTRACT,
      HUB_FEE_BPS: '0',
      HUB_FEE_FLAT: '0',
      LOG_LEVEL: 'silent',
      CHAIN_POLLING_INTERVAL_MS: '999999',
      PICO_DEV_ALLOW_ZERO_ADDRESS: 'true',
      PICO_SKIP_PROD_ASSERT: 'true',
      PROMETHEUS_PORT: '0',
    } as NodeJS.ProcessEnv);
    baseUrl = await built.app.listen({ port: 0, host: '127.0.0.1' });

    const r = await fetch(`${baseUrl}/v1/stats`);
    const json = (await r.json()) as {
      payments: { settled: number };
      usdc: { settled: string };
    };
    expect(json.payments.settled).toBe(7);
    expect(json.usdc.settled).toBe('9999999999999999');
  });

  it('WebSocket payDirect: round-trip sign + persist', async () => {
    const alice = privateKeyToAccount(ALICE_PK);
    const hub = privateKeyToAccount(HUB_PK).address;
    const ch = makeChannel(bytes32('cc'), alice.address, hub);
    const initial = await buildAliceState(ch, 100n, 0n);
    await built.api.ws.registerChannel(ch, initial);

    const next: ChannelState = {
      ...initial.state,
      version: 2n,
      balanceA: 95n,
      balanceB: 5n,
    };
    const aliceSig = await aliceSign(next);
    const signed: SignedState = { state: next, sigA: aliceSig, sigB: ZERO_SIG };

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    const reply = new Promise<string>((resolve) => {
      ws.on('message', (raw: Buffer) => resolve(raw.toString('utf8')));
    });
    ws.send(
      encodeHubMessage({
        id: 'req-1',
        kind: 'payDirect',
        channelId: ch.id,
        signedState: signed,
      }),
    );
    const responseRaw = await reply;
    ws.close();

    expect(responseRaw).toMatch(/payDirectAck/);
    const stored = await built.repos.states.latest(ch.id);
    expect(stored?.state.version).toBe(2n);
    expect(stored?.state.balanceA).toBe(95n);

    const sigHex = signatureToHex(stored?.sigB ?? ZERO_SIG);
    expect(sigHex).not.toBe(signatureToHex(ZERO_SIG));
  });

  it('WebSocket closeRequest rejects a final balance split that differs from latest state', async () => {
    const alice = privateKeyToAccount(ALICE_PK);
    const hub = privateKeyToAccount(HUB_PK).address;
    const ch = makeChannel(bytes32('cd'), alice.address, hub);
    const initial = await buildAliceState(ch, 100n, 0n);
    await built.api.ws.registerChannel(ch, initial);

    const forgedFinal: ChannelState = {
      ...initial.state,
      version: initial.state.version + 1n,
      balanceA: 0n,
      balanceB: 100n,
      finalized: true,
    };
    const forgedClose: CooperativeClose = {
      channelId: ch.id,
      finalBalanceA: forgedFinal.balanceA,
      finalBalanceB: forgedFinal.balanceB,
      signedAt: 1n,
    };
    const aliceStateSig = await aliceSign(forgedFinal);
    const aliceCloseSig = await aliceSignClose(forgedClose);

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    const reply = new Promise<string>((resolve) => {
      ws.on('message', (raw: Buffer) => resolve(raw.toString('utf8')));
    });
    ws.send(
      encodeHubMessage({
        id: 'close-forged',
        kind: 'closeRequest',
        channelId: ch.id,
        signedState: { state: forgedFinal, sigA: aliceStateSig, sigB: ZERO_SIG },
        signedCooperativeClose: { close: forgedClose, sigA: aliceCloseSig, sigB: ZERO_SIG },
      }),
    );
    const response = decodeHubMessage(await reply);
    ws.close();

    expect(response.kind).toBe('error');
    if (response.kind === 'error') expect(response.code).toBe('INVALID_CLOSE');
  });

  it('WebSocket pay against unknown channel sends an error', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const reply = new Promise<string>((resolve) => {
      ws.on('message', (raw: Buffer) => resolve(raw.toString('utf8')));
    });
    ws.send(
      encodeHubMessage({
        id: 'req-x',
        kind: 'pay',
        channelId: bytes32('ff'),
        signedState: {
          state: {
            channelId: bytes32('ff'),
            version: 1n,
            balanceA: 0n,
            balanceB: 0n,
            htlcs: [],
            finalized: false,
          },
          sigA: ZERO_SIG,
          sigB: ZERO_SIG,
        },
        htlc: {
          id: randomHtlcId(),
          direction: 'AtoB',
          amount: 1n,
          paymentHash: bytes32('99') as PaymentHash,
          expiryMs: 0n,
        },
        paymentHash: bytes32('99') as PaymentHash,
        recipient: '0x00000000000000000000000000000000000000FF',
        amount: 1n,
      }),
    );
    const responseRaw = await reply;
    ws.close();
    expect(responseRaw).toMatch(/UNKNOWN_CHANNEL/);
  });
});

describe('buildServer operator-token gate', () => {
  const TOKEN = 'test-operator-secret';
  let tmp: string;
  let built: BuildServerResult;
  let baseUrl: string;
  let prevToken: string | undefined;

  beforeEach(async () => {
    prevToken = process.env.HUB_OPERATOR_TOKEN;
    process.env.HUB_OPERATOR_TOKEN = TOKEN;
    tmp = mkdtempSync(join(tmpdir(), 'hub-srv-auth-'));
    built = await buildServer({
      DB_DRIVER: 'sqlite',
      DB_URL: join(tmp, 'test.sqlite'),
      HUB_PRIVATE_KEY: HUB_PK,
      RPC_URL: 'http://127.0.0.1:1',
      CHAIN_ID: '31337',
      PAYMENT_CHANNEL_ADDRESS: VERIFYING_CONTRACT,
      ADJUDICATOR_ADDRESS: VERIFYING_CONTRACT,
      HUB_FEE_BPS: '0',
      HUB_FEE_FLAT: '0',
      LOG_LEVEL: 'silent',
      CHAIN_POLLING_INTERVAL_MS: '999999',
      HUB_OPERATOR_TOKEN: TOKEN,
      PICO_DEV_ALLOW_ZERO_ADDRESS: 'true',
      PICO_SKIP_PROD_ASSERT: 'true',
      PROMETHEUS_PORT: '0',
    } as NodeJS.ProcessEnv);
    baseUrl = await built.app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await built.app.close();
    rmSync(tmp, { recursive: true, force: true });
    if (prevToken === undefined) process.env.HUB_OPERATOR_TOKEN = undefined;
    else process.env.HUB_OPERATOR_TOKEN = prevToken;
  });

  it('rejects POST /v1/channels/open without a bearer token', async () => {
    const alice = privateKeyToAccount(ALICE_PK).address;
    const hub = privateKeyToAccount(HUB_PK).address;
    const ch = makeChannel(bytes32('cc'), alice, hub);
    const r = await fetch(`${baseUrl}/v1/channels/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: { ...ch, openedAt: ch.openedAt.toString() } }),
    });
    expect(r.status).toBe(401);
    expect(built.channelPool.get(ch.id)).toBeUndefined();
  });

  it('accepts POST /v1/channels/open with a valid bearer token', async () => {
    const alice = privateKeyToAccount(ALICE_PK).address;
    const hub = privateKeyToAccount(HUB_PK).address;
    const ch = makeChannel(bytes32('dd'), alice, hub);
    const r = await fetch(`${baseUrl}/v1/channels/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ channel: { ...ch, openedAt: ch.openedAt.toString() } }),
    });
    expect(r.status).toBe(200);
    expect(built.channelPool.get(ch.id)?.id).toBe(ch.id);
  });
});
