import type { Address, ChainId, Invoice, PaymentHash, Preimage } from '@tainnel/protocol';
import { preimageDigest, verifyInvoiceSignature } from '@tainnel/state-machine';
import { randomNonce16, randomPreimage } from './crypto.js';
import { InvoiceExpiredError, InvoiceVerificationError } from './errors.js';
import type { Signer } from './signer.js';

export interface CreateInvoiceArgs {
  readonly amount: bigint;
  readonly chainId: ChainId;
  readonly expiryMs: bigint;
  readonly memo?: string;
  readonly hubHint?: string;
}

export interface CreatedInvoice {
  readonly invoice: Invoice;
  readonly preimage: Preimage;
  readonly paymentHash: PaymentHash;
}

export async function createInvoice(
  args: CreateInvoiceArgs,
  signer: Signer,
): Promise<CreatedInvoice> {
  const preimage = randomPreimage();
  const paymentHash = preimageDigest(preimage);
  const recipient = await signer.address();
  const nonce = randomNonce16();
  const partial: Omit<Invoice, 'signature'> = {
    paymentHash,
    amount: args.amount,
    recipient,
    expiryMs: args.expiryMs,
    nonce,
    ...(args.memo !== undefined ? { memo: args.memo } : {}),
    ...(args.hubHint !== undefined ? { hubHint: args.hubHint } : {}),
  };
  const signature = await signer.signInvoice(partial, args.chainId);
  return { invoice: { ...partial, signature }, preimage, paymentHash };
}

export interface VerifyInvoiceOptions {
  readonly chainId: ChainId;
  readonly expectedRecipient?: Address;
  readonly nowMs?: bigint;
}

export async function verifyInvoice(invoice: Invoice, opts: VerifyInvoiceOptions): Promise<void> {
  const now = opts.nowMs ?? BigInt(Date.now());
  if (invoice.expiryMs <= now) {
    throw new InvoiceExpiredError(invoice.expiryMs, now);
  }
  if (
    opts.expectedRecipient &&
    invoice.recipient.toLowerCase() !== opts.expectedRecipient.toLowerCase()
  ) {
    throw new InvoiceVerificationError('recipient mismatch');
  }
  const ok = await verifyInvoiceSignature(invoice, invoice.recipient, opts.chainId);
  if (!ok) throw new InvoiceVerificationError('signature does not match recipient');
}
