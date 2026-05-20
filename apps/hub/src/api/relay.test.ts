import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeHubMessage, encodeHubMessage } from '@inferenceroom/pico-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type BuildServerResult, buildServer } from '../server.js';

const ALICE_PK = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const BOB_PK = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CAROL_PK = '0x000000000000000000000000000000000000000000000000000000000000ca01' as const;
const HUB_PK = '0x00000000000000000000000000000000000000000000000000000000000000bb' as const;
const VERIFYING_CONTRACT = '0x0000000000000000000000000000000000000001' as const;

const ALICE = privateKeyToAccount(ALICE_PK).address;
const BOB = privateKeyToAccount(BOB_PK).address;
const CAROL = privateKeyToAccount(CAROL_PK).address;

function baseEnv(
  tmp: string,
  enableRelay: boolean,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
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
    ...(enableRelay ? { HUB_ENABLE_RELAY: 'true' } : {}),
    ...extra,
  } as NodeJS.ProcessEnv;
}

const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

async function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timed out')), 1_000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on('error', reject);
  });
  return ws;
}

function nextMsg(ws: WebSocket): Promise<ReturnType<typeof decodeHubMessage>> {
  return new Promise((resolve) => {
    ws.once('message', (raw: Buffer) => resolve(decodeHubMessage(raw.toString('utf8'))));
  });
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(encodeHubMessage(msg as Parameters<typeof encodeHubMessage>[0]));
}

async function subscribe(ws: WebSocket, address: string): Promise<void> {
  const ack = nextMsg(ws);
  send(ws, { id: `sub-${address}`, kind: 'subscribe', address, channelIds: [] });
  const m = await ack;
  expect(m.kind).toBe('subscribeAck');
}

// A minimal inner peer message the hub forwards verbatim.
function innerError(id: string): unknown {
  return { id, kind: 'error', code: 'PEER', message: 'hello-peer' };
}

describe('hub peer-channel relay', () => {
  let tmp: string;
  let built: BuildServerResult;
  let baseUrl: string;
  let wsUrl: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'hub-relay-'));
    built = await buildServer(baseEnv(tmp, true));
    baseUrl = await built.app.listen({ port: 0, host: '127.0.0.1' });
    wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;
  });

  afterEach(async () => {
    await built.app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('forwards a relayed message to a connected peer', async () => {
    const a = await openWs(wsUrl);
    const b = await openWs(wsUrl);
    await subscribe(a, ALICE);
    await subscribe(b, BOB);

    const bobNext = nextMsg(b);
    send(a, { id: 'r1', kind: 'relay', to: BOB, inner: innerError('inner-1') });
    const got = await bobNext;
    expect(got.kind).toBe('error');
    expect((got as { id: string }).id).toBe('inner-1');

    a.close();
    b.close();
  });

  it('queues for an offline peer and flushes on subscribe', async () => {
    const a = await openWs(wsUrl);
    await subscribe(a, ALICE);
    // Carol is not connected yet.
    send(a, { id: 'r2', kind: 'relay', to: CAROL, inner: innerError('inner-2') });
    // Give the hub a tick to enqueue.
    await new Promise((r) => setTimeout(r, 50));

    const carol = await openWs(wsUrl);
    const ackThenQueued: ReturnType<typeof decodeHubMessage>[] = [];
    const collected = new Promise<void>((resolve) => {
      let n = 0;
      carol.on('message', (raw: Buffer) => {
        ackThenQueued.push(decodeHubMessage(raw.toString('utf8')));
        if (++n === 2) resolve();
      });
    });
    send(carol, { id: 'sub-carol', kind: 'subscribe', address: CAROL, channelIds: [] });
    await collected;
    expect(ackThenQueued[0]?.kind).toBe('subscribeAck');
    expect(ackThenQueued[1]?.kind).toBe('error');
    expect((ackThenQueued[1] as { id: string }).id).toBe('inner-2');

    a.close();
    carol.close();
  });

  it('exposes relay data on /v1/info, /v1/stats and /v1/relay/sessions', async () => {
    const a = await openWs(wsUrl);
    await subscribe(a, ALICE);

    const info = (await (await fetch(`${baseUrl}/v1/info`)).json()) as {
      relay?: { enabled: boolean; maxQueuedPerPeer: number };
    };
    expect(info.relay?.enabled).toBe(true);
    expect(typeof info.relay?.maxQueuedPerPeer).toBe('number');

    const stats = (await (await fetch(`${baseUrl}/v1/stats`)).json()) as {
      relay?: { enabled: boolean; activeSessions: number };
    };
    expect(stats.relay?.enabled).toBe(true);
    expect(stats.relay?.activeSessions).toBeGreaterThanOrEqual(1);

    const sessions = (await (await fetch(`${baseUrl}/v1/relay/sessions`)).json()) as {
      enabled: boolean;
      sessions: { address: string; queued: number }[];
    };
    expect(sessions.enabled).toBe(true);
    expect(sessions.sessions.some((s) => s.address.toLowerCase() === ALICE.toLowerCase())).toBe(
      true,
    );

    a.close();
  });
});

describe('hub relay queue bounds', () => {
  let tmp: string;
  let built: BuildServerResult;
  let baseUrl: string;
  let wsUrl: string;

  afterEach(async () => {
    await built.app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('drops messages beyond the destination cap', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'hub-relaycap-'));
    built = await buildServer(baseEnv(tmp, true, { HUB_MAX_QUEUED_RELAY_DESTINATIONS: '2' }));
    baseUrl = await built.app.listen({ port: 0, host: '127.0.0.1' });
    wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;

    const a = await openWs(wsUrl);
    await subscribe(a, ALICE);
    // 3 distinct offline destinations, cap is 2 → at least one dropped.
    send(a, { id: 'q1', kind: 'relay', to: ADDR(1), inner: innerError('i1') });
    send(a, { id: 'q2', kind: 'relay', to: ADDR(2), inner: innerError('i2') });
    send(a, { id: 'q3', kind: 'relay', to: ADDR(3), inner: innerError('i3') });
    await new Promise((r) => setTimeout(r, 100));

    const stats = (await (await fetch(`${baseUrl}/v1/stats`)).json()) as {
      relay: { messagesQueued: number; messagesDropped: number };
    };
    expect(stats.relay.messagesQueued).toBe(2);
    expect(stats.relay.messagesDropped).toBeGreaterThanOrEqual(1);
    a.close();
  });

  it('caps the number of concurrent relay sessions', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'hub-relaysess-'));
    built = await buildServer(baseEnv(tmp, true, { HUB_MAX_RELAY_SESSIONS: '1' }));
    baseUrl = await built.app.listen({ port: 0, host: '127.0.0.1' });
    wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;

    const a = await openWs(wsUrl);
    await subscribe(a, ALICE);
    // Second distinct address exceeds the cap of 1 → rejected.
    const b = await openWs(wsUrl);
    const reply = nextMsg(b);
    send(b, { id: 'sub-bob', kind: 'subscribe', address: BOB, channelIds: [] });
    const got = await reply;
    expect(got.kind).toBe('error');
    expect((got as { code: string }).code).toBe('RELAY_BUSY');
    a.close();
    b.close();
  });

  it('evicts buffered messages past their TTL', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'hub-relayttl-'));
    built = await buildServer(baseEnv(tmp, true, { HUB_RELAY_QUEUE_TTL_MS: '40' }));
    baseUrl = await built.app.listen({ port: 0, host: '127.0.0.1' });
    wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;

    const a = await openWs(wsUrl);
    await subscribe(a, ALICE);
    send(a, { id: 'qt', kind: 'relay', to: CAROL, inner: innerError('i-ttl') });
    // Wait past the TTL, then connect Carol — the entry must have expired.
    await new Promise((r) => setTimeout(r, 120));

    const carol = await openWs(wsUrl);
    let received = 0;
    carol.on('message', (raw: Buffer) => {
      if (decodeHubMessage(raw.toString('utf8')).kind === 'error') received += 1;
    });
    send(carol, { id: 'sub-carol', kind: 'subscribe', address: CAROL, channelIds: [] });
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toBe(0); // expired entry was evicted, not delivered

    a.close();
    carol.close();
  });
});

describe('hub relay disabled', () => {
  let tmp: string;
  let built: BuildServerResult;
  let baseUrl: string;
  let wsUrl: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'hub-norelay-'));
    built = await buildServer(baseEnv(tmp, false));
    baseUrl = await built.app.listen({ port: 0, host: '127.0.0.1' });
    wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;
  });

  afterEach(async () => {
    await built.app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects relay messages with RELAY_DISABLED', async () => {
    const a = await openWs(wsUrl);
    await subscribe(a, ALICE);
    const reply = nextMsg(a);
    send(a, { id: 'r3', kind: 'relay', to: BOB, inner: innerError('inner-3') });
    const got = await reply;
    expect(got.kind).toBe('error');
    expect((got as { code: string }).code).toBe('RELAY_DISABLED');
    a.close();
  });

  it('/v1/info reports relay disabled', async () => {
    const info = (await (await fetch(`${baseUrl}/v1/info`)).json()) as {
      relay?: { enabled: boolean };
    };
    expect(info.relay?.enabled).toBe(false);
  });
});
