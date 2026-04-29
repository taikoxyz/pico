import type { Address, ChainId, Hex } from '@tainnel/protocol';
import { TAIKO_HOODI_CHAIN_ID, TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';
import { type ChainAdapter, ViemChainAdapter } from '@tainnel/sdk';
import { http, type Chain, createPublicClient, createWalletClient, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { taiko } from 'viem/chains';
import { CliError } from './errors.js';
import { InMemoryChainAdapter } from './in-memory-chain.js';

// The protocol package pins TAIKO_HOODI_CHAIN_ID = 167009 (the originally-
// deployed Hoodi chainId). viem's bundled `taikoHoodi` was later updated to
// 167013, so we define our own Chain matching the protocol constant.
const tainnelTaikoHoodi: Chain = defineChain({
  id: TAIKO_HOODI_CHAIN_ID,
  name: 'Taiko Hoodi',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.hoodi.taiko.xyz'] } },
});

export type ChainMode = 'viem' | 'memory';

export interface BuildChainAdapterOpts {
  readonly mode: ChainMode;
  readonly privateKey: Hex;
  readonly chainId: number;
  readonly userAddress: Address;
  readonly token: Address;
  readonly rpcUrl: string;
}

export function buildChainAdapter(opts: BuildChainAdapterOpts): ChainAdapter {
  if (opts.mode === 'memory') {
    return new InMemoryChainAdapter({
      chainId: opts.chainId as ChainId,
      userA: opts.userAddress,
    });
  }
  const chain = chainById(opts.chainId);
  const account = privateKeyToAccount(opts.privateKey);
  const publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });
  return new ViemChainAdapter({
    walletClient,
    publicClient,
    chain,
    account,
  });
}

export function chainById(chainId: number): Chain {
  if (chainId === taiko.id) return taiko;
  if (chainId === tainnelTaikoHoodi.id) return tainnelTaikoHoodi;
  throw new CliError(`unsupported chainId: ${chainId}`, { code: 'UNSUPPORTED_CHAIN' });
}

export function defaultRpcUrl(chainId: number): string {
  switch (chainId) {
    case TAIKO_MAINNET_CHAIN_ID:
      return 'https://rpc.taiko.xyz';
    case TAIKO_HOODI_CHAIN_ID:
      return 'https://rpc.hoodi.taiko.xyz';
    default:
      throw new CliError(`no default RPC URL for chainId ${chainId}`, {
        code: 'UNSUPPORTED_CHAIN',
      });
  }
}

export function readChainMode(env: NodeJS.ProcessEnv = process.env): ChainMode {
  const raw = env.TAINNEL_CHAIN_MODE;
  if (!raw || raw === 'viem') return 'viem';
  if (raw === 'memory') return 'memory';
  throw new CliError(`invalid TAINNEL_CHAIN_MODE: ${raw} (expected "viem" or "memory")`, {
    code: 'BAD_CHAIN_MODE',
  });
}
