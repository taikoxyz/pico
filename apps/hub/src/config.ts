import {
  ANVIL_DEV_CHAIN_ID,
  type Address,
  CONTRACT_ADDRESSES,
  type ChainId,
  DEFAULT_HUB_FEE_BPS,
  DEFAULT_HUB_FEE_FLAT,
  ETHEREUM_MAINNET_CHAIN_ID,
  type Hex,
  TAIKO_MAINNET_CHAIN_ID,
} from '@inferenceroom/pico-protocol';
import { assertProductionConfig } from './config-validate.js';

export interface HubConfig {
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly hubPrivateKey: Hex;
  readonly rpcUrl: string;
  readonly chainId: ChainId;
  readonly paymentChannelAddress: Address;
  readonly adjudicatorAddress: Address;
  readonly hubFeeBps: bigint;
  readonly hubFeeFlat: bigint;
  readonly dbDriver: 'sqlite' | 'postgres';
  readonly dbUrl: string;
  readonly prometheusPort: number;
  readonly metricsBindAddr: string;
  readonly chainPollingIntervalMs: number;
  readonly chainConfirmations: number;
  readonly requireSignedEnvelope: boolean;
  readonly nonceWindowMs: number;
  readonly paymentRetentionPerChannel: number;
  readonly operatorToken: string | undefined;
}

function parseChainId(raw: string | undefined): ChainId {
  const n = Number(raw ?? TAIKO_MAINNET_CHAIN_ID);
  if (n === ETHEREUM_MAINNET_CHAIN_ID || n === 167000 || n === 167009 || n === 31337)
    return n as ChainId;
  throw new Error(`unsupported CHAIN_ID: ${raw}`);
}

function parseNonNegativeIntegerEnv(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return n;
}

const DEV_DEFAULT_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const driver = env.DB_DRIVER === 'postgres' ? 'postgres' : 'sqlite';
  const chainId = parseChainId(env.CHAIN_ID);
  const defaults = CONTRACT_ADDRESSES[chainId];
  const explicitHubKey = env.HUB_PRIVATE_KEY !== undefined && env.HUB_PRIVATE_KEY !== '';
  const hubKey = explicitHubKey ? (env.HUB_PRIVATE_KEY as string) : DEV_DEFAULT_KEY;
  const isAnvil = chainId === ANVIL_DEV_CHAIN_ID;
  const requireSignedEnvelope =
    env.HUB_REQUIRE_SIGNED_ENVELOPE !== undefined
      ? env.HUB_REQUIRE_SIGNED_ENVELOPE === 'true'
      : !isAnvil;
  const cfg: HubConfig = {
    port: Number(env.PORT ?? 3030),
    logLevel: (env.LOG_LEVEL as HubConfig['logLevel'] | undefined) ?? 'info',
    hubPrivateKey: hubKey as Hex,
    rpcUrl: env.RPC_URL ?? 'https://rpc.taiko.xyz',
    chainId,
    paymentChannelAddress: (env.PAYMENT_CHANNEL_ADDRESS ?? defaults.PaymentChannel) as Address,
    adjudicatorAddress: (env.ADJUDICATOR_ADDRESS ?? defaults.Adjudicator) as Address,
    hubFeeBps: env.HUB_FEE_BPS !== undefined ? BigInt(env.HUB_FEE_BPS) : DEFAULT_HUB_FEE_BPS,
    hubFeeFlat: env.HUB_FEE_FLAT !== undefined ? BigInt(env.HUB_FEE_FLAT) : DEFAULT_HUB_FEE_FLAT,
    dbDriver: driver,
    dbUrl:
      env.DB_URL ?? (driver === 'sqlite' ? './data/hub.sqlite' : 'postgres://localhost/pico_hub'),
    prometheusPort: Number(env.PROMETHEUS_PORT ?? 9090),
    metricsBindAddr:
      env.METRICS_BIND_ADDR ?? (env.KUBERNETES_SERVICE_HOST !== undefined ? '::' : '127.0.0.1'),
    chainPollingIntervalMs: Number(env.CHAIN_POLLING_INTERVAL_MS ?? 4_000),
    chainConfirmations: Number(env.CHAIN_CONFIRMATIONS ?? 3),
    requireSignedEnvelope,
    nonceWindowMs: Number(env.HUB_NONCE_WINDOW_MS ?? 60_000),
    paymentRetentionPerChannel: parseNonNegativeIntegerEnv(
      'HUB_PAYMENT_RETENTION_PER_CHANNEL',
      env.HUB_PAYMENT_RETENTION_PER_CHANNEL,
      100,
    ),
    operatorToken: env.HUB_OPERATOR_TOKEN,
  };

  if (env.PICO_SKIP_PROD_ASSERT !== 'true') {
    assertProductionConfig(cfg, {
      env,
      operatorToken: cfg.operatorToken,
      explicitHubKey,
    });
  }

  return cfg;
}
