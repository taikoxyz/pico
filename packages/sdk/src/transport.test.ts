import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportClosedError, TransportError, TransportTimeoutError } from './errors.js';
import {
  NostrRelayTransport,
  type Transport,
  type TransportMessage,
  WebSocketTransport,
  createInMemoryPipe,
  newRequestId,
  requestReply,
} from './transport.js';

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  static instances: FakeWebSocket[] = [];

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('not open');
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.(undefined));
  }

  // test helpers
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(undefined);
  }

  receive(msg: TransportMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  errorOut(message: string): void {
    this.onerror?.(new Error(message));
  }
}

describe('newRequestId', () => {
  it('returns a non-empty string', () => {
    const id = newRequestId();
    expect(id.length).toBeGreaterThan(8);
  });

  it('returns unique values across calls', () => {
    const ids = new Set([newRequestId(), newRequestId(), newRequestId()]);
    expect(ids.size).toBe(3);
  });
});

describe('createInMemoryPipe', () => {
  it('delivers messages from client to server', async () => {
    const pipe = createInMemoryPipe();
    const received: TransportMessage[] = [];
    pipe.server.onMessage((m) => received.push(m));
    await pipe.client.send({ id: '1', kind: 'hello', payload: 42 });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual([{ id: '1', kind: 'hello', payload: 42 }]);
  });

  it('delivers messages from server to client', async () => {
    const pipe = createInMemoryPipe();
    const received: TransportMessage[] = [];
    pipe.client.onMessage((m) => received.push(m));
    await pipe.server.send({ id: '2', kind: 'reply', payload: 'ok' });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1);
  });

  it('throws when sending after close', async () => {
    const pipe = createInMemoryPipe();
    await pipe.client.close();
    await expect(pipe.client.send({ id: '3', kind: 'x', payload: null })).rejects.toBeInstanceOf(
      TransportClosedError,
    );
  });

  it('throws when peer is closed', async () => {
    const pipe = createInMemoryPipe();
    await pipe.server.close();
    await expect(pipe.client.send({ id: '3', kind: 'x', payload: null })).rejects.toBeInstanceOf(
      TransportClosedError,
    );
  });

  it('unsubscribes on dispose', async () => {
    const pipe = createInMemoryPipe();
    const seen: TransportMessage[] = [];
    const dispose = pipe.server.onMessage((m) => seen.push(m));
    await pipe.client.send({ id: '1', kind: 'a', payload: null });
    await new Promise((r) => setTimeout(r, 0));
    dispose();
    await pipe.client.send({ id: '2', kind: 'b', payload: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.map((m) => m.id)).toEqual(['1']);
  });
});

describe('requestReply', () => {
  function makePipe(): { transport: Transport; peer: Transport } {
    const pipe = createInMemoryPipe();
    return { transport: pipe.client, peer: pipe.server };
  }

  it('resolves when a matching id arrives', async () => {
    const { transport, peer } = makePipe();
    peer.onMessage((req) => {
      void peer.send({ id: req.id, kind: `${req.kind}.ack`, payload: { ok: true } });
    });
    const result = await requestReply<{ ok: boolean }>(transport, {
      id: 'req-1',
      kind: 'subscribe',
      payload: null,
    });
    expect(result.payload.ok).toBe(true);
    expect(result.id).toBe('req-1');
  });

  it('ignores messages with non-matching ids', async () => {
    const { transport, peer } = makePipe();
    peer.onMessage((req) => {
      void peer.send({ id: 'noise', kind: 'noise', payload: 0 });
      setTimeout(() => {
        void peer.send({ id: req.id, kind: 'reply', payload: 'late' });
      }, 5);
    });
    const result = await requestReply(transport, { id: 'req-1', kind: 'q', payload: null });
    expect(result.payload).toBe('late');
  });

  it('filters by replyKind when provided', async () => {
    const { transport, peer } = makePipe();
    peer.onMessage((req) => {
      void peer.send({ id: req.id, kind: 'reject', payload: 'no' });
      setTimeout(() => {
        void peer.send({ id: req.id, kind: 'accept', payload: 'yes' });
      }, 5);
    });
    const result = await requestReply(
      transport,
      { id: 'req-1', kind: 'q', payload: null },
      {
        replyKind: 'accept',
      },
    );
    expect(result.payload).toBe('yes');
  });

  it('rejects with TransportTimeoutError when no reply arrives', async () => {
    const { transport } = makePipe();
    const p = requestReply(transport, { id: 'req-x', kind: 'q', payload: null }, { timeoutMs: 20 });
    await expect(p).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it('propagates send errors', async () => {
    const transport: Transport = {
      connect: async () => {},
      close: async () => {},
      send: async () => {
        throw new TransportError('nope');
      },
      onMessage: () => () => {},
    };
    await expect(
      requestReply(transport, { id: 'req-1', kind: 'q', payload: null }, { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(TransportError);
  });
});

describe('WebSocketTransport', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects, sends queued messages, and dispatches replies', async () => {
    const t = new WebSocketTransport({
      url: 'ws://test',
      webSocket: FakeWebSocket as unknown as never,
    });
    const seen: TransportMessage[] = [];
    t.onMessage((m) => seen.push(m));

    const connectP = t.connect();
    await Promise.resolve();
    const sock = FakeWebSocket.instances[0];
    if (!sock) throw new Error('no socket');
    sock.open();
    await connectP;

    await t.send({ id: '1', kind: 'hi', payload: null });
    expect(sock.sent).toEqual([JSON.stringify({ id: '1', kind: 'hi', payload: null })]);

    sock.receive({ id: '2', kind: 'reply', payload: 'ok' });
    expect(seen).toEqual([{ id: '2', kind: 'reply', payload: 'ok' }]);
    await t.close();
  });

  it('queues sends issued before the socket opens, then flushes on open', async () => {
    const t = new WebSocketTransport({
      url: 'ws://test',
      webSocket: FakeWebSocket as unknown as never,
    });
    const connectP = t.connect();
    await t.send({ id: '1', kind: 'before-open', payload: null });
    await Promise.resolve();
    const sock = FakeWebSocket.instances[0];
    if (!sock) throw new Error('no socket');
    sock.open();
    await connectP;
    expect(sock.sent[0]).toContain('before-open');
    await t.close();
  });

  it('responds to ping with pong', async () => {
    const t = new WebSocketTransport({
      url: 'ws://test',
      webSocket: FakeWebSocket as unknown as never,
    });
    const connectP = t.connect();
    await Promise.resolve();
    const sock = FakeWebSocket.instances[0];
    if (!sock) throw new Error('no socket');
    sock.open();
    await connectP;
    sock.receive({ id: 'ping-1', kind: 'ping', payload: null });
    expect(sock.sent.some((s) => s.includes('"pong"'))).toBe(true);
    await t.close();
  });

  it('does not surface ping/pong frames to handlers', async () => {
    const t = new WebSocketTransport({
      url: 'ws://test',
      webSocket: FakeWebSocket as unknown as never,
    });
    const seen: TransportMessage[] = [];
    t.onMessage((m) => seen.push(m));
    const connectP = t.connect();
    await Promise.resolve();
    const sock = FakeWebSocket.instances[0];
    if (!sock) throw new Error('no socket');
    sock.open();
    await connectP;
    sock.receive({ id: 'p', kind: 'ping', payload: null });
    sock.receive({ id: 'p', kind: 'pong', payload: null });
    expect(seen).toEqual([]);
    await t.close();
  });

  it('ignores malformed JSON and non-message data', async () => {
    const t = new WebSocketTransport({
      url: 'ws://test',
      webSocket: FakeWebSocket as unknown as never,
    });
    const seen: TransportMessage[] = [];
    t.onMessage((m) => seen.push(m));
    const connectP = t.connect();
    await Promise.resolve();
    const sock = FakeWebSocket.instances[0];
    if (!sock) throw new Error('no socket');
    sock.open();
    await connectP;
    sock.receiveRaw('not json');
    sock.receiveRaw('{"something": "else"}');
    sock.receiveRaw(42);
    expect(seen).toEqual([]);
    await t.close();
  });

  it('throws TransportClosedError when sending after close', async () => {
    const t = new WebSocketTransport({
      url: 'ws://test',
      webSocket: FakeWebSocket as unknown as never,
    });
    const connectP = t.connect();
    await Promise.resolve();
    const sock = FakeWebSocket.instances[0];
    if (!sock) throw new Error('no socket');
    sock.open();
    await connectP;
    await t.close();
    await expect(t.send({ id: '1', kind: 'x', payload: null })).rejects.toBeInstanceOf(
      TransportClosedError,
    );
  });

  it('rejects connect when the socket reports an error before opening', async () => {
    const t = new WebSocketTransport({
      url: 'ws://test',
      webSocket: FakeWebSocket as unknown as never,
    });
    const connectP = t.connect();
    await Promise.resolve();
    const sock = FakeWebSocket.instances[0];
    if (!sock) throw new Error('no socket');
    sock.errorOut('handshake failed');
    await expect(connectP).rejects.toBeInstanceOf(TransportError);
    await t.close();
  });

  it('reconnects after the socket closes (capped via maxReconnects)', async () => {
    const t = new WebSocketTransport({
      url: 'ws://test',
      webSocket: FakeWebSocket as unknown as never,
      initialBackoffMs: 1,
      maxReconnects: 2,
    });
    const connectP = t.connect();
    await Promise.resolve();
    FakeWebSocket.instances[0]?.open();
    await connectP;

    FakeWebSocket.instances[0]?.close();
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    await t.close();
  });

  it('refuses to connect after close', async () => {
    const t = new WebSocketTransport({
      url: 'ws://test',
      webSocket: FakeWebSocket as unknown as never,
    });
    await t.close();
    await expect(t.connect()).rejects.toBeInstanceOf(TransportClosedError);
  });
});

describe('NostrRelayTransport', () => {
  it('throws on every operation (Phase 2 reserved)', async () => {
    const t = new NostrRelayTransport(['wss://relay.example'], 'pubkey');
    await expect(t.connect()).rejects.toBeInstanceOf(TransportError);
    await expect(t.send({ id: 'x', kind: 'x', payload: null })).rejects.toBeInstanceOf(
      TransportError,
    );
    await expect(t.close()).resolves.toBeUndefined();
    expect(t.onMessage(() => {})).toBeInstanceOf(Function);
  });
});
