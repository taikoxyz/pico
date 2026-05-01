// Anvil-fork USDC funding via whale impersonation. Used by the e2e fork
// tests to give Alice/Bob/Hub a real USDC balance against the deployed
// Taiko mainnet PaymentChannel without minting (impossible — USDC is fixed
// supply on L2; bridge proxy is the only minter).
//
// Whale-source policy: this module accepts a whale address only via its
// caller (typically `process.env.E2E_USDC_WHALE`). It deliberately ships
// no hardcoded fallback — Taiko USDC bridge proxy and CEX hot wallets are
// candidates the operator can use, but they should be verified against the
// fork block before trusting them. Any account holding ≥ ~300 USDC at the
// fork block qualifies. If unconfigured, callers receive a typed
// `WhaleNotConfiguredError` so the test layer can `it.skip` cleanly.

import {
  http,
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  parseAbiItem,
} from 'viem';

const FUND_ETH_WEI = 10n ** 19n;

export class WhaleNotConfiguredError extends Error {
  constructor() {
    super(
      'E2E_USDC_WHALE not configured: pass an account holding USDC on Taiko mainnet at the fork block via env or opts.whale',
    );
    this.name = 'WhaleNotConfiguredError';
  }
}

export interface ImpersonateUsdcWhaleOpts {
  readonly whale?: Address;
  readonly fundEth?: bigint;
}

export function resolveWhale(opts: ImpersonateUsdcWhaleOpts | undefined): Address {
  const w = opts?.whale ?? (process.env.E2E_USDC_WHALE as Address | undefined);
  if (!w || !/^0x[0-9a-fA-F]{40}$/.test(w)) {
    throw new WhaleNotConfiguredError();
  }
  return w;
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export async function impersonateUsdcWhale(
  rpcUrl: string,
  opts: ImpersonateUsdcWhaleOpts = {},
): Promise<Address> {
  const whale = resolveWhale(opts);
  await rpcCall(rpcUrl, 'anvil_impersonateAccount', [whale]);
  const fundWei = opts.fundEth ?? FUND_ETH_WEI;
  await rpcCall(rpcUrl, 'anvil_setBalance', [whale, `0x${fundWei.toString(16)}`]);
  return whale;
}

export async function stopImpersonatingUsdcWhale(rpcUrl: string, whale: Address): Promise<void> {
  await rpcCall(rpcUrl, 'anvil_stopImpersonatingAccount', [whale]);
}

export async function fundUsdcParty(
  rpcUrl: string,
  publicClient: PublicClient,
  usdc: Address,
  party: Address,
  amount: bigint,
  opts: ImpersonateUsdcWhaleOpts = {},
): Promise<bigint> {
  const whale = await impersonateUsdcWhale(rpcUrl, opts);
  try {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [party, amount],
    }) as Hex;
    const txHash = (await rpcCall(rpcUrl, 'eth_sendTransaction', [
      { from: whale, to: usdc, data },
    ])) as Hex;
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const balance = (await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [party],
    })) as bigint;
    return balance;
  } finally {
    await stopImpersonatingUsdcWhale(rpcUrl, whale);
  }
}

// Minimal helper for tests that only need to read USDC balances, without
// the wallet-client overhead — avoids piping a separate viem client through.
export async function readUsdcBalance(
  publicClient: PublicClient,
  usdc: Address,
  who: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [who],
  })) as bigint;
}

// Lightweight create-transport helper kept here so tests don't need to know
// viem internals when all they want is a one-shot public client.
export function createForkPublicClient(
  rpcUrl: string,
  chain: Parameters<typeof createPublicClient>[0]['chain'],
): PublicClient {
  return createPublicClient({ chain, transport: http(rpcUrl) });
}

// Re-exported so tests can construct minimal ABIs inline if they need extras.
export { parseAbiItem };
