import type { Address, Channel, ChannelId } from '@tainnel/protocol';
import type { PaymentRequest, PaymentResult } from './payment.js';
import type { ChannelStorage } from './storage.js';
import type { Transport } from './transport.js';
import type { WalletAdapter } from './wallet.js';

export interface ChannelClientOptions {
  readonly wallet: WalletAdapter;
  readonly transport: Transport;
  readonly storage: ChannelStorage;
}

export interface OpenChannelArgs {
  readonly counterparty: Address;
  readonly amount: bigint;
  readonly token?: Address;
}

export class ChannelClient {
  constructor(private readonly opts: ChannelClientOptions) {}

  async open(_args: OpenChannelArgs): Promise<Channel> {
    throw new Error('not implemented');
  }

  async pay(_request: PaymentRequest): Promise<PaymentResult> {
    throw new Error('not implemented');
  }

  async close(_id: ChannelId, _opts?: { cooperative?: boolean }): Promise<void> {
    throw new Error('not implemented');
  }

  async list(): Promise<readonly Channel[]> {
    return this.opts.storage.list();
  }
}
