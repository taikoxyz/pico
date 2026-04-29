import type { Address, ChainId, Hex, PaymentHash } from './types.js';

export const INVOICE_DOMAIN_NAME = 'tainnel-invoice';
export const INVOICE_DOMAIN_VERSION = '1';

export interface InvoiceDomain {
  readonly name: typeof INVOICE_DOMAIN_NAME;
  readonly version: typeof INVOICE_DOMAIN_VERSION;
  readonly chainId: ChainId;
}

export interface Invoice {
  readonly paymentHash: PaymentHash;
  readonly amount: bigint;
  readonly recipient: Address;
  readonly expiryMs: bigint;
  readonly nonce: Hex;
  readonly memo?: string;
  readonly hubHint?: string;
  readonly signature: Hex;
}

export const INVOICE_TYPES = {
  Invoice: [
    { name: 'paymentHash', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'expiryMs', type: 'uint64' },
    { name: 'nonce', type: 'bytes16' },
    { name: 'memo', type: 'string' },
  ],
} as const;

export function buildInvoiceDomain(chainId: ChainId): InvoiceDomain {
  return {
    name: INVOICE_DOMAIN_NAME,
    version: INVOICE_DOMAIN_VERSION,
    chainId,
  };
}
