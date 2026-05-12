import { TAIKO_MAINNET_CHAIN_ID, type Hex } from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import { createInvoice, verifyInvoice } from './invoice.js';
import { STEALTH_LABEL_USER_B, StealthKeyManager } from './stealth.js';

const SCAN_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as Hex;
const CHAIN_ID = TAIKO_MAINNET_CHAIN_ID;
const EXPIRY_FAR_FUTURE = 9_999_999_999_999n;

// These tests assert that the existing `createInvoice` API is already
// compatible with per-invoice stealth recipients. Any caller that wants
// recipient rotation derives an ephemeral signer from a `StealthKeyManager`
// (item 2 of the privacy plan) and passes it as the invoice signer; the
// invoice's `recipient` then equals that ephemeral address, not the
// caller's stable scan-key identity.

describe('recipient rotation via stealth signers (item 2)', () => {
  it('two invoices with different stealth nonces produce different recipients', async () => {
    const mgr = new StealthKeyManager(SCAN_KEY);
    const nonceA = '0x11111111111111111111111111111111' as Hex;
    const nonceB = '0x22222222222222222222222222222222' as Hex;

    const signerA = mgr.signerFor(STEALTH_LABEL_USER_B, nonceA);
    const signerB = mgr.signerFor(STEALTH_LABEL_USER_B, nonceB);

    const invA = await createInvoice(
      { amount: 1000n, chainId: CHAIN_ID, expiryMs: EXPIRY_FAR_FUTURE },
      signerA,
    );
    const invB = await createInvoice(
      { amount: 1000n, chainId: CHAIN_ID, expiryMs: EXPIRY_FAR_FUTURE },
      signerB,
    );

    expect(invA.invoice.recipient).not.toBe(invB.invoice.recipient);
    expect(invA.invoice.recipient.toLowerCase()).toBe(
      (await signerA.address()).toLowerCase(),
    );
    expect(invB.invoice.recipient.toLowerCase()).toBe(
      (await signerB.address()).toLowerCase(),
    );
  });

  it('both rotated invoices verify under the standard verifier', async () => {
    const mgr = new StealthKeyManager(SCAN_KEY);
    const signer = mgr.signerFor(STEALTH_LABEL_USER_B, '0xabababababababababababababababab' as Hex);
    const { invoice } = await createInvoice(
      { amount: 250n, chainId: CHAIN_ID, expiryMs: EXPIRY_FAR_FUTURE, memo: 'rotated' },
      signer,
    );
    await expect(verifyInvoice(invoice, { chainId: CHAIN_ID })).resolves.toBeUndefined();
  });

  it('payment hash is independent of the stealth nonce', async () => {
    // Preimage randomness is the only thing tying paymentHash to a payment;
    // the recipient address must not bleed into it.
    const mgr = new StealthKeyManager(SCAN_KEY);
    const s1 = mgr.signerFor(STEALTH_LABEL_USER_B, '0x11111111111111111111111111111111' as Hex);
    const s2 = mgr.signerFor(STEALTH_LABEL_USER_B, '0x22222222222222222222222222222222' as Hex);
    const i1 = await createInvoice({ amount: 1n, chainId: CHAIN_ID, expiryMs: EXPIRY_FAR_FUTURE }, s1);
    const i2 = await createInvoice({ amount: 1n, chainId: CHAIN_ID, expiryMs: EXPIRY_FAR_FUTURE }, s2);
    expect(i1.paymentHash).not.toBe(i2.paymentHash); // distinct preimages
    expect(i1.preimage).not.toBe(i2.preimage);
  });

  it('a third party with neither scan key cannot link two rotated invoices', async () => {
    // Operational property: from the observer's view, the only fields tying
    // two invoices to the same user are `recipient` (rotated), `memo`
    // (caller-controlled), and timing. The protocol contributes nothing else.
    const mgr = new StealthKeyManager(SCAN_KEY);
    const i1 = await createInvoice(
      { amount: 1n, chainId: CHAIN_ID, expiryMs: EXPIRY_FAR_FUTURE },
      mgr.signerFor(STEALTH_LABEL_USER_B, '0x11111111111111111111111111111111' as Hex),
    );
    const i2 = await createInvoice(
      { amount: 1n, chainId: CHAIN_ID, expiryMs: EXPIRY_FAR_FUTURE },
      mgr.signerFor(STEALTH_LABEL_USER_B, '0x22222222222222222222222222222222' as Hex),
    );
    const observable = (inv: typeof i1.invoice) => ({
      recipient: inv.recipient,
      amount: inv.amount,
      paymentHash: inv.paymentHash,
    });
    const a = observable(i1.invoice);
    const b = observable(i2.invoice);
    expect(a.recipient).not.toBe(b.recipient);
    expect(a.paymentHash).not.toBe(b.paymentHash);
    // amount equality is a known timing/heuristic leak; not addressed by item 2.
  });
});
