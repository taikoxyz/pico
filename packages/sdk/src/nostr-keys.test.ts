import type { Hex } from '@inferenceroom/pico-protocol';
import { NOSTR_EVENT_KINDS } from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import { NostrEventKeyManager, deriveNostrEventKey } from './nostr-keys.js';

const SCAN_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as Hex;
const OTHER_SCAN_KEY = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as Hex;
const SESSION_1 = '0x11111111111111111111111111111111' as Hex;
const SESSION_2 = '0x22222222222222222222222222222222' as Hex;

describe('deriveNostrEventKey', () => {
  it('is deterministic for the same (scanKey, kind, sessionNonce)', () => {
    const k1 = deriveNostrEventKey(SCAN_KEY, NOSTR_EVENT_KINDS.PaymentQuote, SESSION_1);
    const k2 = deriveNostrEventKey(SCAN_KEY, NOSTR_EVENT_KINDS.PaymentQuote, SESSION_1);
    expect(k1).toBe(k2);
  });

  it('produces a different key per Nostr kind for the same session', () => {
    const quote = deriveNostrEventKey(SCAN_KEY, NOSTR_EVENT_KINDS.PaymentQuote, SESSION_1);
    const invoice = deriveNostrEventKey(SCAN_KEY, NOSTR_EVENT_KINDS.PaymentInvoice, SESSION_1);
    const receipt = deriveNostrEventKey(SCAN_KEY, NOSTR_EVENT_KINDS.PaymentReceipt, SESSION_1);
    expect(quote).not.toBe(invoice);
    expect(quote).not.toBe(receipt);
    expect(invoice).not.toBe(receipt);
  });

  it('produces a different key per session for the same kind', () => {
    const a = deriveNostrEventKey(SCAN_KEY, NOSTR_EVENT_KINDS.PaymentInvoice, SESSION_1);
    const b = deriveNostrEventKey(SCAN_KEY, NOSTR_EVENT_KINDS.PaymentInvoice, SESSION_2);
    expect(a).not.toBe(b);
  });

  it('domain-separates by scan key', () => {
    const a = deriveNostrEventKey(SCAN_KEY, NOSTR_EVENT_KINDS.PaymentInvoice, SESSION_1);
    const b = deriveNostrEventKey(OTHER_SCAN_KEY, NOSTR_EVENT_KINDS.PaymentInvoice, SESSION_1);
    expect(a).not.toBe(b);
  });

  it('returns a valid 32-byte 0x hex string', () => {
    const k = deriveNostrEventKey(SCAN_KEY, NOSTR_EVENT_KINDS.PaymentQuote, SESSION_1);
    expect(k).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('rejects out-of-range kinds', () => {
    expect(() => deriveNostrEventKey(SCAN_KEY, -1, SESSION_1)).toThrow();
    expect(() => deriveNostrEventKey(SCAN_KEY, 0x1_0000_0000, SESSION_1)).toThrow();
  });
});

describe('NostrEventKeyManager.paymentSession', () => {
  it('returns three distinct keys derived from one session nonce', () => {
    const mgr = new NostrEventKeyManager(SCAN_KEY);
    const { quoteKey, invoiceKey, receiptKey } = mgr.paymentSession(SESSION_1);
    expect(quoteKey).not.toBe(invoiceKey);
    expect(quoteKey).not.toBe(receiptKey);
    expect(invoiceKey).not.toBe(receiptKey);
  });

  it('two sessions produce six distinct keys (no cross-session reuse)', () => {
    const mgr = new NostrEventKeyManager(SCAN_KEY);
    const s1 = mgr.paymentSession(SESSION_1);
    const s2 = mgr.paymentSession(SESSION_2);
    const all = new Set([
      s1.quoteKey,
      s1.invoiceKey,
      s1.receiptKey,
      s2.quoteKey,
      s2.invoiceKey,
      s2.receiptKey,
    ]);
    expect(all.size).toBe(6);
  });

  it('signerFor returns a LocalSigner with a stable address per (kind, nonce)', async () => {
    const mgr = new NostrEventKeyManager(SCAN_KEY);
    const s1 = mgr.signerFor(NOSTR_EVENT_KINDS.PaymentInvoice, SESSION_1);
    const s2 = mgr.signerFor(NOSTR_EVENT_KINDS.PaymentInvoice, SESSION_1);
    expect(await s1.address()).toBe(await s2.address());
  });

  it('randomSessionNonce returns 16-byte hex strings', () => {
    const n = NostrEventKeyManager.randomSessionNonce();
    expect(n).toMatch(/^0x[0-9a-f]{32}$/);
  });
});
