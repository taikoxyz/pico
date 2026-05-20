import type { Address, ChannelId } from '@inferenceroom/pico-protocol';
import { buildEnvelope } from './envelope.js';
import { TransportClosedError } from './errors.js';
import {
  type ClientToHubMessage,
  type HubMessage,
  type HubToClientMessage,
  decodeHubMessage,
  encodeHubMessage,
} from './hub-protocol.js';
import type { Signer } from './signer.js';

export interface TransportMessage {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface Transport {
  connect(): Promise<void>;
  close(): Promise<void>;
  /**
   * Sends a message. Accepts the full `HubMessage` union because a direct
   * peer-channel client also emits hub-role messages (e.g. `htlcOffer`,
   * `payDirectAck`, `closeResponse`) toward its peer over the relay.
   */
  send(msg: HubMessage): Promise<void>;
  request(msg: ClientToHubMessage, opts?: { timeoutMs?: number }): Promise<HubToClientMessage>;
  onMessage(handler: (msg: HubMessage) => void): () => void;
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
  /// When set, every outgoing `ClientToHubMessage` is wrapped in a signed
  /// envelope (nonce + ts + payload + sig). Required against hubs running
  /// with `HUB_REQUIRE_SIGNED_ENVELOPE=true` (production / mainnet); harmless
  /// against dev hubs once the auto-detect path is enabled.
  readonly signer?: Signer;
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
  private readonly signer: Signer | undefined;

  private ws: MinimalWebSocket | undefined;
  private wsCtor: WebSocketCtor | undefined;
  private connected = false;
  private connectingPromise: Promise<void> | undefined;
  private explicitlyClosed = false;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private missedPongs = 0;

  private readonly messageHandlers = new Set<(msg: HubMessage) => void>();
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
    this.signer = opts.signer;
  }

  private async encodeForWire(msg: HubMessage): Promise<string> {
    const payload = encodeHubMessage(msg);
    if (!this.signer) return payload;
    const env = await buildEnvelope(this.signer, payload);
    return JSON.stringify(env);
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
    let msg: HubMessage;
    try {
      msg = decodeHubMessage(text);
    } catch {
      return;
    }
    const pending = this.pending.get(msg.id);
    if (pending) {
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg as HubToClientMessage);
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

  async send(msg: HubMessage): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new TransportClosedError();
    }
    const wire = await this.encodeForWire(msg);
    this.ws.send(wire);
  }

  async request(
    msg: ClientToHubMessage,
    opts: { timeoutMs?: number } = {},
  ): Promise<HubToClientMessage> {
    if (!this.connected || !this.ws) {
      throw new TransportClosedError();
    }
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    const wire = await this.encodeForWire(msg);
    return new Promise<HubToClientMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`transport request '${msg.kind}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(msg.id, { resolve, reject, timer });
      try {
        this.ws?.send(wire);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(msg.id);
        reject(err as Error);
      }
    });
  }

  onMessage(handler: (msg: HubMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onReconnect(handler: () => void | Promise<void>): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }
}

/**
 * Transport for direct (hub-less) peer channels. Wraps a base transport (a
 * `WebSocketTransport` connected to a hub running in relay mode) and tunnels
 * every channel message to the channel counterparty inside a `RelayMessage`,
 * while passing hub-bound control messages (`subscribe`) straight through.
 *
 * The destination is derived from the message's channel: for messages with a
 * `channelId` (or a `channel` record) the counterparty is resolved via
 * `resolveCounterparty`. Request/response correlation is keyed on the inner
 * message id — the hub forwards the peer's reply verbatim (same id), so it
 * lands back here and resolves the pending request.
 */
export interface RelayTransportOptions {
  readonly base: Transport;
  readonly resolveCounterparty: (channelId: ChannelId) => Promise<Address | undefined>;
  readonly requestTimeoutMs?: number;
}

export class RelayTransport implements Transport {
  private readonly base: Transport;
  private readonly resolveCounterparty: (channelId: ChannelId) => Promise<Address | undefined>;
  private readonly requestTimeoutMs: number;
  private readonly messageHandlers = new Set<(msg: HubMessage) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private baseUnsub: (() => void) | undefined;

  constructor(opts: RelayTransportOptions) {
    this.base = opts.base;
    this.resolveCounterparty = opts.resolveCounterparty;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  private installBaseHandler(): void {
    if (this.baseUnsub) return;
    this.baseUnsub = this.base.onMessage((msg) => {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg as HubToClientMessage);
      }
      for (const h of this.messageHandlers) {
        try {
          h(msg);
        } catch {
          // swallow; client provides its own error handling
        }
      }
    });
  }

  private isPassthrough(msg: HubMessage): boolean {
    // `subscribe` (and top-up accept/reject) are addressed to the hub itself,
    // not to a peer, so they bypass the relay envelope.
    return msg.kind === 'subscribe' || msg.kind === 'acceptTopUp' || msg.kind === 'rejectTopUp';
  }

  private channelIdOf(msg: HubMessage): ChannelId | undefined {
    if ('channelId' in msg && msg.channelId !== undefined) return msg.channelId as ChannelId;
    if (msg.kind === 'channelAnnounce') return msg.channel.id;
    return undefined;
  }

  private async wrap(msg: HubMessage): Promise<ClientToHubMessage> {
    const channelId = this.channelIdOf(msg);
    if (channelId === undefined) {
      throw new Error(`RelayTransport: cannot resolve peer for message kind '${msg.kind}'`);
    }
    const to = await this.resolveCounterparty(channelId);
    if (!to) {
      throw new Error(`RelayTransport: no known counterparty for channel ${channelId}`);
    }
    return { id: msg.id, kind: 'relay', to, inner: msg };
  }

  async connect(): Promise<void> {
    await this.base.connect();
    this.installBaseHandler();
  }

  async close(): Promise<void> {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new TransportClosedError());
      this.pending.delete(id);
    }
    if (this.baseUnsub) {
      this.baseUnsub();
      this.baseUnsub = undefined;
    }
    await this.base.close();
  }

  isConnected(): boolean {
    return this.base.isConnected();
  }

  async send(msg: HubMessage): Promise<void> {
    if (this.isPassthrough(msg)) {
      await this.base.send(msg);
      return;
    }
    await this.base.send(await this.wrap(msg));
  }

  async request(
    msg: ClientToHubMessage,
    opts: { timeoutMs?: number } = {},
  ): Promise<HubToClientMessage> {
    if (this.isPassthrough(msg)) {
      return this.base.request(msg, opts);
    }
    this.installBaseHandler();
    const wrapped = await this.wrap(msg);
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<HubToClientMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`relay request '${msg.kind}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(msg.id, { resolve, reject, timer });
      this.base.send(wrapped).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(msg.id);
        reject(err as Error);
      });
    });
  }

  onMessage(handler: (msg: HubMessage) => void): () => void {
    this.installBaseHandler();
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onReconnect(handler: () => void | Promise<void>): () => void {
    return this.base.onReconnect(handler);
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
