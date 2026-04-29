import type {
  Address,
  ChainId,
  ChannelState,
  CooperativeClose,
  Hex,
  Htlc,
  Invoice,
  Update,
} from '@tainnel/protocol';

export interface Signer {
  address(): Promise<Address>;
  signChannelState(state: ChannelState, chainId: ChainId, verifyingContract: Address): Promise<Hex>;
  signUpdate(update: Update, chainId: ChainId, verifyingContract: Address): Promise<Hex>;
  signCooperativeClose(
    close: CooperativeClose,
    chainId: ChainId,
    verifyingContract: Address,
  ): Promise<Hex>;
  signHtlc(htlc: Htlc, chainId: ChainId, verifyingContract: Address): Promise<Hex>;
  signInvoice(invoice: Omit<Invoice, 'signature'>, chainId: ChainId): Promise<Hex>;
}
