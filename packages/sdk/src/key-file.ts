import { scrypt } from '@noble/hashes/scrypt';
import type { Address, Hex } from '@pico/protocol';
import nacl from 'tweetnacl';
import { privateKeyToAccount } from 'viem/accounts';
import { bytesToHex, hexToBytes, randomBytes } from './crypto.js';

export interface ScryptParams {
  readonly name: 'scrypt';
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Hex;
}

export interface CipherParams {
  readonly name: 'xsalsa20-poly1305';
  readonly nonce: Hex;
  readonly ciphertext: Hex;
}

export interface KeyFileEnvelope {
  readonly version: 1;
  readonly address: Address;
  readonly kdf: ScryptParams;
  readonly cipher: CipherParams;
}

export interface ScryptOpts {
  readonly N?: number;
  readonly r?: number;
  readonly p?: number;
}

const DEFAULT_N = 1 << 17;
const DEFAULT_R = 8;
const DEFAULT_P = 1;

const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

function deriveKey(passphrase: string, params: ScryptParams): Uint8Array {
  const salt = hexToBytes(params.salt);
  return scrypt(new TextEncoder().encode(passphrase), salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: nacl.secretbox.keyLength,
  });
}

export function encryptPrivateKey(
  privateKey: Hex,
  passphrase: string,
  opts: ScryptOpts = {},
): KeyFileEnvelope {
  if (!HEX_PRIVATE_KEY.test(privateKey)) {
    throw new Error('encryptPrivateKey: expected 0x-prefixed 32-byte hex');
  }
  const N = opts.N ?? DEFAULT_N;
  const r = opts.r ?? DEFAULT_R;
  const p = opts.p ?? DEFAULT_P;
  const salt = randomBytes(16);
  const nonce = randomBytes(nacl.secretbox.nonceLength);
  const kdf: ScryptParams = { name: 'scrypt', N, r, p, salt: bytesToHex(salt) };
  const key = deriveKey(passphrase, kdf);
  const plaintext = hexToBytes(privateKey);
  const ciphertext = nacl.secretbox(plaintext, nonce, key);
  return {
    version: 1,
    address: privateKeyToAccount(privateKey).address as Address,
    kdf,
    cipher: {
      name: 'xsalsa20-poly1305',
      nonce: bytesToHex(nonce),
      ciphertext: bytesToHex(ciphertext),
    },
  };
}

export function decryptPrivateKey(envelope: KeyFileEnvelope, passphrase: string): Hex {
  if (envelope.version !== 1) {
    throw new Error(`decryptPrivateKey: unsupported version ${envelope.version}`);
  }
  if (envelope.kdf.name !== 'scrypt') {
    throw new Error(`decryptPrivateKey: unsupported kdf ${envelope.kdf.name}`);
  }
  if (envelope.cipher.name !== 'xsalsa20-poly1305') {
    throw new Error(`decryptPrivateKey: unsupported cipher ${envelope.cipher.name}`);
  }
  const key = deriveKey(passphrase, envelope.kdf);
  const nonce = hexToBytes(envelope.cipher.nonce);
  const ciphertext = hexToBytes(envelope.cipher.ciphertext);
  const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
  if (!plaintext) {
    throw new Error('decryptPrivateKey: bad passphrase or corrupt key file');
  }
  if (plaintext.length !== 32) {
    throw new Error('decryptPrivateKey: bad plaintext length');
  }
  return bytesToHex(plaintext);
}

export function serializeKeyFile(envelope: KeyFileEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function parseKeyFile(json: string): KeyFileEnvelope {
  const obj = JSON.parse(json) as unknown;
  if (typeof obj !== 'object' || obj === null) throw new Error('parseKeyFile: not an object');
  const e = obj as Partial<KeyFileEnvelope>;
  if (e.version !== 1) throw new Error('parseKeyFile: unsupported version');
  if (!e.address || !e.kdf || !e.cipher) throw new Error('parseKeyFile: missing fields');
  return e as KeyFileEnvelope;
}

export function isEncryptedKeyFile(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const obj = JSON.parse(trimmed) as Partial<KeyFileEnvelope>;
    return obj.version === 1 && !!obj.kdf && !!obj.cipher;
  } catch {
    return false;
  }
}
