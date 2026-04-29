import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Address, ChainId, Hex } from '@tainnel/protocol';
import { CONTRACT_ADDRESSES, USDC_TOKENS } from '@tainnel/protocol';
import {
  ChannelClient,
  FileStorage,
  PrivateKeyWalletAdapter,
  WebSocketTransport,
} from '@tainnel/sdk';
import { buildChainAdapter, defaultRpcUrl, readChainMode } from './chain.js';
import { CliError } from './errors.js';
import { loadPrivateKey } from './keystore.js';
import { deriveHubUrls } from './url.js';

export interface HubInfo {
  readonly status: string;
  readonly dbReady: boolean;
  readonly chainReady: boolean;
  readonly address: Address;
  readonly chainId: number;
  readonly version: string;
}

export interface BuildClientOpts {
  readonly hubUrl: string;
  readonly storageDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface BuildClientResult {
  readonly client: ChannelClient;
  readonly hubInfo: HubInfo;
  readonly hubUrls: ReturnType<typeof deriveHubUrls>;
  readonly walletAddress: Address;
  readonly storageDir: string;
  cleanup(): Promise<void>;
}

export function defaultStorageDir(): string {
  return join(homedir(), '.tainnel', 'channels');
}

/** Skip the /health round-trip when the operator pins the hub identity via env
 * vars. Useful for CLI E2E tests against the mock hub (which is WS-only) and
 * for advanced ops where the hub HTTP port is intentionally firewalled. */
export function hubInfoFromEnv(env: NodeJS.ProcessEnv): HubInfo | undefined {
  const addr = env.TAINNEL_HUB_ADDRESS;
  const chainId = env.TAINNEL_HUB_CHAIN_ID;
  if (!addr || !chainId) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new CliError(`TAINNEL_HUB_ADDRESS is not a valid EVM address: ${addr}`, {
      code: 'BAD_ADDRESS',
    });
  }
  const id = Number(chainId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new CliError(`TAINNEL_HUB_CHAIN_ID is not a positive integer: ${chainId}`, {
      code: 'BAD_CHAIN_ID',
    });
  }
  return {
    status: 'ok',
    dbReady: true,
    chainReady: true,
    address: addr as Address,
    chainId: id,
    version: env.TAINNEL_HUB_VERSION ?? 'unknown',
  };
}

export async function fetchHubInfo(httpUrl: string): Promise<HubInfo> {
  let res: Response;
  try {
    res = await fetch(`${httpUrl}/health`);
  } catch (err) {
    throw new CliError(`failed to reach hub at ${httpUrl}/health: ${(err as Error).message}`, {
      code: 'HUB_UNREACHABLE',
    });
  }
  if (!res.ok) {
    throw new CliError(`hub ${httpUrl}/health returned ${res.status}`, {
      code: 'HUB_UNHEALTHY',
    });
  }
  const body = (await res.json()) as Partial<HubInfo>;
  if (!body.address || typeof body.chainId !== 'number') {
    throw new CliError(
      'hub /health response is missing required fields (address, chainId). Older hub? Upgrade to a v0.1+ hub.',
      { code: 'HUB_INCOMPATIBLE' },
    );
  }
  return {
    status: body.status ?? 'unknown',
    dbReady: body.dbReady ?? false,
    chainReady: body.chainReady ?? false,
    address: body.address,
    chainId: body.chainId,
    version: body.version ?? 'unknown',
  };
}

export async function buildClient(opts: BuildClientOpts): Promise<BuildClientResult> {
  const env = opts.env ?? process.env;
  const privateKey = loadPrivateKey(env);
  const hubUrls = deriveHubUrls(opts.hubUrl);
  const hubInfo = hubInfoFromEnv(env) ?? (await fetchHubInfo(hubUrls.http));

  const wallet = new PrivateKeyWalletAdapter({ privateKey });
  const walletAddress = await wallet.getAddress();
  const storageDir = opts.storageDir ?? env.TAINNEL_STORAGE_DIR ?? defaultStorageDir();
  const storage = await FileStorage.createNode(storageDir);
  const transport = new WebSocketTransport({ url: hubUrls.ws });
  const chain = buildChainAdapter({
    mode: readChainMode(env),
    privateKey,
    chainId: hubInfo.chainId,
    userAddress: walletAddress,
    token: usdcTokenFor(hubInfo.chainId, env),
    rpcUrl: env.TAINNEL_RPC_URL ?? defaultRpcUrl(hubInfo.chainId),
  });

  // TEST-ONLY: lets the E2E test ship a preimage that's been pre-registered on
  // the mock hub. Production never sets this; the SDK falls back to crypto.
  // randomBytes for both the preimage (call 1) and the htlc id (call 2).
  const testPreimage = env.TAINNEL_TEST_PREIMAGE as Hex | undefined;
  let testCallCount = 0;

  const client = new ChannelClient({
    wallet,
    transport,
    storage,
    chain,
    hubAddress: hubInfo.address,
    contract: contractAddressFor(hubInfo.chainId, env),
    ...(testPreimage
      ? {
          randomBytes32: (): Hex => {
            testCallCount++;
            return (
              testCallCount === 1
                ? testPreimage
                : `0x${testCallCount.toString(16).padStart(64, '0')}`
            ) as Hex;
          },
        }
      : {}),
  });

  // Eagerly connect so commands like `pay` (which never call open()) can issue
  // requestReply round-trips. WebSocketTransport.connect is idempotent.
  await transport.connect();

  return {
    client,
    hubInfo,
    hubUrls,
    walletAddress,
    storageDir,
    async cleanup() {
      await transport.close();
    },
  };
}

export function contractAddressFor(chainId: number, env: NodeJS.ProcessEnv = process.env): Address {
  const override = env.TAINNEL_CONTRACT_ADDRESS;
  if (override) return validateAddress(override, 'TAINNEL_CONTRACT_ADDRESS');
  const entry = CONTRACT_ADDRESSES[chainId as ChainId];
  if (!entry) {
    throw new CliError(`no contract addresses configured for chainId ${chainId}`, {
      code: 'UNSUPPORTED_CHAIN',
    });
  }
  if (entry.PaymentChannel === '0x0000000000000000000000000000000000000000') {
    throw new CliError(
      `PaymentChannel is not deployed on chainId ${chainId}. Set TAINNEL_CONTRACT_ADDRESS to override.`,
      { code: 'CONTRACT_NOT_DEPLOYED' },
    );
  }
  return entry.PaymentChannel;
}

export function usdcTokenFor(chainId: number, env: NodeJS.ProcessEnv = process.env): Address {
  const override = env.TAINNEL_TOKEN_ADDRESS;
  if (override) return validateAddress(override, 'TAINNEL_TOKEN_ADDRESS');
  const entry = USDC_TOKENS[chainId as ChainId];
  if (!entry) {
    throw new CliError(`no USDC token configured for chainId ${chainId}`, {
      code: 'UNSUPPORTED_CHAIN',
    });
  }
  if (entry.address === '0x0000000000000000000000000000000000000000') {
    throw new CliError(
      `USDC is not deployed on chainId ${chainId}. Set TAINNEL_TOKEN_ADDRESS to override.`,
      { code: 'TOKEN_NOT_DEPLOYED' },
    );
  }
  return entry.address;
}

function validateAddress(value: string, label: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new CliError(`${label} is not a valid EVM address: ${value}`, { code: 'BAD_ADDRESS' });
  }
  return value as Address;
}

export type { Hex };
