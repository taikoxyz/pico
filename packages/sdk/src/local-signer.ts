import { existsSync, readFileSync } from 'node:fs';
import type {
  Address,
  ChainId,
  ChannelState,
  CooperativeClose,
  Hex,
  Htlc,
  Invoice,
} from '@tainnel/protocol';
import {
  buildChannelStateTypedData,
  buildCooperativeCloseTypedData,
  buildHtlcTypedData,
  buildInvoiceTypedData,
  buildUpdateTypedData,
} from '@tainnel/state-machine';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { decryptPrivateKey, isEncryptedKeyFile, parseKeyFile } from './key-file.js';
import type { Signer } from './signer.js';

const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export interface LoadLocalSignerOpts {
  readonly privateKey?: Hex;
  readonly env?: NodeJS.ProcessEnv;
  readonly keyFile?: string;
  readonly passphrase?: string | (() => Promise<string> | string);
}

/**
 * Production-grade hot-key signer for the SDK. Holds a `PrivateKeyAccount`
 * directly (no longer subclasses the test-only InMemorySigner) so the
 * production custody surface is independent of test utilities.
 *
 * For higher-assurance key custody, implement the `Signer` interface against
 * a KMS / Nitro Enclave / Turnkey backend (Phase 2).
 */
export class LocalSigner implements Signer {
  private readonly account: PrivateKeyAccount;

  constructor(privateKey: Hex) {
    if (!HEX_PRIVATE_KEY.test(privateKey)) {
      throw new Error('LocalSigner: expected 0x-prefixed 32-byte hex private key');
    }
    this.account = privateKeyToAccount(privateKey);
  }

  async address(): Promise<Address> {
    return this.account.address;
  }

  addressSync(): Address {
    return this.account.address;
  }

  signChannelState(
    state: ChannelState,
    chainId: ChainId,
    verifyingContract: Address,
  ): Promise<Hex> {
    return this.account.signTypedData(
      buildChannelStateTypedData(state, chainId, verifyingContract),
    );
  }

  signUpdate(
    update: import('@tainnel/protocol').Update,
    chainId: ChainId,
    verifyingContract: Address,
  ): Promise<Hex> {
    return this.account.signTypedData(buildUpdateTypedData(update, chainId, verifyingContract));
  }

  signCooperativeClose(
    close: CooperativeClose,
    chainId: ChainId,
    verifyingContract: Address,
  ): Promise<Hex> {
    return this.account.signTypedData(
      buildCooperativeCloseTypedData(close, chainId, verifyingContract),
    );
  }

  signHtlc(htlc: Htlc, chainId: ChainId, verifyingContract: Address): Promise<Hex> {
    return this.account.signTypedData(buildHtlcTypedData(htlc, chainId, verifyingContract));
  }

  signInvoice(invoice: Omit<Invoice, 'signature'>, chainId: ChainId): Promise<Hex> {
    const fullInvoice: Invoice = { ...invoice, signature: '0x' };
    return this.account.signTypedData(buildInvoiceTypedData(fullInvoice, chainId));
  }
}

export function localSigner(privateKey: Hex): LocalSigner {
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
