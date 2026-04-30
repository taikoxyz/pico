import {
  type Address,
  CONTRACT_ADDRESSES,
  type ChainId,
  DEFAULT_HUB_FEE_BPS,
  DEFAULT_HUB_FEE_FLAT,
  type Hex,
  TAIKO_MAINNET_CHAIN_ID,
} from '@tainnel/protocol';

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
  readonly chainPollingIntervalMs: number;
  readonly chainConfirmations: number;
  readonly requireSignedEnvelope: boolean;
  readonly nonceWindowMs: number;
}

function parseChainId(raw: string | undefined): ChainId {
  const n = Number(raw ?? TAIKO_MAINNET_CHAIN_ID);
  if (n === 167000 || n === 167009 || n === 31337) return n as ChainId;
  throw new Error(`unsupported CHAIN_ID: ${raw}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const driver = env.DB_DRIVER === 'postgres' ? 'postgres' : 'sqlite';
  const chainId = parseChainId(env.CHAIN_ID);
  const defaults = CONTRACT_ADDRESSES[chainId];
  const hubKey =
    env.HUB_PRIVATE_KEY ?? '0x0000000000000000000000000000000000000000000000000000000000000001';
  return {
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
      env.DB_URL ??
      (driver === 'sqlite' ? './data/hub.sqlite' : 'postgres://localhost/tainnel_hub'),
    prometheusPort: Number(env.PROMETHEUS_PORT ?? 9090),
    chainPollingIntervalMs: Number(env.CHAIN_POLLING_INTERVAL_MS ?? 4_000),
    chainConfirmations: Number(env.CHAIN_CONFIRMATIONS ?? 3),
    requireSignedEnvelope: env.HUB_REQUIRE_SIGNED_ENVELOPE === 'true',
    nonceWindowMs: Number(env.HUB_NONCE_WINDOW_MS ?? 60_000),
  };
}
