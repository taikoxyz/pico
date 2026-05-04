import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Channel, Invoice, SignedState } from '@pico/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStorage } from './storage-file.js';

const channelA: Channel = {
  id: '0x0000000000000000000000000000000000000000000000000000000000000001',
  chainId: 167000,
  contract: '0x07B32f52523Fdf0780821595422DccEF31FA2335',
  userA: '0x00000000000000000000000000000000000000a1',
  userB: '0x00000000000000000000000000000000000000b0',
  token: '0x07d83526730c7438048D55A4fc0b850e2aaB6f0b',
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
    htlcs: [
      {
        id: '0x0000000000000000000000000000000000000000000000000000000000000abc',
        direction: 'AtoB',
        amount: 100n,
        paymentHash: '0xabababababababababababababababababababababababababababababababab',
        expiryMs: 1_800_000_000_000n,
      },
    ],
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
  memo: 'thanks for the data',
  signature: '0xdeadbeef',
};

describe('FileStorage', () => {
  let root: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pico-sdk-test-'));
    storage = new FileStorage({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a channel through disk', async () => {
    await storage.saveChannel(channelA);
    expect(await storage.loadChannel(channelA.id)).toEqual(channelA);
  });

  it('returns undefined for unknown channel', async () => {
    expect(await storage.loadChannel(channelA.id)).toBeUndefined();
  });

  it('round-trips signed state with bigints + htlcs', async () => {
    await storage.saveState(channelA.id, signedState);
    expect(await storage.loadLatestState(channelA.id)).toEqual(signedState);
  });

  it('list returns all saved channels', async () => {
    await storage.saveChannel(channelA);
    await storage.saveChannel(channelB);
    const all = await storage.list();
    expect(all.map((c) => c.id).sort()).toEqual([channelA.id, channelB.id].sort());
  });

  it('list returns [] when no channels saved (no dir yet)', async () => {
    expect(await storage.list()).toEqual([]);
  });

  it('delete removes channel + state files but leaves invoices', async () => {
    await storage.saveChannel(channelA);
    await storage.saveState(channelA.id, signedState);
    await storage.saveInvoice(invoice, '0xc0c0c0');
    await storage.delete(channelA.id);
    expect(await storage.loadChannel(channelA.id)).toBeUndefined();
    expect(await storage.loadLatestState(channelA.id)).toBeUndefined();
    expect(await storage.loadInvoice(invoice.paymentHash)).toBeDefined();
  });

  it('clear removes the entire root dir', async () => {
    await storage.saveChannel(channelA);
    await storage.saveInvoice(invoice, '0xc0');
    await storage.clear();
    expect(await storage.list()).toEqual([]);
    expect(await storage.loadInvoice(invoice.paymentHash)).toBeUndefined();
  });

  it('saveInvoice + loadInvoice round-trip preserves preimage', async () => {
    await storage.saveInvoice(invoice, '0xpre');
    const rec = await storage.loadInvoice(invoice.paymentHash);
    expect(rec?.invoice).toEqual(invoice);
    expect(rec?.preimage).toBe('0xpre');
  });

  it('markInvoiceConsumed sticks across reload', async () => {
    await storage.saveInvoice(invoice, '0xc0');
    await storage.markInvoiceConsumed(invoice.paymentHash, 1234);
    const reopened = new FileStorage({ root });
    const rec = await reopened.loadInvoice(invoice.paymentHash);
    expect(rec?.consumedAt).toBe(1234);
  });

  it('atomic write does not leave a .tmp file behind on success', async () => {
    await storage.saveChannel(channelA);
    const files = await readdir(join(root, 'channels'));
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toContain(`${channelA.id}.json`);
  });

  it('saveInvoice preserves consumedAt on re-save', async () => {
    await storage.saveInvoice(invoice, '0xc0');
    await storage.markInvoiceConsumed(invoice.paymentHash, 100);
    await storage.saveInvoice(invoice, '0xc0');
    const rec = await storage.loadInvoice(invoice.paymentHash);
    expect(rec?.consumedAt).toBe(100);
  });

  it('survives a full save → reload cycle', async () => {
    await storage.saveChannel(channelA);
    await storage.saveState(channelA.id, signedState);
    const reopened = new FileStorage({ root });
    expect(await reopened.loadChannel(channelA.id)).toEqual(channelA);
    expect(await reopened.loadLatestState(channelA.id)).toEqual(signedState);
  });
});
