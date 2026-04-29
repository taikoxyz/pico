import type { Address, ChainId, Hex } from '@tainnel/protocol';
import { CONTRACT_ADDRESSES, TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';

export interface HubConfig {
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly hubPrivateKey: Hex;
  readonly rpcUrl: string;
  readonly dbDriver: 'sqlite' | 'postgres';
  readonly dbUrl: string;
  readonly prometheusPort: number;
  readonly chainId: ChainId;
  readonly contractAddress: Address;
  readonly operatorToken: string;
}

const DEFAULT_HUB_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex;

function parseChainId(value: string | undefined): ChainId | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (n === 167000 || n === 167009) return n;
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const driver = env.DB_DRIVER === 'postgres' ? 'postgres' : 'sqlite';
  const chainId = parseChainId(env.CHAIN_ID) ?? TAIKO_MAINNET_CHAIN_ID;
  const contractAddress =
    (env.PAYMENT_CHANNEL_ADDRESS as Address | undefined) ??
    CONTRACT_ADDRESSES[chainId].PaymentChannel;
  return {
    port: Number(env.PORT ?? 3030),
    logLevel: (env.LOG_LEVEL as HubConfig['logLevel'] | undefined) ?? 'info',
    hubPrivateKey: (env.HUB_PRIVATE_KEY as Hex | undefined) ?? DEFAULT_HUB_KEY,
    rpcUrl: env.RPC_URL ?? 'https://rpc.taiko.xyz',
    dbDriver: driver,
    dbUrl:
      env.DB_URL ??
      (driver === 'sqlite' ? './data/hub.sqlite' : 'postgres://localhost/tainnel_hub'),
    prometheusPort: Number(env.PROMETHEUS_PORT ?? 9090),
    chainId,
    contractAddress,
    operatorToken: env.HUB_OPERATOR_TOKEN ?? 'changeme',
  };
}
