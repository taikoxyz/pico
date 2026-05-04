import {
  type Address,
  type ChainId,
  type Hex,
  INVOICE_TYPES,
  type Invoice,
  type InvoiceDomain,
  buildInvoiceDomain,
} from '@pico/protocol';
import { hashTypedData, recoverTypedDataAddress } from 'viem';

export interface InvoiceTypedData {
  readonly domain: InvoiceDomain;
  readonly types: typeof INVOICE_TYPES;
  readonly primaryType: 'Invoice';
  readonly message: {
    readonly paymentHash: Hex;
    readonly amount: bigint;
    readonly recipient: Address;
    readonly expiryMs: bigint;
    readonly nonce: Hex;
    readonly memo: string;
  };
}

export function buildInvoiceTypedData(invoice: Invoice, chainId: ChainId): InvoiceTypedData {
  return {
    domain: buildInvoiceDomain(chainId),
    types: INVOICE_TYPES,
    primaryType: 'Invoice',
    message: {
      paymentHash: invoice.paymentHash,
      amount: invoice.amount,
      recipient: invoice.recipient,
      expiryMs: invoice.expiryMs,
      nonce: invoice.nonce,
      memo: invoice.memo ?? '',
    },
  };
}

export function hashInvoice(invoice: Invoice, chainId: ChainId): Hex {
  return hashTypedData(buildInvoiceTypedData(invoice, chainId));
}

export async function verifyInvoiceSignature(
  invoice: Invoice,
  expectedSigner: Address,
  chainId: ChainId,
): Promise<boolean> {
  const data = buildInvoiceTypedData(invoice, chainId);
  const recovered = await recoverTypedDataAddress({ ...data, signature: invoice.signature });
  return (recovered as Address).toLowerCase() === expectedSigner.toLowerCase();
}
