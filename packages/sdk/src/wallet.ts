import type { Address, Hex } from '@tainnel/protocol';

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
