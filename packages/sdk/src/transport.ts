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

export class WebSocketTransport implements Transport {
  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    throw new Error('not implemented');
  }
  async close(): Promise<void> {
    throw new Error('not implemented');
  }
  async send(_msg: TransportMessage): Promise<void> {
    throw new Error('not implemented');
  }
  onMessage(_handler: (msg: TransportMessage) => void): () => void {
    throw new Error('not implemented');
  }
}

export class NostrRelayTransport implements Transport {
  constructor(
    private readonly relays: readonly string[],
    private readonly subscriberPubkey: string,
  ) {}

  async connect(): Promise<void> {
    throw new Error('not implemented');
  }
  async close(): Promise<void> {
    throw new Error('not implemented');
  }
  async send(_msg: TransportMessage): Promise<void> {
    throw new Error('not implemented');
  }
  onMessage(_handler: (msg: TransportMessage) => void): () => void {
    throw new Error('not implemented');
  }
}
