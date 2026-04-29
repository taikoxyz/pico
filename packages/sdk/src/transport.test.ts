import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AddressInfo, WebSocketServer } from 'ws';
import { encodeHubMessage } from './hub-protocol.js';
import { WebSocketTransport } from './transport.js';

interface Harness {
  readonly server: WebSocketServer;
  readonly url: string;
  stop(): Promise<void>;
}

async function startEcho(
  opts: {
    onMessage?: (raw: string) => string | undefined;
  } = {},
): Promise<Harness> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  server.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const reply = opts.onMessage?.(raw.toString('utf8'));
      if (reply !== undefined) ws.send(reply);
    });
  });
  return {
    server,
    url: `ws://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('WebSocketTransport', () => {
  let harness: Harness;
  let transport: WebSocketTransport | undefined;

  afterEach(async () => {
    await transport?.close();
    transport = undefined;
    await harness?.stop();
  });

  it('connects, sends, and receives a message', async () => {
    harness = await startEcho({
      onMessage: (raw) => {
        const parsed = JSON.parse(raw);
        return encodeHubMessage({
          id: parsed.id,
          kind: 'subscribeAck',
          sessionId: 's',
          channels: [],
          pendingHtlcs: [],
        });
      },
    });
    transport = new WebSocketTransport({ url: harness.url, autoReconnect: false });
    await transport.connect();
    expect(transport.isConnected()).toBe(true);

    const reply = await transport.request({
      id: 'req-1',
      kind: 'subscribe',
      address: '0x00000000000000000000000000000000000000a1',
      channelIds: [],
    });
    expect(reply.kind).toBe('subscribeAck');
  });

  it('dispatches inbound messages to onMessage handlers', async () => {
    let serverWs: import('ws').WebSocket | undefined;
    harness = await startEcho({});
    harness.server.on('connection', (ws) => {
      serverWs = ws;
    });
    transport = new WebSocketTransport({ url: harness.url, autoReconnect: false });
    await transport.connect();
    const seen: string[] = [];
    transport.onMessage((m) => seen.push(m.kind));
    while (!serverWs) await new Promise((r) => setTimeout(r, 10));
    serverWs.send(
      encodeHubMessage({
        id: 'evt-1',
        kind: 'paymentSettle',
        channelId: '0x0000000000000000000000000000000000000000000000000000000000000001',
        htlcId: '0x0000000000000000000000000000000000000000000000000000000000000abc',
        preimage: '0xdead',
        signedStateAfterSettle: {
          state: {
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000001',
            version: 2n,
            balanceA: 100n,
            balanceB: 50n,
            htlcs: [],
            finalized: false,
          },
          sigA: { r: '0x0', s: '0x0', v: 27 },
          sigB: { r: '0x0', s: '0x0', v: 27 },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['paymentSettle']);
  });

  it('rejects send when closed', async () => {
    harness = await startEcho({});
    transport = new WebSocketTransport({ url: harness.url, autoReconnect: false });
    await transport.connect();
    await transport.close();
    await expect(
      transport.send({
        id: 'x',
        kind: 'subscribe',
        address: '0x00000000000000000000000000000000000000a1',
        channelIds: [],
      }),
    ).rejects.toThrow(/closed/);
  });

  it('reconnects when the server drops the connection', async () => {
    harness = await startEcho({});
    transport = new WebSocketTransport({
      url: harness.url,
      autoReconnect: true,
      minBackoffMs: 10,
      maxBackoffMs: 50,
    });
    let reconnectCount = 0;
    transport.onReconnect(() => {
      reconnectCount += 1;
    });
    await transport.connect();
    for (const ws of harness.server.clients) ws.terminate();
    await new Promise((r) => setTimeout(r, 300));
    expect(reconnectCount).toBeGreaterThanOrEqual(1);
    expect(transport.isConnected()).toBe(true);
  });

  it('request times out when the server never replies', async () => {
    harness = await startEcho({});
    transport = new WebSocketTransport({ url: harness.url, autoReconnect: false });
    await transport.connect();
    await expect(
      transport.request(
        {
          id: 'no-reply',
          kind: 'subscribe',
          address: '0x00000000000000000000000000000000000000a1',
          channelIds: [],
        },
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow(/timed out/);
  });

  it('multiple onMessage handlers all fire', async () => {
    let serverWs: import('ws').WebSocket | undefined;
    harness = await startEcho({});
    harness.server.on('connection', (ws) => {
      serverWs = ws;
    });
    transport = new WebSocketTransport({ url: harness.url, autoReconnect: false });
    await transport.connect();
    const seen: number[] = [];
    transport.onMessage(() => seen.push(1));
    transport.onMessage(() => seen.push(2));
    while (!serverWs) await new Promise((r) => setTimeout(r, 10));
    serverWs.send(
      encodeHubMessage({
        id: 'e',
        kind: 'error',
        code: 'TEST',
        message: 'hi',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.sort()).toEqual([1, 2]);
  });
});
