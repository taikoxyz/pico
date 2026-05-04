import {
  ANVIL_DEV_CHAIN_ID,
  type Address,
  CONTRACT_ADDRESSES,
  type ChainId,
  type ChannelId,
  TAIKO_MAINNET_CHAIN_ID,
} from '@pico/protocol';
import { assertProductionConfig } from './config-validate.js';

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

const DEV_DEFAULT_KEY = '0x0000000000000000000000000000000000000000000000000000000000000002';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;

function parseInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got ${raw}`);
  return n;
}

function parseFloat01(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got ${raw}`);
  return n;
}

function parseChannelIds(raw: string | undefined): readonly ChannelId[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of items) {
    if (!HEX32.test(id)) {
      throw new Error(`INTERESTED_CHANNEL_IDS contains an invalid bytes32 value: ${id}`);
    }
  }
  return items as ChannelId[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatchtowerConfig {
  const mode = env.MODE === 'service' ? 'service' : 'self-hosted';
  const chainId = parseChainId(env.CHAIN_ID);
  const paymentChannelAddress = (env.PAYMENT_CHANNEL_ADDRESS ??
    CONTRACT_ADDRESSES[chainId]?.PaymentChannel) as Address | undefined;
  if (!paymentChannelAddress) {
    throw new Error(`paymentChannelAddress unset and no default for chainId=${chainId}`);
  }
  if (!HEX_ADDR.test(paymentChannelAddress)) {
    throw new Error(`PAYMENT_CHANNEL_ADDRESS is not a valid hex address: ${paymentChannelAddress}`);
  }
  const interestedChannelIds = parseChannelIds(env.INTERESTED_CHANNEL_IDS);
  const explicitPrivateKey =
    env.WATCHTOWER_PRIVATE_KEY !== undefined && env.WATCHTOWER_PRIVATE_KEY !== '';
  const privateKey = explicitPrivateKey ? (env.WATCHTOWER_PRIVATE_KEY as string) : DEV_DEFAULT_KEY;
  if (!HEX32.test(privateKey)) {
    throw new Error('WATCHTOWER_PRIVATE_KEY must be 32 bytes of hex (0x-prefixed)');
  }
  const cfg: WatchtowerConfig = {
    port: parseInteger('PORT', env.PORT, 3031),
    logLevel: env.LOG_LEVEL ?? 'info',
    privateKey,
    rpcUrl: env.RPC_URL ?? 'https://rpc.taiko.xyz',
    dbUrl: env.DB_URL ?? './data/watchtower.sqlite',
    mode,
    chainId,
    paymentChannelAddress,
    ...(interestedChannelIds !== undefined ? { interestedChannelIds } : {}),
    penaltyThreshold: parseFloat01('PENALTY_THRESHOLD', env.PENALTY_THRESHOLD, 0.5),
    schedulerIntervalMs: parseInteger('SCHEDULER_INTERVAL_MS', env.SCHEDULER_INTERVAL_MS, 60_000),
    confirmations: parseInteger('CONFIRMATIONS', env.CONFIRMATIONS, 3),
    rpcReconnectMaxBackoffMs: parseInteger(
      'RPC_RECONNECT_MAX_BACKOFF_MS',
      env.RPC_RECONNECT_MAX_BACKOFF_MS,
      30_000,
    ),
  };

  if (env.PICO_SKIP_PROD_ASSERT !== 'true') {
    assertProductionConfig(cfg, { env, explicitPrivateKey });
  }

  return cfg;
}

function parseChainId(raw: string | undefined): ChainId {
  if (!raw) return TAIKO_MAINNET_CHAIN_ID;
  const n = Number(raw);
  if (n === ANVIL_DEV_CHAIN_ID || n === TAIKO_MAINNET_CHAIN_ID) return n as ChainId;
  throw new Error(`unsupported CHAIN_ID=${raw}`);
}
