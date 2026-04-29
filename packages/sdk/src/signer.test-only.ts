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
import {
  buildChannelStateTypedData,
  buildCooperativeCloseTypedData,
  buildHtlcTypedData,
  buildInvoiceTypedData,
  buildUpdateTypedData,
} from '@tainnel/state-machine';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import type { Signer } from './signer.js';

export class InMemorySigner implements Signer {
  private readonly account: PrivateKeyAccount;

  constructor(privateKey: Hex) {
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

  signUpdate(update: Update, chainId: ChainId, verifyingContract: Address): Promise<Hex> {
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
