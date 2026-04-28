import type { Address, Hex } from '@tainnel/protocol';
import type { Account, WalletClient } from 'viem';
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
