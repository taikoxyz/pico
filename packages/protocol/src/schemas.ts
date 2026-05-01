import { ANVIL_DEV_CHAIN_ID, SUPPORTED_CHAIN_IDS } from './constants.js';
import type {
  Address,
  ChainId,
  ChannelId,
  Hex,
  HtlcId,
  PaymentHash,
  Preimage,
  Signature,
} from './types.js';

const HEX_ANY = /^0x[0-9a-fA-F]+$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES65 = /^0x[0-9a-fA-F]{130}$/;

export class WireValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireValidationError';
  }
}

function fail(field: string, msg: string): never {
  throw new WireValidationError(`${field}: ${msg}`);
}

export function parseAddress(value: unknown, field = 'address'): Address {
  if (typeof value !== 'string' || !HEX_ADDRESS.test(value)) {
    fail(field, `must be a 0x-prefixed 20-byte hex address, got ${stringify(value)}`);
  }
  return value as Address;
}

export function parseHex(value: unknown, field = 'hex'): Hex {
  if (typeof value !== 'string' || !HEX_ANY.test(value)) {
    fail(field, `must be a 0x-prefixed hex string, got ${stringify(value)}`);
  }
  return value as Hex;
}

export function parseHex32(value: unknown, field = 'hex32'): Hex {
  if (typeof value !== 'string' || !HEX_BYTES32.test(value)) {
    fail(field, `must be a 0x-prefixed 32-byte hex string, got ${stringify(value)}`);
  }
  return value as Hex;
}

export function parseChannelId(value: unknown, field = 'channelId'): ChannelId {
  return parseHex32(value, field) as ChannelId;
}

export function parseHtlcId(value: unknown, field = 'htlcId'): HtlcId {
  return parseHex32(value, field) as HtlcId;
}

export function parsePaymentHash(value: unknown, field = 'paymentHash'): PaymentHash {
  return parseHex32(value, field) as PaymentHash;
}

export function parsePreimage(value: unknown, field = 'preimage'): Preimage {
  return parseHex32(value, field) as Preimage;
}

export function parseChainId(value: unknown, field = 'chainId'): ChainId {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(field, `must be a positive integer, got ${stringify(value)}`);
  }
  if (value !== ANVIL_DEV_CHAIN_ID && !(SUPPORTED_CHAIN_IDS as readonly number[]).includes(value)) {
    fail(field, `chainId ${value} is not in SUPPORTED_CHAIN_IDS`);
  }
  return value as ChainId;
}

export function parseBigIntNonNegative(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) fail(field, `must be non-negative, got ${value}`);
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    let v: bigint;
    try {
      v = BigInt(value);
    } catch {
      fail(field, `cannot parse as bigint: ${stringify(value)}`);
    }
    if (v < 0n) fail(field, `must be non-negative, got ${v}`);
    return v;
  }
  return fail(field, `must be a bigint, string, or number; got ${typeof value}`);
}

export function parseBigIntPositive(value: unknown, field: string): bigint {
  const v = parseBigIntNonNegative(value, field);
  if (v === 0n) fail(field, 'must be positive (got zero)');
  return v;
}

export function parseSignatureCompact(value: unknown, field = 'signature'): Hex {
  // Compact 65-byte EIP-2098 form (r || s || v).
  if (typeof value !== 'string' || !HEX_BYTES65.test(value)) {
    fail(field, `must be a 0x-prefixed 65-byte hex string, got ${stringify(value)}`);
  }
  return value as Hex;
}

export function parseSignatureRSV(value: unknown, field = 'signature'): Signature {
  if (!value || typeof value !== 'object') {
    fail(field, `must be an object {r, s, v}, got ${stringify(value)}`);
  }
  const obj = value as Record<string, unknown>;
  return {
    r: parseHex32(obj.r, `${field}.r`),
    s: parseHex32(obj.s, `${field}.s`),
    v: parseV(obj.v, `${field}.v`),
  };
}

function parseV(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(field, `must be an integer (27, 28, 0, or 1), got ${stringify(value)}`);
  }
  if (value !== 27 && value !== 28 && value !== 0 && value !== 1) {
    fail(field, `must be 27, 28, 0, or 1; got ${value}`);
  }
  return value;
}

function stringify(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
