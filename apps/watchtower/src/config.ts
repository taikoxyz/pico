import {
  ANVIL_DEV_CHAIN_ID,
  type Address,
  CONTRACT_ADDRESSES,
  type ChainId,
  type ChannelId,
  TAIKO_MAINNET_CHAIN_ID,
} from '@tainnel/protocol';

export interface WatchtowerConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly privateKey: string;
  readonly rpcUrl: string;
  readonly dbUrl: string;
  readonly mode: 'self-hosted' | 'service';
  readonly chainId: ChainId;
  readonly paymentChannelAddress: Address;
  readonly interestedChannelIds?: readonly ChannelId[];
  readonly penaltyThreshold: number;
  readonly schedulerIntervalMs: number;
  readonly confirmations: number;
  readonly rpcReconnectMaxBackoffMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatchtowerConfig {
  const mode = env.MODE === 'service' ? 'service' : 'self-hosted';
  const chainId = parseChainId(env.CHAIN_ID);
  const paymentChannelAddress = (env.PAYMENT_CHANNEL_ADDRESS ??
    CONTRACT_ADDRESSES[chainId]?.PaymentChannel) as Address | undefined;
  if (!paymentChannelAddress) {
    throw new Error(`paymentChannelAddress unset and no default for chainId=${chainId}`);
  }
  const interestedChannelIds = env.INTERESTED_CHANNEL_IDS
    ? (env.INTERESTED_CHANNEL_IDS.split(',')
        .map((s) => s.trim())
        .filter(Boolean) as ChannelId[])
    : undefined;
  return {
    port: Number(env.PORT ?? 3031),
    logLevel: env.LOG_LEVEL ?? 'info',
    privateKey:
      env.WATCHTOWER_PRIVATE_KEY ??
      '0x0000000000000000000000000000000000000000000000000000000000000002',
    rpcUrl: env.RPC_URL ?? 'https://rpc.taiko.xyz',
    dbUrl: env.DB_URL ?? './data/watchtower.sqlite',
    mode,
    chainId,
    paymentChannelAddress,
    ...(interestedChannelIds !== undefined ? { interestedChannelIds } : {}),
    penaltyThreshold: Number(env.PENALTY_THRESHOLD ?? 0.5),
    schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS ?? 60_000),
    confirmations: Number(env.CONFIRMATIONS ?? 3),
    rpcReconnectMaxBackoffMs: Number(env.RPC_RECONNECT_MAX_BACKOFF_MS ?? 30_000),
  };
}

function parseChainId(raw: string | undefined): ChainId {
  if (!raw) return TAIKO_MAINNET_CHAIN_ID;
  const n = Number(raw);
  if (n === ANVIL_DEV_CHAIN_ID || n === TAIKO_MAINNET_CHAIN_ID) return n as ChainId;
  throw new Error(`unsupported CHAIN_ID=${raw}`);
}
