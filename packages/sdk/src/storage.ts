import type {
  Channel,
  ChannelId,
  Invoice,
  PaymentHash,
  Preimage,
  SignedState,
} from '@inferenceroom/pico-protocol';
import type { InvoiceRecord } from './storage-shared.js';

export interface ChannelStorage {
  saveChannel(channel: Channel): Promise<void>;
  loadChannel(id: ChannelId): Promise<Channel | undefined>;
  saveState(channelId: ChannelId, state: SignedState): Promise<void>;
  loadLatestState(channelId: ChannelId): Promise<SignedState | undefined>;
  list(): Promise<readonly Channel[]>;
  saveInvoice(invoice: Invoice, preimage: Preimage): Promise<void>;
  loadInvoice(paymentHash: PaymentHash): Promise<InvoiceRecord | undefined>;
  markInvoiceConsumed(paymentHash: PaymentHash, consumedAtMs: number): Promise<void>;
  delete(id: ChannelId): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStorage implements ChannelStorage {
  private readonly channels = new Map<ChannelId, Channel>();
  private readonly states = new Map<ChannelId, SignedState>();
  private readonly invoices = new Map<PaymentHash, InvoiceRecord>();

  async saveChannel(channel: Channel): Promise<void> {
    this.channels.set(channel.id, channel);
  }

  async loadChannel(id: ChannelId): Promise<Channel | undefined> {
    return this.channels.get(id);
  }

  async saveState(channelId: ChannelId, state: SignedState): Promise<void> {
    this.states.set(channelId, state);
  }

  async loadLatestState(channelId: ChannelId): Promise<SignedState | undefined> {
    return this.states.get(channelId);
  }

  async list(): Promise<readonly Channel[]> {
    return Array.from(this.channels.values());
  }

  async saveInvoice(invoice: Invoice, preimage: Preimage): Promise<void> {
    const existing = this.invoices.get(invoice.paymentHash);
    this.invoices.set(invoice.paymentHash, {
      invoice,
      preimage,
      ...(existing?.consumedAt !== undefined ? { consumedAt: existing.consumedAt } : {}),
    });
  }

  async loadInvoice(paymentHash: PaymentHash): Promise<InvoiceRecord | undefined> {
    return this.invoices.get(paymentHash);
  }

  async markInvoiceConsumed(paymentHash: PaymentHash, consumedAtMs: number): Promise<void> {
    const existing = this.invoices.get(paymentHash);
    if (!existing) return;
    if (existing.consumedAt !== undefined) return;
    this.invoices.set(paymentHash, { ...existing, consumedAt: consumedAtMs });
  }

  async delete(id: ChannelId): Promise<void> {
    this.channels.delete(id);
    this.states.delete(id);
  }

  async clear(): Promise<void> {
    this.channels.clear();
    this.states.clear();
    this.invoices.clear();
  }
}
