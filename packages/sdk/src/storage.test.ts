import type { Channel, Invoice, SignedState } from '@pico/protocol';
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage.js';

const channelA: Channel = {
  id: '0x0000000000000000000000000000000000000000000000000000000000000001',
  chainId: 167000,
  contract: '0x0000000000000000000000000000000000000000',
  userA: '0x00000000000000000000000000000000000000a1',
  userB: '0x00000000000000000000000000000000000000b0',
  token: '0x0000000000000000000000000000000000000000',
  status: 'open',
  openedAt: 0n,
  disputeWindowMs: 86_400_000,
};

const channelB: Channel = {
  ...channelA,
  id: '0x0000000000000000000000000000000000000000000000000000000000000002',
};

const sig = { r: '0x00' as const, s: '0x00' as const, v: 27 };

const signedState: SignedState = {
  state: {
    channelId: channelA.id,
    version: 5n,
    balanceA: 100n,
    balanceB: 50n,
    htlcs: [],
    finalized: false,
  },
  sigA: sig,
  sigB: sig,
};

const invoice: Invoice = {
  paymentHash: '0xabababababababababababababababababababababababababababababababab',
  amount: 1000n,
  recipient: '0x00000000000000000000000000000000000000b0',
  expiryMs: 9_999_999_999_999n,
  nonce: '0x000102030405060708090a0b0c0d0e0f',
  signature: '0xdead',
};

describe('MemoryStorage', () => {
  it('round-trips a channel and lists it', async () => {
    const storage = new MemoryStorage();
    expect(await storage.list()).toEqual([]);
    await storage.saveChannel(channelA);
    expect(await storage.loadChannel(channelA.id)).toEqual(channelA);
    expect((await storage.list()).length).toBe(1);
  });

  it('overwrites a channel on second save', async () => {
    const storage = new MemoryStorage();
    await storage.saveChannel(channelA);
    await storage.saveChannel({ ...channelA, status: 'closed' });
    expect((await storage.loadChannel(channelA.id))?.status).toBe('closed');
  });

  it('round-trips signed state', async () => {
    const storage = new MemoryStorage();
    expect(await storage.loadLatestState(channelA.id)).toBeUndefined();
    await storage.saveState(channelA.id, signedState);
    expect(await storage.loadLatestState(channelA.id)).toEqual(signedState);
  });

  it('delete removes a channel and its state', async () => {
    const storage = new MemoryStorage();
    await storage.saveChannel(channelA);
    await storage.saveState(channelA.id, signedState);
    await storage.delete(channelA.id);
    expect(await storage.loadChannel(channelA.id)).toBeUndefined();
    expect(await storage.loadLatestState(channelA.id)).toBeUndefined();
  });

  it('clear empties channels, states, and invoices', async () => {
    const storage = new MemoryStorage();
    await storage.saveChannel(channelA);
    await storage.saveChannel(channelB);
    await storage.saveState(channelA.id, signedState);
    await storage.saveInvoice(invoice, '0xc0c0c0');
    await storage.clear();
    expect(await storage.list()).toEqual([]);
    expect(await storage.loadInvoice(invoice.paymentHash)).toBeUndefined();
  });

  it('saveInvoice + loadInvoice round-trip with preimage', async () => {
    const storage = new MemoryStorage();
    await storage.saveInvoice(invoice, '0xpreimage' as const);
    const rec = await storage.loadInvoice(invoice.paymentHash);
    expect(rec?.invoice).toEqual(invoice);
    expect(rec?.preimage).toBe('0xpreimage');
    expect(rec?.consumedAt).toBeUndefined();
  });

  it('markInvoiceConsumed is idempotent (only first call sticks)', async () => {
    const storage = new MemoryStorage();
    await storage.saveInvoice(invoice, '0xc0');
    await storage.markInvoiceConsumed(invoice.paymentHash, 100);
    await storage.markInvoiceConsumed(invoice.paymentHash, 200);
    const rec = await storage.loadInvoice(invoice.paymentHash);
    expect(rec?.consumedAt).toBe(100);
  });

  it('markInvoiceConsumed is a no-op when invoice is unknown', async () => {
    const storage = new MemoryStorage();
    await storage.markInvoiceConsumed(invoice.paymentHash, 100);
    expect(await storage.loadInvoice(invoice.paymentHash)).toBeUndefined();
  });

  it('saveInvoice preserves consumedAt when called again on consumed invoice', async () => {
    const storage = new MemoryStorage();
    await storage.saveInvoice(invoice, '0xc0');
    await storage.markInvoiceConsumed(invoice.paymentHash, 50);
    await storage.saveInvoice(invoice, '0xc0');
    expect((await storage.loadInvoice(invoice.paymentHash))?.consumedAt).toBe(50);
  });
});
