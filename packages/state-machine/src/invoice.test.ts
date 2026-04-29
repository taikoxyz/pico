import { type Invoice, TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { buildInvoiceTypedData, hashInvoice, verifyInvoiceSignature } from './invoice.js';

const recipientKey = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const wrongKey = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;

const baseInvoice = {
  paymentHash: '0xabababababababababababababababababababababababababababababababab',
  amount: 1_000_000n,
  expiryMs: 1_800_000_000_000n,
  nonce: '0x000102030405060708090a0b0c0d0e0f',
} as const;

async function signInvoice(
  privateKey: `0x${string}`,
  fields: Omit<Invoice, 'signature' | 'recipient'>,
): Promise<Invoice> {
  const account = privateKeyToAccount(privateKey);
  const partial: Invoice = { ...fields, recipient: account.address, signature: '0x' };
  const data = buildInvoiceTypedData(partial, TAIKO_MAINNET_CHAIN_ID);
  const signature = await account.signTypedData(data);
  return { ...partial, signature };
}

describe('invoice typed-data', () => {
  it('hashes deterministically for the same inputs', () => {
    const account = privateKeyToAccount(recipientKey);
    const invoice: Invoice = { ...baseInvoice, recipient: account.address, signature: '0x' };
    const a = hashInvoice(invoice, TAIKO_MAINNET_CHAIN_ID);
    const b = hashInvoice(invoice, TAIKO_MAINNET_CHAIN_ID);
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('hash changes when paymentHash mutates', () => {
    const account = privateKeyToAccount(recipientKey);
    const a = hashInvoice(
      { ...baseInvoice, recipient: account.address, signature: '0x' },
      TAIKO_MAINNET_CHAIN_ID,
    );
    const b = hashInvoice(
      {
        ...baseInvoice,
        paymentHash: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
        recipient: account.address,
        signature: '0x',
      },
      TAIKO_MAINNET_CHAIN_ID,
    );
    expect(a).not.toBe(b);
  });

  it('verifyInvoiceSignature returns true for the correct signer', async () => {
    const invoice = await signInvoice(recipientKey, baseInvoice);
    const ok = await verifyInvoiceSignature(invoice, invoice.recipient, TAIKO_MAINNET_CHAIN_ID);
    expect(ok).toBe(true);
  });

  it('verifyInvoiceSignature returns false for a different expected signer', async () => {
    const invoice = await signInvoice(recipientKey, baseInvoice);
    const otherAddress = privateKeyToAccount(wrongKey).address;
    const ok = await verifyInvoiceSignature(invoice, otherAddress, TAIKO_MAINNET_CHAIN_ID);
    expect(ok).toBe(false);
  });

  it('verifyInvoiceSignature rejects mutated amount', async () => {
    const invoice = await signInvoice(recipientKey, baseInvoice);
    const mutated: Invoice = { ...invoice, amount: invoice.amount + 1n };
    const ok = await verifyInvoiceSignature(mutated, invoice.recipient, TAIKO_MAINNET_CHAIN_ID);
    expect(ok).toBe(false);
  });

  it('memo defaults to empty string when undefined for signing', async () => {
    const invoice = await signInvoice(recipientKey, baseInvoice);
    const withExplicitEmpty: Invoice = { ...invoice, memo: '' };
    const ok = await verifyInvoiceSignature(
      withExplicitEmpty,
      invoice.recipient,
      TAIKO_MAINNET_CHAIN_ID,
    );
    expect(ok).toBe(true);
  });
});
