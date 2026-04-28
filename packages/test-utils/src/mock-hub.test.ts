import { sha256 } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_KEYS } from './keys.js';
import { startMockHub } from './mock-hub.js';

interface PingResponse {
  id: string;
  kind: string;
  payload: unknown;
}

describe('startMockHub — real WebSocket', () => {
  let hub: Awaited<ReturnType<typeof startMockHub>>;

  beforeEach(async () => {
    hub = await startMockHub({
      hubPrivateKey: TEST_KEYS.hub.privateKey,
      chainId: 167009,
      verifyingContract: '0x1111111111111111111111111111111111111111',
    });
  });

  afterEach(async () => {
    await hub.stop();
  });

  it('binds on a free port and exposes a url', () => {
    expect(hub.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
  });

  it('responds to subscribe with subscribe.ack', async () => {
    const wsMod = await import('ws');
    const Ctor = (wsMod as unknown as { default: { new (url: string): unknown } }).default;
    const sock = new Ctor(hub.url) as {
      on(ev: 'open' | 'message' | 'error', cb: (data?: unknown) => void): void;
      send(data: string): void;
      close(): void;
    };
    await new Promise<void>((resolve, reject) => {
      sock.on('open', () => resolve());
      sock.on('error', (err) => reject(err as Error));
    });

    const reply = await new Promise<PingResponse>((resolve) => {
      sock.on('message', (data) => {
        resolve(JSON.parse(String(data)) as PingResponse);
      });
      sock.send(
        JSON.stringify({ id: 'sub-1', kind: 'subscribe', payload: { channelId: '0xabc' } }),
      );
    });
    sock.close();
    expect(reply.id).toBe('sub-1');
    expect(reply.kind).toBe('subscribe.ack');
  });

  it('settles a registered payment via real WebSocket round-trip', async () => {
    const preimage = `0x${'aa'.repeat(32)}` as `0x${string}`;
    const paymentHash = sha256(preimage) as `0x${string}`;
    hub.hub.registerPreimage(preimage, paymentHash);

    const wsMod = await import('ws');
    const Ctor = (wsMod as unknown as { default: { new (url: string): unknown } }).default;
    const sock = new Ctor(hub.url) as {
      on(ev: 'open' | 'message' | 'error', cb: (data?: unknown) => void): void;
      send(data: string): void;
      close(): void;
    };
    await new Promise<void>((resolve, reject) => {
      sock.on('open', () => resolve());
      sock.on('error', (err) => reject(err as Error));
    });

    const reply = await new Promise<PingResponse>((resolve) => {
      sock.on('message', (data) => resolve(JSON.parse(String(data)) as PingResponse));
      sock.send(
        JSON.stringify({
          id: 'pay-1',
          kind: 'pay',
          payload: {
            channelId: '0xabc',
            htlc: { paymentHash, amount: '100' },
          },
        }),
      );
    });
    sock.close();
    expect(reply.kind).toBe('payment.settle');
    expect((reply.payload as { preimage: string }).preimage.toLowerCase()).toBe(
      preimage.toLowerCase(),
    );
  });
});
