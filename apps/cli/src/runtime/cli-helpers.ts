import {
  type ChainId,
  TAIKO_HOODI_CHAIN_ID,
  TAIKO_MAINNET_CHAIN_ID,
  ZERO_ADDRESS,
} from '@inferenceroom/pico-protocol';
import { type Address, type PublicClient, erc20Abi, parseUnits } from 'viem';

/// Default WebSocket URLs per chain. Override via PICO_HUB_URL or --via.
export const DEFAULT_HUB_URL: Record<ChainId, string> = {
  [TAIKO_MAINNET_CHAIN_ID]: 'wss://hub.pico.taiko.xyz/ws',
  [TAIKO_HOODI_CHAIN_ID]: 'ws://127.0.0.1:9050',
  1: 'ws://127.0.0.1:9050',
  31337: 'ws://127.0.0.1:9050',
};

/// Resolve the WS hub URL with this precedence:
///   1. explicit --via flag (anything other than the legacy localhost default)
///   2. PICO_HUB_URL env var
///   3. chain default
/// The Commander default of `ws://127.0.0.1:9050` is treated as "unset" so a
/// mainnet --rpc gets a sensible mainnet WS default automatically.
export function resolveHubUrl(opts: {
  via?: string;
  env: NodeJS.ProcessEnv;
  chainId: ChainId;
}): string {
  const legacy = 'ws://127.0.0.1:9050';
  if (opts.via && opts.via !== legacy) return opts.via;
  const envUrl = opts.env.PICO_HUB_URL;
  if (envUrl) return envUrl;
  return DEFAULT_HUB_URL[opts.chainId] ?? legacy;
}

/// Warn (to stderr) if the user is pointed at a localhost hub but a mainnet
/// RPC — the most common smoke-test misconfiguration we hit on this branch.
export function warnLocalhostHubOnMainnet(args: {
  hubUrl: string;
  chainId: ChainId;
  stderr: { write(s: string): void };
}): void {
  if (args.chainId === TAIKO_MAINNET_CHAIN_ID && /127\.0\.0\.1|localhost/.test(args.hubUrl)) {
    args.stderr.write(
      `warning: --via points at ${args.hubUrl} but chain is Taiko mainnet (${args.chainId}). If you meant the production hub, set --via wss://hub.pico.taiko.xyz/ws or PICO_HUB_URL.\n`,
    );
  }
}

/// Parse a `--amount` flag with optional decimal point. With `rawMode=true`
/// (the legacy behavior), interprets as a raw integer in base units.
export function parseAmount(args: {
  amount: string;
  decimals: number;
  rawMode: boolean;
}): bigint {
  if (args.rawMode) {
    if (!/^\d+$/.test(args.amount)) {
      throw new Error(`--amount must be a non-negative integer in raw mode; got "${args.amount}"`);
    }
    return BigInt(args.amount);
  }
  return parseUnits(args.amount, args.decimals);
}

/// Read `decimals()` from an ERC-20. Returns the integer value (8 for WBTC,
/// 6 for USDC, 18 for most everything else). The native-ETH sentinel
/// `address(0)` has no contract, so short-circuit to 18.
export async function readTokenDecimals(args: {
  client: PublicClient;
  token: Address;
}): Promise<number> {
  if (args.token === ZERO_ADDRESS) return 18;
  const dec = await args.client.readContract({
    address: args.token,
    abi: erc20Abi,
    functionName: 'decimals',
  });
  return Number(dec);
}

/// Read ERC-20 allowance owner→spender.
export async function readAllowance(args: {
  client: PublicClient;
  token: Address;
  owner: Address;
  spender: Address;
}): Promise<bigint> {
  return args.client.readContract({
    address: args.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [args.owner, args.spender],
  });
}

/// Decode a viem error into a one-line human message and a tag. Used by the
/// CLI's outermost try/catch so an on-chain revert isn't surfaced as
/// "WebSocket error".
export function describeCliError(err: unknown): { tag: string; message: string } {
  const e = err as {
    name?: string;
    shortMessage?: string;
    metaMessages?: string[];
    message?: string;
    cause?: unknown;
  };
  // Viem's ContractFunctionExecutionError + BaseError populate `shortMessage`
  // and a `metaMessages` array — the first entry is the decoded error.
  if (e?.name === 'ContractFunctionExecutionError' || e?.name === 'ContractFunctionRevertedError') {
    const reason = e.metaMessages?.[0] ?? e.shortMessage ?? e.message ?? 'unknown chain error';
    return { tag: 'chain', message: reason };
  }
  // Underlying RPC errors.
  if (e?.name === 'CallExecutionError' || e?.name === 'TransactionExecutionError') {
    return { tag: 'chain', message: e.shortMessage ?? e.message ?? 'transaction failed' };
  }
  // Our SDK's transport timeouts.
  const msg = e?.message ?? String(err);
  if (/timed out/.test(msg)) return { tag: 'hub', message: msg };
  if (/WebSocket error|websocket/i.test(msg)) return { tag: 'ws', message: msg };
  return { tag: 'cli', message: msg };
}

export function formatCliError(err: unknown): string {
  const { tag, message } = describeCliError(err);
  return `${tag} error: ${message}\n`;
}
