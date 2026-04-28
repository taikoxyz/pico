import { TransportClosedError, TransportError, TransportTimeoutError } from './errors.js';

export interface TransportMessage {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface Transport {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(msg: TransportMessage): Promise<void>;
  onMessage(handler: (msg: TransportMessage) => void): () => void;
}

export interface RequestReplyOptions {
  readonly timeoutMs?: number;
  readonly replyKind?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function newRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function requestReply<T = unknown>(
  transport: Transport,
  request: TransportMessage,
  opts: RequestReplyOptions = {},
): Promise<TransportMessage & { payload: T }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return new Promise<TransportMessage & { payload: T }>((resolve, reject) => {
    const dispose = transport.onMessage((msg) => {
      if (msg.id !== request.id) return;
      if (opts.replyKind && msg.kind !== opts.replyKind) return;
      clearTimeout(timer);
      dispose();
      resolve(msg as TransportMessage & { payload: T });
    });
    const timer = setTimeout(() => {
      dispose();
      reject(new TransportTimeoutError(opts.replyKind ?? request.kind, timeoutMs));
    }, timeoutMs);
    transport.send(request).catch((err) => {
      clearTimeout(timer);
      dispose();
      reject(err);
    });
  });
}

interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

interface WebSocketCtor {
  new (url: string): WebSocketLike;
}

export interface WebSocketTransportOptions {
  readonly url: string;
  readonly heartbeatMs?: number;
  readonly missedHeartbeatLimit?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly webSocket?: WebSocketCtor;
  readonly maxReconnects?: number;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MISSED_HEARTBEAT_LIMIT = 2;
const DEFAULT_INITIAL_BACKOFF_MS = 200;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

async function resolveWebSocketCtor(): Promise<WebSocketCtor> {
  const g = globalThis as { WebSocket?: WebSocketCtor };
  if (g.WebSocket) return g.WebSocket;
  const mod = (await import('ws')) as unknown as { default: WebSocketCtor };
  return mod.default;
}

interface ResolvedOptions {
  url: string;
  heartbeatMs: number;
  missedHeartbeatLimit: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  webSocket: WebSocketCtor | undefined;
  maxReconnects: number | undefined;
}

export class WebSocketTransport implements Transport {
  private readonly opts: ResolvedOptions;

  private socket: WebSocketLike | undefined;
  private ctor: WebSocketCtor | undefined;
  private handlers = new Set<(msg: TransportMessage) => void>();
  private outbox: string[] = [];
  private connectPromise: Promise<void> | undefined;
  private closed = false;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private missedHeartbeats = 0;

  constructor(options: WebSocketTransportOptions | string) {
    const o = typeof options === 'string' ? { url: options } : options;
    this.opts = {
      url: o.url,
      heartbeatMs: o.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      missedHeartbeatLimit: o.missedHeartbeatLimit ?? DEFAULT_MISSED_HEARTBEAT_LIMIT,
      initialBackoffMs: o.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      maxBackoffMs: o.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      webSocket: o.webSocket,
      maxReconnects: o.maxReconnects,
    };
  }

  async connect(): Promise<void> {
    if (this.closed) throw new TransportClosedError();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openSocket();
    return this.connectPromise;
  }

  private async openSocket(): Promise<void> {
    if (!this.ctor) this.ctor = this.opts.webSocket ?? (await resolveWebSocketCtor());
    const Ctor = this.ctor;
    const sock = new Ctor(this.opts.url);
    this.socket = sock;
    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.reconnectAttempts = 0;
        this.missedHeartbeats = 0;
        for (const queued of this.outbox) sock.send(queued);
        this.outbox = [];
        this.startHeartbeat();
        resolve();
      };
      const onError = (ev: unknown) => {
        reject(
          new TransportError(`websocket error: ${(ev as Error)?.message ?? 'unknown'}`, 'WS_ERROR'),
        );
      };
      sock.onopen = onOpen;
      sock.onerror = onError;
      sock.onclose = () => this.handleClose();
      sock.onmessage = (ev) => this.handleData(ev.data);
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.missedHeartbeats++;
      if (this.missedHeartbeats > this.opts.missedHeartbeatLimit) {
        this.socket?.close();
        return;
      }
      try {
        this.socket?.send(JSON.stringify({ id: newRequestId(), kind: 'ping', payload: null }));
      } catch {
        this.socket?.close();
      }
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private handleData(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isTransportMessage(parsed)) return;
    if (parsed.kind === 'pong' || parsed.kind === 'ping') {
      this.missedHeartbeats = 0;
      if (parsed.kind === 'ping') {
        try {
          this.socket?.send(JSON.stringify({ id: parsed.id, kind: 'pong', payload: null }));
        } catch {
          // socket likely closing; reconnect path will handle
        }
      }
      return;
    }
    for (const h of this.handlers) h(parsed);
  }

  private async handleClose(): Promise<void> {
    this.stopHeartbeat();
    this.socket = undefined;
    this.connectPromise = undefined;
    if (this.closed) return;
    if (
      this.opts.maxReconnects !== undefined &&
      this.reconnectAttempts >= this.opts.maxReconnects
    ) {
      return;
    }
    const delay = this.computeBackoffMs();
    this.reconnectAttempts++;
    await new Promise((r) => setTimeout(r, delay));
    if (this.closed) return;
    this.connectPromise = this.openSocket().catch(() => {
      // failed reconnect — will retry on next handleClose tick
    });
  }

  private computeBackoffMs(): number {
    const base = Math.min(
      this.opts.maxBackoffMs,
      this.opts.initialBackoffMs * 2 ** this.reconnectAttempts,
    );
    return Math.floor(base * (0.5 + Math.random() * 0.5));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = undefined;
    this.connectPromise = undefined;
    this.outbox = [];
    this.handlers.clear();
  }

  async send(msg: TransportMessage): Promise<void> {
    if (this.closed) throw new TransportClosedError();
    const data = JSON.stringify(msg);
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(data);
      return;
    }
    this.outbox.push(data);
  }

  onMessage(handler: (msg: TransportMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

function isTransportMessage(v: unknown): v is TransportMessage {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.kind === 'string' && 'payload' in o;
}

export interface InMemoryPipe {
  readonly client: Transport;
  readonly server: Transport;
}

class InMemoryTransport implements Transport {
  private readonly handlers = new Set<(msg: TransportMessage) => void>();
  private peer?: InMemoryTransport;
  private closed = false;

  attach(peer: InMemoryTransport): void {
    this.peer = peer;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new TransportClosedError();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }

  async send(msg: TransportMessage): Promise<void> {
    if (this.closed) throw new TransportClosedError();
    if (!this.peer) throw new TransportError('not connected', 'NOT_CONNECTED');
    if (this.peer.closed) throw new TransportClosedError();
    queueMicrotask(() => {
      for (const h of this.peer?.handlers ?? []) h(msg);
    });
  }

  onMessage(handler: (msg: TransportMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

export function createInMemoryPipe(): InMemoryPipe {
  const a = new InMemoryTransport();
  const b = new InMemoryTransport();
  a.attach(b);
  b.attach(a);
  return { client: a, server: b };
}

export class NostrRelayTransport implements Transport {
  constructor(
    private readonly _relays: readonly string[],
    private readonly _subscriberPubkey: string,
  ) {
    void this._relays;
    void this._subscriberPubkey;
  }

  async connect(): Promise<void> {
    throw new TransportError('NostrRelayTransport is reserved for Phase 2', 'NOT_IMPLEMENTED');
  }
  async close(): Promise<void> {
    // no-op
  }
  async send(_msg: TransportMessage): Promise<void> {
    throw new TransportError('NostrRelayTransport is reserved for Phase 2', 'NOT_IMPLEMENTED');
  }
  onMessage(_handler: (msg: TransportMessage) => void): () => void {
    return () => {
      // no-op
    };
  }
}
