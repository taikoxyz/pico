// @vitest-environment happy-dom
import {
  CONTRACT_ADDRESSES,
  type Channel,
  type Invoice,
  type SignedState,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
} from '@pico/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDBStorage } from './storage-indexeddb.js';

const channelA: Channel = {
  id: '0x0000000000000000000000000000000000000000000000000000000000000001',
  chainId: TAIKO_MAINNET_CHAIN_ID,
  contract: CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID].PaymentChannel,
  userA: '0x00000000000000000000000000000000000000a1',
  userB: '0x00000000000000000000000000000000000000b0',
  token: USDC_TOKENS[TAIKO_MAINNET_CHAIN_ID].address,
  status: 'open',
  openedAt: 1_700_000_000n,
  disputeWindowMs: 86_400_000,
};

const channelB: Channel = {
  ...channelA,
  id: '0x0000000000000000000000000000000000000000000000000000000000000002',
};

const sig = { r: '0x11' as const, s: '0x22' as const, v: 27 };

const signedState: SignedState = {
  state: {
    channelId: channelA.id,
    version: 7n,
    balanceA: 12_345_678n,
    balanceB: 87_654_321n,
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

describe('IndexedDBStorage', () => {
  let storage: IndexedDBStorage;
  let factory: IDBFactory;

  beforeEach(() => {
    factory = new IDBFactory();
    storage = new IndexedDBStorage({ dbName: 'pico-test', factory });
  });

  it('round-trips a channel', async () => {
    await storage.saveChannel(channelA);
    expect(await storage.loadChannel(channelA.id)).toEqual(channelA);
  });

  it('list returns all saved channels', async () => {
    await storage.saveChannel(channelA);
    await storage.saveChannel(channelB);
    const all = await storage.list();
    expect(all.map((c) => c.id).sort()).toEqual([channelA.id, channelB.id].sort());
  });

  it('round-trips signed state with bigints', async () => {
    await storage.saveState(channelA.id, signedState);
    expect(await storage.loadLatestState(channelA.id)).toEqual(signedState);
  });

  it('delete removes channel + state', async () => {
    await storage.saveChannel(channelA);
    await storage.saveState(channelA.id, signedState);
    await storage.delete(channelA.id);
    expect(await storage.loadChannel(channelA.id)).toBeUndefined();
    expect(await storage.loadLatestState(channelA.id)).toBeUndefined();
  });

  it('clear empties everything', async () => {
    await storage.saveChannel(channelA);
    await storage.saveInvoice(invoice, '0xc0');
    await storage.clear();
    expect(await storage.list()).toEqual([]);
    expect(await storage.loadInvoice(invoice.paymentHash)).toBeUndefined();
  });

  it('invoice round-trip and consumedAt persistence across reopen', async () => {
    await storage.saveInvoice(invoice, '0xpre');
    await storage.markInvoiceConsumed(invoice.paymentHash, 9999);
    await storage.close();
    const reopened = new IndexedDBStorage({ dbName: 'pico-test', factory });
    const rec = await reopened.loadInvoice(invoice.paymentHash);
    expect(rec?.preimage).toBe('0xpre');
    expect(rec?.consumedAt).toBe(9999);
  });

  it('saveInvoice preserves consumedAt on re-save', async () => {
    await storage.saveInvoice(invoice, '0xc0');
    await storage.markInvoiceConsumed(invoice.paymentHash, 50);
    await storage.saveInvoice(invoice, '0xc0');
    expect((await storage.loadInvoice(invoice.paymentHash))?.consumedAt).toBe(50);
  });

  it('throws if no IDBFactory is available', () => {
    expect(() => new IndexedDBStorage({ factory: undefined as unknown as IDBFactory })).toThrow();
  });

  it('returns undefined for unknown channel', async () => {
    expect(await storage.loadChannel(channelA.id)).toBeUndefined();
    expect(await storage.loadLatestState(channelA.id)).toBeUndefined();
    expect(await storage.loadInvoice(invoice.paymentHash)).toBeUndefined();
  });
});
