import {
  type ChannelState,
  type CooperativeClose,
  type Htlc,
  TAIKO_MAINNET_CHAIN_ID,
  type Update,
} from '@tainnel/protocol';
import {
  verifyChannelStateSignature,
  verifyCooperativeCloseSignature,
  verifyHtlcSignature,
  verifyInvoiceSignature,
  verifyUpdateSignature,
} from '@tainnel/state-machine';
import { InMemorySigner } from '@tainnel/test-utils';
import { describe, expect, it } from 'vitest';

const PRIVATE_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const VERIFYING_CONTRACT = '0x07B32f52523Fdf0780821595422DccEF31FA2335' as const;
const CHAIN_ID = TAIKO_MAINNET_CHAIN_ID;

const baseState: ChannelState = {
  channelId: '0x0000000000000000000000000000000000000000000000000000000000000001',
  version: 1n,
  balanceA: 100n,
  balanceB: 50n,
  htlcs: [],
  finalized: false,
};

const baseHtlc: Htlc = {
  id: '0x0000000000000000000000000000000000000000000000000000000000000777',
  direction: 'AtoB',
  amount: 10n,
  paymentHash: '0xabababababababababababababababababababababababababababababababab',
  expiryMs: 1_800_000_000_000n,
};

const baseUpdate: Update = {
  channelId: baseState.channelId,
  fromVersion: 1n,
  toVersion: 2n,
  nextState: { ...baseState, version: 2n, balanceA: 90n, balanceB: 60n },
};

const baseClose: CooperativeClose = {
  channelId: baseState.channelId,
  finalBalanceA: 100n,
  finalBalanceB: 50n,
  signedAt: 1_700_000_000n,
};

describe('InMemorySigner', () => {
  it('exposes the address derived from the private key', async () => {
    const signer = new InMemorySigner(PRIVATE_KEY);
    const addr = await signer.address();
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(signer.addressSync()).toBe(addr);
  });

  it('signChannelState produces a signature recoverable to the signer', async () => {
    const signer = new InMemorySigner(PRIVATE_KEY);
    const sig = await signer.signChannelState(baseState, CHAIN_ID, VERIFYING_CONTRACT);
    const ok = await verifyChannelStateSignature(
      baseState,
      sig,
      await signer.address(),
      CHAIN_ID,
      VERIFYING_CONTRACT,
    );
    expect(ok).toBe(true);
  });

  it('signHtlc round-trips', async () => {
    const signer = new InMemorySigner(PRIVATE_KEY);
    const sig = await signer.signHtlc(baseHtlc, CHAIN_ID, VERIFYING_CONTRACT);
    expect(
      await verifyHtlcSignature(
        baseHtlc,
        sig,
        await signer.address(),
        CHAIN_ID,
        VERIFYING_CONTRACT,
      ),
    ).toBe(true);
  });

  it('signUpdate round-trips', async () => {
    const signer = new InMemorySigner(PRIVATE_KEY);
    const sig = await signer.signUpdate(baseUpdate, CHAIN_ID, VERIFYING_CONTRACT);
    expect(
      await verifyUpdateSignature(
        baseUpdate,
        sig,
        await signer.address(),
        CHAIN_ID,
        VERIFYING_CONTRACT,
      ),
    ).toBe(true);
  });

  it('signCooperativeClose round-trips', async () => {
    const signer = new InMemorySigner(PRIVATE_KEY);
    const sig = await signer.signCooperativeClose(baseClose, CHAIN_ID, VERIFYING_CONTRACT);
    expect(
      await verifyCooperativeCloseSignature(
        baseClose,
        sig,
        await signer.address(),
        CHAIN_ID,
        VERIFYING_CONTRACT,
      ),
    ).toBe(true);
  });

  it('signInvoice produces an invoice signature recoverable to the signer', async () => {
    const signer = new InMemorySigner(PRIVATE_KEY);
    const recipient = await signer.address();
    const partial = {
      paymentHash: '0xabababababababababababababababababababababababababababababababab' as const,
      amount: 1000n,
      recipient,
      expiryMs: 9_999_999_999_999n,
      nonce: '0x000102030405060708090a0b0c0d0e0f' as const,
    };
    const signature = await signer.signInvoice(partial, CHAIN_ID);
    const invoice = { ...partial, signature };
    expect(await verifyInvoiceSignature(invoice, recipient, CHAIN_ID)).toBe(true);
  });
});
