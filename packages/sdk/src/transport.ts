import { TransportClosedError } from './errors.js';
import {
  type ClientToHubMessage,
  type HubToClientMessage,
  decodeHubMessage,
  encodeHubMessage,
} from './hub-protocol.js';

export interface TransportMessage {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface Transport {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(msg: ClientToHubMessage): Promise<void>;
  request(msg: ClientToHubMessage, opts?: { timeoutMs?: number }): Promise<HubToClientMessage>;
  onMessage(handler: (msg: HubToClientMessage) => void): () => void;
  onReconnect(handler: () => void | Promise<void>): () => void;
  isConnected(): boolean;
}

interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string | ArrayBuffer | Buffer }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

type WebSocketCtor = new (url: string) => MinimalWebSocket;

interface PingPongCapable {
  ping?(): void;
  pong?(): void;
  on?(event: 'pong' | 'ping', cb: () => void): void;
}

async function resolveWebSocketCtor(): Promise<WebSocketCtor> {
  const native = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (native) return native;
  const mod = (await import('ws')) as unknown as { default: WebSocketCtor };
  return mod.default;
}

export interface WebSocketTransportOptions {
  readonly url: string;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxMissedPongs?: number;
  readonly requestTimeoutMs?: number;
  readonly autoReconnect?: boolean;
}

interface PendingRequest {
  resolve: (msg: HubToClientMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebSocketTransport implements Transport {
  private readonly url: string;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxMissedPongs: number;
  private readonly requestTimeoutMs: number;
  private readonly autoReconnect: boolean;

  private ws: MinimalWebSocket | undefined;
  private wsCtor: WebSocketCtor | undefined;
  private connected = false;
  private connectingPromise: Promise<void> | undefined;
  private explicitlyClosed = false;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private missedPongs = 0;

  private readonly messageHandlers = new Set<(msg: HubToClientMessage) => void>();
  private readonly reconnectHandlers = new Set<() => void | Promise<void>>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(opts: WebSocketTransportOptions) {
    this.url = opts.url;
    this.minBackoffMs = opts.minBackoffMs ?? 200;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this.maxMissedPongs = opts.maxMissedPongs ?? 2;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.autoReconnect = opts.autoReconnect ?? true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectingPromise) return this.connectingPromise;
    this.explicitlyClosed = false;
    this.connectingPromise = this.doConnect();
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = undefined;
    }
  }

  private async doConnect(): Promise<void> {
    if (!this.wsCtor) this.wsCtor = await resolveWebSocketCtor();
    const ws = new this.wsCtor(this.url);
    this.ws = ws;
    this.missedPongs = 0;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.onopen = null;
        ws.onerror = null;
        resolve();
      };
      const onError = (ev: unknown) => {
        ws.onopen = null;
        ws.onerror = null;
        reject(ev instanceof Error ? ev : new Error('WebSocket error'));
      };
      ws.onopen = onOpen;
      ws.onerror = onError;
    });

    this.connected = true;
    this.reconnectAttempt = 0;

    ws.onmessage = (ev) => this.handleRawMessage(ev.data);
    ws.onclose = () => this.handleClose();
    ws.onerror = () => {};

    this.startHeartbeat();
  }

  private handleRawMessage(data: string | ArrayBuffer | Buffer): void {
    const text =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : data.toString('utf8');
    let msg: HubToClientMessage;
    try {
      msg = decodeHubMessage(text) as HubToClientMessage;
    } catch {
      return;
    }
    const pending = this.pending.get(msg.id);
    if (pending) {
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg);
    }
    for (const h of this.messageHandlers) {
      try {
        h(msg);
      } catch {
        // swallow; client provides its own error handling
      }
    }
  }

  private handleClose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.connected = false;
    this.ws = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new TransportClosedError());
      this.pending.delete(id);
    }
    if (this.explicitlyClosed || !this.autoReconnect) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const base = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** this.reconnectAttempt);
    const jittered = Math.floor(base * (0.5 + Math.random()));
    this.reconnectAttempt += 1;
    setTimeout(async () => {
      if (this.explicitlyClosed) return;
      try {
        await this.doConnect();
        for (const h of this.reconnectHandlers) {
          try {
            await h();
          } catch {
            // swallow; this is the user's reconnect hook
          }
        }
      } catch {
        this.scheduleReconnect();
      }
    }, jittered);
  }

  private startHeartbeat(): void {
    if (!this.ws) return;
    const ws = this.ws;
    const pp = ws as unknown as PingPongCapable;
    if (typeof pp.on === 'function' && typeof pp.ping === 'function') {
      pp.on('pong', () => {
        this.missedPongs = 0;
      });
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.missedPongs >= this.maxMissedPongs) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        return;
      }
      this.missedPongs += 1;
      try {
        if (typeof pp.ping === 'function') {
          pp.ping();
        } else {
          ws.send('{"id":"heartbeat","kind":"ping","payload":null}');
        }
      } catch {
        // ignore — close will fire if the socket is dead
      }
    }, this.heartbeatIntervalMs);
  }

  async close(): Promise<void> {
    this.explicitlyClosed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.connected = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new TransportClosedError());
      this.pending.delete(id);
    }
  }

  async send(msg: ClientToHubMessage): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new TransportClosedError();
    }
    this.ws.send(encodeHubMessage(msg));
  }

  async request(
    msg: ClientToHubMessage,
    opts: { timeoutMs?: number } = {},
  ): Promise<HubToClientMessage> {
    if (!this.connected || !this.ws) {
      throw new TransportClosedError();
    }
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<HubToClientMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`transport request '${msg.kind}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(msg.id, { resolve, reject, timer });
      try {
        this.ws?.send(encodeHubMessage(msg));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(msg.id);
        reject(err as Error);
      }
    });
  }

  onMessage(handler: (msg: HubToClientMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onReconnect(handler: () => void | Promise<void>): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }
}

/**
 * @experimental Nostr relay transport — NOT implemented in v1.
 *
 * All methods throw. The class is exported only as a shape stub so
 * downstream code can program against the eventual interface. Will be
 * implemented in Phase 2 (DVM/Nostr discovery).
 */
export class NostrRelayTransport implements Transport {
  constructor(
    private readonly _relays: readonly string[],
    private readonly _subscriberPubkey: string,
  ) {
    void this._relays;
    void this._subscriberPubkey;
  }
  /** @experimental Throws — NostrRelayTransport is a Phase-2 feature. */
  async connect(): Promise<void> {
    throw new Error(
      'NostrRelayTransport.connect: experimental Phase-2 feature, not implemented in v1',
    );
  }
  /** @experimental Throws — NostrRelayTransport is a Phase-2 feature. */
  async close(): Promise<void> {
    throw new Error(
      'NostrRelayTransport.close: experimental Phase-2 feature, not implemented in v1',
    );
  }
  /** @experimental Throws — NostrRelayTransport is a Phase-2 feature. */
  async send(): Promise<void> {
    throw new Error(
      'NostrRelayTransport.send: experimental Phase-2 feature, not implemented in v1',
    );
  }
  /** @experimental Throws — NostrRelayTransport is a Phase-2 feature. */
  async request(): Promise<HubToClientMessage> {
    throw new Error(
      'NostrRelayTransport.request: experimental Phase-2 feature, not implemented in v1',
    );
  }
  onMessage(): () => void {
    return () => {};
  }
  onReconnect(): () => void {
    return () => {};
  }
  isConnected(): boolean {
    return false;
  }
}
