import type { Hex } from '@inferenceroom/pico-protocol';
import { NOSTR_EVENT_KINDS, type NostrEventKind } from '@inferenceroom/pico-protocol';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from './crypto.js';
import { LocalSigner } from './local-signer.js';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const LABEL = 'pico-nostr-event-key';
const MAX_RETRIES = 256;

function bytesToBigInt(buf: Uint8Array): bigint {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

function encodeKindBE(kind: number): Uint8Array {
  if (!Number.isInteger(kind) || kind < 0 || kind > 0xffffffff) {
    throw new Error(`deriveNostrEventKey: invalid kind ${kind}`);
  }
  return Uint8Array.of(
    (kind >>> 24) & 0xff,
    (kind >>> 16) & 0xff,
    (kind >>> 8) & 0xff,
    kind & 0xff,
  );
}

function encodeMessage(kind: number, sessionNonce: Hex, counter: number): Uint8Array {
  const labelBytes = new TextEncoder().encode(LABEL);
  const kindBytes = encodeKindBE(kind);
  const nonceBytes = hexToBytes(sessionNonce);
  const out = new Uint8Array(labelBytes.length + 1 + kindBytes.length + 1 + nonceBytes.length + 1);
  let o = 0;
  out.set(labelBytes, o);
  o += labelBytes.length;
  out[o++] = 0x00;
  out.set(kindBytes, o);
  o += kindBytes.length;
  out[o++] = 0x00;
  out.set(nonceBytes, o);
  o += nonceBytes.length;
  out[o] = counter & 0xff;
  return out;
}

/**
 * Derive a per-event Nostr private key from a master scan key, a Nostr event
 * kind, and a per-session nonce. Used so that PaymentQuote / PaymentInvoice /
 * PaymentReceipt for the same payment use distinct Nostr pubkeys and a relay
 * cannot trivially cluster a payment from public event metadata.
 */
export function deriveNostrEventKey(
  scanKey: Hex,
  kind: NostrEventKind | number,
  sessionNonce: Hex,
): Hex {
  const key = hexToBytes(scanKey);
  if (key.length !== 32) throw new Error('deriveNostrEventKey: scanKey must be 32 bytes');
  for (let i = 0; i < MAX_RETRIES; i++) {
    const out = hmac(sha256, key, encodeMessage(kind, sessionNonce, i));
    const scalar = bytesToBigInt(out);
    if (scalar > 0n && scalar < SECP256K1_N) {
      return bytesToHex(out);
    }
  }
  throw new Error('deriveNostrEventKey: exhausted retries');
}

export class NostrEventKeyManager {
  constructor(private readonly scanKey: Hex) {
    if (hexToBytes(scanKey).length !== 32) {
      throw new Error('NostrEventKeyManager: scanKey must be 32 bytes');
    }
  }

  privateKey(kind: NostrEventKind | number, sessionNonce: Hex): Hex {
    return deriveNostrEventKey(this.scanKey, kind, sessionNonce);
  }

  signerFor(kind: NostrEventKind | number, sessionNonce: Hex): LocalSigner {
    return new LocalSigner(this.privateKey(kind, sessionNonce));
  }

  /**
   * Derive the trio of keys used together for a single payment session:
   * quote, invoice, receipt. Three different pubkeys, one shared session.
   */
  paymentSession(sessionNonce: Hex): {
    quoteKey: Hex;
    invoiceKey: Hex;
    receiptKey: Hex;
  } {
    return {
      quoteKey: this.privateKey(NOSTR_EVENT_KINDS.PaymentQuote, sessionNonce),
      invoiceKey: this.privateKey(NOSTR_EVENT_KINDS.PaymentInvoice, sessionNonce),
      receiptKey: this.privateKey(NOSTR_EVENT_KINDS.PaymentReceipt, sessionNonce),
    };
  }

  static randomSessionNonce(): Hex {
    return bytesToHex(randomBytes(16));
  }
}
