import type { Address, Hex } from '@tainnel/protocol';
import type { Account, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { WalletError } from './errors.js';

export interface SignTypedDataArgs {
  readonly domain: { readonly chainId: number; readonly verifyingContract: Address };
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

export interface WalletAdapter {
  getAddress(): Promise<Address>;
  signTypedData(args: SignTypedDataArgs): Promise<Hex>;
  signMessage(message: string): Promise<Hex>;
}

export interface ViemWalletAdapterOptions {
  readonly walletClient: WalletClient;
  readonly account?: Account | Address;
}

export class ViemWalletAdapter implements WalletAdapter {
  private readonly walletClient: WalletClient;
  private readonly account: Account | Address | undefined;

  constructor(opts: ViemWalletAdapterOptions) {
    this.walletClient = opts.walletClient;
    this.account = opts.account;
  }

  async getAddress(): Promise<Address> {
    const acct = this.resolveAccount();
    if (acct) {
      if (typeof acct === 'string') return acct;
      return acct.address;
    }
    try {
      const addrs = await this.walletClient.getAddresses();
      const first = addrs[0];
      if (!first) throw new WalletError('wallet client has no accounts', 'NO_ACCOUNTS');
      return first;
    } catch (err) {
      if (err instanceof WalletError) throw err;
      throw new WalletError(
        `wallet client has no accounts: ${(err as Error).message}`,
        'NO_ACCOUNTS',
      );
    }
  }

  async signTypedData(args: SignTypedDataArgs): Promise<Hex> {
    const account = this.resolveAccount() ?? (await this.getAddress());
    return this.walletClient.signTypedData({
      account,
      domain: {
        name: 'tainnel',
        version: '1',
        chainId: args.domain.chainId,
        verifyingContract: args.domain.verifyingContract,
      },
      types: args.types as Parameters<WalletClient['signTypedData']>[0]['types'],
      primaryType: args.primaryType,
      message: args.message,
    } as Parameters<WalletClient['signTypedData']>[0]);
  }

  async signMessage(message: string): Promise<Hex> {
    const account = this.resolveAccount() ?? (await this.getAddress());
    return this.walletClient.signMessage({ account, message });
  }

  private resolveAccount(): Account | Address | undefined {
    if (this.account) return this.account;
    return this.walletClient.account;
  }
}

export interface PrivateKeyWalletAdapterOptions {
  readonly privateKey: Hex;
}

export class PrivateKeyWalletAdapter implements WalletAdapter {
  readonly privateKey: Hex;
  private readonly account: Account;

  constructor(opts: PrivateKeyWalletAdapterOptions) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(opts.privateKey)) {
      throw new WalletError('private key must be 0x + 64 hex chars', 'INVALID_PRIVATE_KEY');
    }
    this.privateKey = opts.privateKey;
    this.account = privateKeyToAccount(opts.privateKey);
  }

  async getAddress(): Promise<Address> {
    return this.account.address;
  }

  async signTypedData(args: SignTypedDataArgs): Promise<Hex> {
    if (!this.account.signTypedData) {
      throw new WalletError('account does not support signTypedData', 'SIGN_TYPED_DATA_FAILED');
    }
    return this.account.signTypedData({
      domain: {
        name: 'tainnel',
        version: '1',
        chainId: args.domain.chainId,
        verifyingContract: args.domain.verifyingContract,
      },
      types: args.types as Parameters<NonNullable<Account['signTypedData']>>[0]['types'],
      primaryType: args.primaryType,
      message: args.message,
    } as Parameters<NonNullable<Account['signTypedData']>>[0]);
  }

  async signMessage(message: string): Promise<Hex> {
    if (!this.account.signMessage) {
      throw new WalletError('account does not support signMessage', 'SIGN_MESSAGE_FAILED');
    }
    return this.account.signMessage({ message });
  }
}

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface BrowserWalletAdapterOptions {
  readonly provider: Eip1193Provider;
  readonly account?: Address;
  readonly autoConnect?: boolean;
}

export class BrowserWalletAdapter implements WalletAdapter {
  private readonly provider: Eip1193Provider;
  private accountOverride: Address | undefined;
  private readonly autoConnect: boolean;

  constructor(opts: BrowserWalletAdapterOptions) {
    this.provider = opts.provider;
    this.accountOverride = opts.account;
    this.autoConnect = opts.autoConnect ?? true;
  }

  async getAddress(): Promise<Address> {
    if (this.accountOverride) return this.accountOverride;
    const accounts = await this.requestAccounts('eth_accounts');
    if (accounts[0]) {
      this.accountOverride = accounts[0];
      return accounts[0];
    }
    if (!this.autoConnect) {
      throw new WalletError('no accounts; provider has not connected any', 'NO_ACCOUNTS');
    }
    const requested = await this.requestAccounts('eth_requestAccounts');
    const first = requested[0];
    if (!first) {
      throw new WalletError('user rejected eth_requestAccounts', 'NO_ACCOUNTS');
    }
    this.accountOverride = first;
    return first;
  }

  async signTypedData(args: SignTypedDataArgs): Promise<Hex> {
    const address = await this.getAddress();
    const payload = JSON.stringify({
      domain: {
        name: 'tainnel',
        version: '1',
        chainId: args.domain.chainId,
        verifyingContract: args.domain.verifyingContract,
      },
      message: serializeTypedDataMessage(args.message),
      primaryType: args.primaryType,
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        ...args.types,
      },
    });
    try {
      const sig = await this.provider.request({
        method: 'eth_signTypedData_v4',
        params: [address, payload],
      });
      return sig as Hex;
    } catch (err) {
      throw new WalletError(
        `eth_signTypedData_v4 failed: ${(err as Error).message}`,
        'SIGN_TYPED_DATA_FAILED',
      );
    }
  }

  async signMessage(message: string): Promise<Hex> {
    const address = await this.getAddress();
    try {
      const sig = await this.provider.request({
        method: 'personal_sign',
        params: [message, address],
      });
      return sig as Hex;
    } catch (err) {
      throw new WalletError(
        `personal_sign failed: ${(err as Error).message}`,
        'SIGN_MESSAGE_FAILED',
      );
    }
  }

  private async requestAccounts(
    method: 'eth_accounts' | 'eth_requestAccounts',
  ): Promise<Address[]> {
    try {
      const res = (await this.provider.request({ method })) as Address[] | null | undefined;
      return Array.isArray(res) ? res : [];
    } catch (err) {
      throw new WalletError(`${method} failed: ${(err as Error).message}`, 'NO_ACCOUNTS');
    }
  }
}

function serializeTypedDataMessage(message: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(message)) {
    out[k] = serializeTypedDataValue(v);
  }
  return out;
}

function serializeTypedDataValue(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(serializeTypedDataValue);
  if (v !== null && typeof v === 'object') {
    return serializeTypedDataMessage(v as Record<string, unknown>);
  }
  return v;
}
