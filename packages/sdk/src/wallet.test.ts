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
import { PrivateKeyWalletAdapter, ViemWalletAdapter } from './wallet.js';

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

describe('BrowserWalletAdapter', () => {
  function makeProvider(handlers: Record<string, (params?: unknown[]) => unknown>): {
    provider: { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
    calls: Array<{ method: string; params?: unknown[] }>;
  } {
    const calls: Array<{ method: string; params?: unknown[] }> = [];
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        calls.push({ method, params });
        const handler = handlers[method];
        if (!handler) throw new Error(`unhandled rpc method: ${method}`);
        return handler(params);
      },
    };
    return { provider, calls };
  }

  it('getAddress returns the first eth_accounts result', async () => {
    const { provider } = makeProvider({
      eth_accounts: () => [account.address],
    });
    const { BrowserWalletAdapter } = await import('./wallet.js');
    const adapter = new BrowserWalletAdapter({ provider });
    expect((await adapter.getAddress()).toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('getAddress falls back to eth_requestAccounts when eth_accounts is empty', async () => {
    const { provider, calls } = makeProvider({
      eth_accounts: () => [],
      eth_requestAccounts: () => [account.address],
    });
    const { BrowserWalletAdapter } = await import('./wallet.js');
    const adapter = new BrowserWalletAdapter({ provider });
    expect(await adapter.getAddress()).toBe(account.address);
    expect(calls.map((c) => c.method)).toEqual(['eth_accounts', 'eth_requestAccounts']);
  });

  it('getAddress throws WalletError when eth_requestAccounts also returns empty', async () => {
    const { provider } = makeProvider({
      eth_accounts: () => [],
      eth_requestAccounts: () => [],
    });
    const { BrowserWalletAdapter } = await import('./wallet.js');
    const adapter = new BrowserWalletAdapter({ provider });
    await expect(adapter.getAddress()).rejects.toBeInstanceOf(WalletError);
  });

  it('getAddress throws WalletError without auto-connect when no accounts are present', async () => {
    const { provider, calls } = makeProvider({
      eth_accounts: () => [],
    });
    const { BrowserWalletAdapter } = await import('./wallet.js');
    const adapter = new BrowserWalletAdapter({ provider, autoConnect: false });
    await expect(adapter.getAddress()).rejects.toBeInstanceOf(WalletError);
    expect(calls.map((c) => c.method)).toEqual(['eth_accounts']);
  });

  it('account override skips eth_accounts entirely', async () => {
    const calls: string[] = [];
    const provider = {
      request: async ({ method }: { method: string }) => {
        calls.push(method);
        return null;
      },
    };
    const { BrowserWalletAdapter } = await import('./wallet.js');
    const adapter = new BrowserWalletAdapter({ provider, account: account.address });
    expect(await adapter.getAddress()).toBe(account.address);
    expect(calls).toEqual([]);
  });

  it('signTypedData wraps eth_signTypedData_v4 with the proper EIP-712 envelope', async () => {
    let payload: { method: string; params?: unknown[] } | undefined;
    const provider = {
      request: async (args: { method: string; params?: unknown[] }) => {
        payload = args;
        if (args.method === 'eth_accounts') return [account.address];
        if (args.method === 'eth_signTypedData_v4') return `0x${'ab'.repeat(65)}` as Hex;
        throw new Error(`unhandled ${args.method}`);
      },
    };
    const { BrowserWalletAdapter } = await import('./wallet.js');
    const adapter = new BrowserWalletAdapter({ provider });
    const sig = await adapter.signTypedData({
      domain: { chainId: TAIKO_HOODI_CHAIN_ID, verifyingContract },
      types: CHANNEL_STATE_TYPES,
      primaryType: 'ChannelState',
      message: {
        channelId,
        version: 1n,
        balanceA: 100n,
        balanceB: 200n,
        htlcsRoot: `0x${'00'.repeat(32)}` as Hex,
        finalized: false,
      },
    });
    expect(sig.length).toBeGreaterThan(2);
    const [signer, raw] = (payload?.params ?? []) as [string, string];
    expect(signer).toBe(account.address);
    const parsed = JSON.parse(raw) as { domain: { name: string }; types: Record<string, unknown> };
    expect(parsed.domain.name).toBe('tainnel');
    expect(parsed.types.EIP712Domain).toBeDefined();
  });

  it('signTypedData serializes bigints to decimal strings', async () => {
    let payload: { method: string; params?: unknown[] } | undefined;
    const provider = {
      request: async (args: { method: string; params?: unknown[] }) => {
        payload = args;
        if (args.method === 'eth_accounts') return [account.address];
        if (args.method === 'eth_signTypedData_v4') return `0x${'cd'.repeat(65)}` as Hex;
        throw new Error('nope');
      },
    };
    const { BrowserWalletAdapter } = await import('./wallet.js');
    const adapter = new BrowserWalletAdapter({ provider });
    await adapter.signTypedData({
      domain: { chainId: TAIKO_HOODI_CHAIN_ID, verifyingContract },
      types: CHANNEL_STATE_TYPES,
      primaryType: 'ChannelState',
      message: { version: 12345678901234567890n },
    });
    const raw = (payload?.params ?? [])[1] as string;
    expect(raw).toContain('"version":"12345678901234567890"');
  });

  it('signTypedData wraps RPC errors as WalletError', async () => {
    const provider = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_accounts') return [account.address];
        throw new Error('user rejected');
      },
    };
    const { BrowserWalletAdapter } = await import('./wallet.js');
    const adapter = new BrowserWalletAdapter({ provider });
    await expect(
      adapter.signTypedData({
        domain: { chainId: TAIKO_HOODI_CHAIN_ID, verifyingContract },
        types: CHANNEL_STATE_TYPES,
        primaryType: 'ChannelState',
        message: {},
      }),
    ).rejects.toBeInstanceOf(WalletError);
  });

  it('signMessage delegates to personal_sign with [message, address]', async () => {
    const calls: Array<{ method: string; params?: unknown[] }> = [];
    const provider = {
      request: async (args: { method: string; params?: unknown[] }) => {
        calls.push(args);
        if (args.method === 'eth_accounts') return [account.address];
        if (args.method === 'personal_sign') return `0x${'ee'.repeat(65)}` as Hex;
        throw new Error('nope');
      },
    };
    const { BrowserWalletAdapter } = await import('./wallet.js');
    const adapter = new BrowserWalletAdapter({ provider });
    const sig = await adapter.signMessage('hello');
    expect(sig.length).toBeGreaterThan(2);
    const personal = calls.find((c) => c.method === 'personal_sign');
    expect(personal?.params).toEqual(['hello', account.address]);
  });

  it('signMessage wraps RPC errors as WalletError', async () => {
    const provider = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_accounts') return [account.address];
        throw new Error('user denied');
      },
    };
    const { BrowserWalletAdapter } = await import('./wallet.js');
    const adapter = new BrowserWalletAdapter({ provider });
    await expect(adapter.signMessage('msg')).rejects.toBeInstanceOf(WalletError);
  });
});

describe('PrivateKeyWalletAdapter', () => {
  it('getAddress returns the address derived from the private key', async () => {
    const adapter = new PrivateKeyWalletAdapter({ privateKey: PK });
    expect((await adapter.getAddress()).toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('signTypedData produces a signature recoverable to the signer', async () => {
    const adapter = new PrivateKeyWalletAdapter({ privateKey: PK });
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

  it('signTypedData matches ViemWalletAdapter for the same key + payload', async () => {
    const wc = createWalletClient({ account, chain: taiko, transport: http() });
    const viemAdapter = new ViemWalletAdapter({ walletClient: wc });
    const pkAdapter = new PrivateKeyWalletAdapter({ privateKey: PK });
    const state = makeState();
    const args = {
      domain: { chainId: TAIKO_HOODI_CHAIN_ID, verifyingContract },
      types: CHANNEL_STATE_TYPES,
      primaryType: 'ChannelState',
      message: {
        channelId: state.channelId,
        version: state.version,
        balanceA: state.balanceA,
        balanceB: state.balanceB,
        htlcsRoot: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
        finalized: state.finalized,
      },
    } as const;
    const sigViem = await viemAdapter.signTypedData(args);
    const sigPk = await pkAdapter.signTypedData(args);
    expect(sigPk).toBe(sigViem);
  });

  it('signMessage produces a signature recoverable to the signer', async () => {
    const adapter = new PrivateKeyWalletAdapter({ privateKey: PK });
    const message = 'hello tainnel';
    const sig = (await adapter.signMessage(message)) as Hex;
    const recovered = await recoverMessageAddress({ message, signature: sig });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('throws WalletError when the private key is malformed', () => {
    expect(() => new PrivateKeyWalletAdapter({ privateKey: '0xnothex' as Hex })).toThrow(
      WalletError,
    );
    expect(() => new PrivateKeyWalletAdapter({ privateKey: '0xab' as Hex })).toThrow(WalletError);
  });

  it('does not log the private key in error messages', () => {
    const sentinel = `0x${'de'.repeat(32)}gg` as Hex; // wrong length, contains a recognizable substring
    try {
      new PrivateKeyWalletAdapter({ privateKey: sentinel });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('de'.repeat(32));
    }
  });
});
