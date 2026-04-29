import { existsSync, readFileSync } from 'node:fs';
import type { Hex } from '@tainnel/protocol';
import { decryptPrivateKey, isEncryptedKeyFile, parseKeyFile } from './key-file.js';
import type { Signer } from './signer.js';
import { InMemorySigner } from './signer.test-only.js';

const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export interface LoadLocalSignerOpts {
  readonly privateKey?: Hex;
  readonly env?: NodeJS.ProcessEnv;
  readonly keyFile?: string;
  readonly passphrase?: string | (() => Promise<string> | string);
}

export class LocalSigner extends InMemorySigner {}

export function localSigner(privateKey: Hex): LocalSigner {
  if (!HEX_PRIVATE_KEY.test(privateKey)) {
    throw new Error('localSigner: expected 0x-prefixed 32-byte hex private key');
  }
  return new LocalSigner(privateKey);
}

async function resolvePassphrase(p: LoadLocalSignerOpts['passphrase']): Promise<string> {
  if (typeof p === 'function') return p();
  if (typeof p === 'string') return p;
  throw new Error('loadLocalSigner: encrypted key file requires a passphrase');
}

export async function loadLocalSigner(opts: LoadLocalSignerOpts = {}): Promise<Signer> {
  if (opts.privateKey) {
    return localSigner(opts.privateKey);
  }
  const envPk = opts.env?.TAINNEL_PRIVATE_KEY;
  if (typeof envPk === 'string' && envPk.length > 0) {
    if (!HEX_PRIVATE_KEY.test(envPk)) {
      throw new Error('TAINNEL_PRIVATE_KEY: expected 0x-prefixed 32-byte hex');
    }
    return localSigner(envPk as Hex);
  }
  if (opts.keyFile) {
    if (!existsSync(opts.keyFile)) {
      throw new Error(`loadLocalSigner: key file not found at ${opts.keyFile}`);
    }
    const raw = readFileSync(opts.keyFile, 'utf8').trim();
    if (HEX_PRIVATE_KEY.test(raw)) {
      return localSigner(raw as Hex);
    }
    if (!isEncryptedKeyFile(raw)) {
      throw new Error(`loadLocalSigner: key file ${opts.keyFile} is not a recognized format`);
    }
    const envelope = parseKeyFile(raw);
    const passphrase = await resolvePassphrase(opts.passphrase);
    const pk = decryptPrivateKey(envelope, passphrase);
    return localSigner(pk);
  }
  throw new Error(
    'loadLocalSigner: no key source (set TAINNEL_PRIVATE_KEY, pass {privateKey}, or pass {keyFile})',
  );
}
