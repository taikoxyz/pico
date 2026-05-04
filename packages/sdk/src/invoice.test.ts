import { TAIKO_MAINNET_CHAIN_ID } from '@pico/protocol';
import { InMemorySigner } from '@pico/test-utils';
import { describe, expect, it } from 'vitest';
import { InvoiceExpiredError, InvoiceVerificationError } from './errors.js';
import { createInvoice, verifyInvoice } from './invoice.js';

const SIGNER_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const OTHER_KEY = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CHAIN_ID = TAIKO_MAINNET_CHAIN_ID;

describe('createInvoice + verifyInvoice', () => {
  it('round-trips an invoice signed by the signer', async () => {
    const signer = new InMemorySigner(SIGNER_KEY);
    const { invoice } = await createInvoice(
      { amount: 1000n, chainId: CHAIN_ID, expiryMs: 9_999_999_999_999n, memo: 'lunch' },
      signer,
    );
    expect(invoice.recipient.toLowerCase()).toBe((await signer.address()).toLowerCase());
    await expect(verifyInvoice(invoice, { chainId: CHAIN_ID })).resolves.toBeUndefined();
  });

  it('rejects an expired invoice', async () => {
    const signer = new InMemorySigner(SIGNER_KEY);
    const { invoice } = await createInvoice(
      { amount: 1000n, chainId: CHAIN_ID, expiryMs: 100n },
      signer,
    );
    await expect(
      verifyInvoice(invoice, { chainId: CHAIN_ID, nowMs: 1000n }),
    ).rejects.toBeInstanceOf(InvoiceExpiredError);
  });

  it('rejects a mutated amount', async () => {
    const signer = new InMemorySigner(SIGNER_KEY);
    const { invoice } = await createInvoice(
      { amount: 1000n, chainId: CHAIN_ID, expiryMs: 9_999_999_999_999n },
      signer,
    );
    await expect(
      verifyInvoice({ ...invoice, amount: invoice.amount + 1n }, { chainId: CHAIN_ID }),
    ).rejects.toBeInstanceOf(InvoiceVerificationError);
  });

  it('rejects a recipient swap', async () => {
    const signer = new InMemorySigner(SIGNER_KEY);
    const other = new InMemorySigner(OTHER_KEY);
    const { invoice } = await createInvoice(
      { amount: 1000n, chainId: CHAIN_ID, expiryMs: 9_999_999_999_999n },
      signer,
    );
    await expect(
      verifyInvoice(invoice, {
        chainId: CHAIN_ID,
        expectedRecipient: await other.address(),
      }),
    ).rejects.toBeInstanceOf(InvoiceVerificationError);
  });

  it('preimage hashes to paymentHash', async () => {
    const signer = new InMemorySigner(SIGNER_KEY);
    const { invoice, preimage, paymentHash } = await createInvoice(
      { amount: 1000n, chainId: CHAIN_ID, expiryMs: 9_999_999_999_999n },
      signer,
    );
    expect(invoice.paymentHash).toBe(paymentHash);
    expect(preimage).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
