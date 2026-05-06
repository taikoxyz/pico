import {
  type Invoice,
  WireValidationError,
  parseAddress,
  parseBigIntPositive,
  parseHex32,
  parseHex as parseHexProto,
} from '@inferenceroom/pico-protocol';

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

const PREFIX = 'pico1:';

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
  let json: string;
  try {
    json = Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8');
  } catch {
    throw new Error('invoice envelope: invalid base64url payload');
  }
  let wire: unknown;
  try {
    wire = JSON.parse(json);
  } catch {
    throw new Error('invoice envelope: payload is not valid JSON');
  }
  if (!wire || typeof wire !== 'object') {
    throw new Error('invoice envelope: payload is not an object');
  }
  const w = wire as Record<string, unknown>;
  if (w.v !== 1) throw new Error(`invoice envelope: unsupported version ${stringify(w.v)}`);
  try {
    const out: Invoice = {
      paymentHash: parseHex32(w.paymentHash, 'paymentHash') as Invoice['paymentHash'],
      amount: parseBigIntPositive(w.amount, 'amount'),
      recipient: parseAddress(w.recipient, 'recipient'),
      expiryMs: parseBigIntPositive(w.expiryMs, 'expiryMs'),
      // Invoice nonces are 16 bytes (32 hex chars); allow any hex length
      // here so that historical envelopes still parse, but reject
      // non-hex/empty values.
      nonce: parseHexProto(w.nonce, 'nonce') as Invoice['nonce'],
      signature: parseHexProto(w.signature, 'signature') as Invoice['signature'],
      ...(typeof w.memo === 'string' ? { memo: w.memo } : {}),
      ...(typeof w.hubHint === 'string' ? { hubHint: w.hubHint } : {}),
    };
    return out;
  } catch (err) {
    if (err instanceof WireValidationError) {
      throw new Error(`invoice envelope: ${err.message}`);
    }
    throw err;
  }
}

function stringify(v: unknown): string {
  if (typeof v === 'bigint') return `${v}n`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
