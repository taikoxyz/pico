import type { Invoice } from '@tainnel/protocol';

interface InvoiceWire {
  v: 1;
  paymentHash: string;
  amount: string;
  recipient: string;
  expiryMs: string;
  nonce: string;
  memo?: string;
  hubHint?: string;
  signature: string;
}

const PREFIX = 'tainnel1:';

export function encodeInvoiceEnvelope(invoice: Invoice): string {
  const wire: InvoiceWire = {
    v: 1,
    paymentHash: invoice.paymentHash,
    amount: invoice.amount.toString(),
    recipient: invoice.recipient,
    expiryMs: invoice.expiryMs.toString(),
    nonce: invoice.nonce,
    signature: invoice.signature,
    ...(invoice.memo !== undefined ? { memo: invoice.memo } : {}),
    ...(invoice.hubHint !== undefined ? { hubHint: invoice.hubHint } : {}),
  };
  return PREFIX + Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}

export function decodeInvoiceEnvelope(text: string): Invoice {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error('invoice envelope: bad prefix');
  const json = Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8');
  const wire = JSON.parse(json) as InvoiceWire;
  if (wire.v !== 1) throw new Error(`invoice envelope: unsupported version ${wire.v}`);
  const out: Invoice = {
    paymentHash: wire.paymentHash as Invoice['paymentHash'],
    amount: BigInt(wire.amount),
    recipient: wire.recipient as Invoice['recipient'],
    expiryMs: BigInt(wire.expiryMs),
    nonce: wire.nonce as Invoice['nonce'],
    signature: wire.signature as Invoice['signature'],
    ...(wire.memo !== undefined ? { memo: wire.memo } : {}),
    ...(wire.hubHint !== undefined ? { hubHint: wire.hubHint } : {}),
  };
  return out;
}
