import type { Address, ChainId, Hex } from '@tainnel/protocol';
import { CONTRACT_ADDRESSES, TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';

export interface WatchtowerConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly privateKey: Hex;
  readonly rpcUrl: string;
  readonly dbUrl: string;
  readonly mode: 'self-hosted' | 'service';
  readonly chainId: ChainId;
  readonly contractAddress: Address;
  readonly windowMs: number;
  readonly threshold: number;
  readonly schedulerIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatchtowerConfig {
  const mode = env.MODE === 'service' ? 'service' : 'self-hosted';
  const chainId = parseChainId(env.CHAIN_ID) ?? TAIKO_MAINNET_CHAIN_ID;
  const contractAddress =
    (env.PAYMENT_CHANNEL_ADDRESS as Address | undefined) ??
    CONTRACT_ADDRESSES[chainId].PaymentChannel;
  return {
    port: Number(env.PORT ?? 3031),
    logLevel: env.LOG_LEVEL ?? 'info',
    privateKey:
      (env.WATCHTOWER_PRIVATE_KEY as Hex | undefined) ??
      ('0x0000000000000000000000000000000000000000000000000000000000000002' as Hex),
    rpcUrl: env.RPC_URL ?? 'https://rpc.taiko.xyz',
    dbUrl: env.DB_URL ?? './data/watchtower.sqlite',
    mode,
    chainId,
    contractAddress,
    windowMs: Number(env.DISPUTE_WINDOW_MS ?? 24 * 60 * 60 * 1000),
    threshold: Number(env.PENALTY_THRESHOLD ?? 0.5),
    schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS ?? 60_000),
  };
}

function parseChainId(value: string | undefined): ChainId | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (n === 167000 || n === 167009) return n;
  return undefined;
}
