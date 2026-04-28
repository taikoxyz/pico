import {
  CHANNEL_STATE_TYPES,
  type ChannelState,
  TAIKO_HOODI_CHAIN_ID,
  buildDomain,
} from '@tainnel/protocol';
import { hashChannelState, verifyChannelStateSignature } from '@tainnel/state-machine';
import { http, type Hex, createWalletClient, custom, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { taiko } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { WalletError } from './errors.js';
import { ViemWalletAdapter } from './wallet.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const account = privateKeyToAccount(PK);
const channelId = '0x0000000000000000000000000000000000000000000000000000000000000abc' as const;
const verifyingContract = '0x1111111111111111111111111111111111111111' as const;

function makeState(): ChannelState {
  return {
    channelId,
    version: 1n,
    balanceA: 100n,
    balanceB: 200n,
    htlcs: [],
    finalized: false,
  };
}

describe('ViemWalletAdapter', () => {
  it('returns the configured account address', async () => {
    const wc = createWalletClient({ account, chain: taiko, transport: http() });
    const adapter = new ViemWalletAdapter({ walletClient: wc });
    expect((await adapter.getAddress()).toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('explicit account override takes precedence over walletClient.account', async () => {
    const otherAccount = privateKeyToAccount(
      '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    );
    const wc = createWalletClient({ account, chain: taiko, transport: http() });
    const adapter = new ViemWalletAdapter({ walletClient: wc, account: otherAccount });
    expect((await adapter.getAddress()).toLowerCase()).toBe(otherAccount.address.toLowerCase());
  });

  it('signTypedData produces a signature recoverable to the signer', async () => {
    const wc = createWalletClient({ account, chain: taiko, transport: http() });
    const adapter = new ViemWalletAdapter({ walletClient: wc });
    const state = makeState();
    const domain = buildDomain(TAIKO_HOODI_CHAIN_ID, verifyingContract);
    const sig = (await adapter.signTypedData({
      domain: { chainId: domain.chainId, verifyingContract },
      types: CHANNEL_STATE_TYPES,
      primaryType: 'ChannelState',
      message: {
        channelId: state.channelId,
        version: state.version,
        balanceA: state.balanceA,
        balanceB: state.balanceB,
        htlcsRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
        finalized: state.finalized,
      },
    })) as Hex;
    const ok = await verifyChannelStateSignature(
      state,
      sig,
      account.address,
      TAIKO_HOODI_CHAIN_ID,
      verifyingContract,
    );
    expect(ok).toBe(true);
  });

  it('signTypedData digest matches state-machine hashChannelState', async () => {
    const state = makeState();
    const expected = hashChannelState(state, TAIKO_HOODI_CHAIN_ID, verifyingContract);
    expect(expected).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('signMessage produces a signature recoverable to the signer', async () => {
    const wc = createWalletClient({ account, chain: taiko, transport: http() });
    const adapter = new ViemWalletAdapter({ walletClient: wc });
    const message = 'hello tainnel';
    const sig = (await adapter.signMessage(message)) as Hex;
    const recovered = await recoverMessageAddress({ message, signature: sig });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('throws WalletError when the wallet has no accounts and no override', async () => {
    const transport = custom({
      request: async ({ method }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [];
        return null;
      },
    });
    const wc = createWalletClient({ chain: taiko, transport });
    const adapter = new ViemWalletAdapter({ walletClient: wc });
    await expect(adapter.getAddress()).rejects.toBeInstanceOf(WalletError);
  });
});
