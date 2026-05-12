import type {
  Address,
  ChainId,
  ChannelState,
  CooperativeClose,
  Hex,
  Htlc,
  Invoice,
  Update,
} from '@inferenceroom/pico-protocol';

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
  /// Raw secp256k1 signature over a 32-byte digest (no EIP-191 prefix). Used
  /// by the WS transport to sign envelope digests; the hub recovers the
  /// signer with viem's `recoverAddress({ hash, signature })`.
  signEnvelope(digest: Hex): Promise<Hex>;
}
