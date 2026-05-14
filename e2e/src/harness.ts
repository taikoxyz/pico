import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BuildServerResult, buildServer } from '@inferenceroom/pico-hub';
import {
  ANVIL_DEV_CHAIN_ID,
  CONTRACT_ADDRESSES,
  type ChainId,
  type Channel,
  type SignedState,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
} from '@inferenceroom/pico-protocol';
import {
  ChannelClient,
  MemoryStorage,
  ViemChainAdapter,
  WebSocketTransport,
  localSigner,
} from '@inferenceroom/pico-sdk';
import { type AnvilHandle, TEST_KEYS, startAnvilFork } from '@inferenceroom/pico-test-utils';
import {
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, taiko } from 'viem/chains';
import { WhaleNotConfiguredError, fundUsdcParty } from './whale.js';

const ANVIL_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const USDC_DECIMALS = 6;
const ONE_USDC = 10n ** BigInt(USDC_DECIMALS);

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_OUT = join(__dirname, '..', '..', 'packages', 'contracts', 'out');

interface ForgeArtifact {
  readonly abi: Abi;
  readonly bytecode: { readonly object: Hex };
}

function loadArtifact(folder: string, name: string): ForgeArtifact {
  const raw = readFileSync(join(CONTRACTS_OUT, folder, `${name}.json`), 'utf8');
  return JSON.parse(raw) as ForgeArtifact;
}

function viemChainFor(chainId: ChainId): Chain {
  if (chainId === TAIKO_MAINNET_CHAIN_ID) return taiko;
  return foundry;
}

export interface BootE2EOptions {
  /** When set, anvil forks this RPC and uses Taiko mainnet contract addresses. */
  readonly forkUrl?: string;
  /** Optional pinned block number for reproducible fork tests. */
  readonly forkBlockNumber?: bigint;
  /** When set, the hub mints exactly this much USDC instead of the 100 USDC default. */
  readonly hubUsdcMint?: bigint;
  /** Override hub-side env vars (e.g. polling interval, confirmations). */
  readonly hubEnv?: Readonly<Record<string, string | undefined>>;
}

export interface E2EParty {
  readonly address: Address;
  readonly privateKey: Hex;
}

export interface HubServerHandle {
  readonly url: string;
  registerChannel(channel: Channel, initialState?: SignedState): Promise<void>;
  /**
   * Direct channel-pool register that accepts on-chain amounts but no
   * initialState. Used for inbound-liquidity tests where the hub must use
   * the sentinel `version: 0` prev branch (i.e. no opener-signed v=1 in the
   * pool) so the auto-topUp produces a v=1 fully co-signed state.
   */
  registerChannelWithAmounts(
    channel: Channel,
    amounts: { amountA: bigint; amountB: bigint },
  ): Promise<void>;
  /** Test-only: internals exposed for white-box assertions / debugging. */
  readonly _internal?: {
    readonly built: BuildServerResult;
  };
  stop(): Promise<void>;
}

export interface E2EHandle {
  readonly rpcUrl: string;
  readonly chainId: ChainId;
  readonly usdc: Address;
  readonly paymentChannel: Address;
  readonly adjudicator: Address;
  readonly alice: E2EParty;
  readonly bob: E2EParty;
  readonly hub: E2EParty;
  readonly hubServer: HubServerHandle;
  readonly publicClient: PublicClient;
  readonly mode: 'vanilla' | 'fork';
  fundAndApproveParty(privateKey: Hex, usdcAmount?: bigint): Promise<E2EParty>;
  stop(): Promise<void>;
}

export interface StartRealHubArgs {
  readonly hubPrivateKey: Hex;
  readonly rpcUrl: string;
  readonly chainId: ChainId;
  readonly paymentChannelAddress: Address;
  readonly adjudicatorAddress: Address;
  readonly port?: number;
  /** Extra env vars merged on top of the defaults; lets tests tune chain polling. */
  readonly extraEnv?: Readonly<Record<string, string | undefined>>;
}

export async function startRealHub(args: StartRealHubArgs): Promise<HubServerHandle> {
  const dbDir = mkdtempSync(join(tmpdir(), 'pico-hub-e2e-'));
  const env: NodeJS.ProcessEnv = {
    HUB_PRIVATE_KEY: args.hubPrivateKey,
    RPC_URL: args.rpcUrl,
    CHAIN_ID: String(args.chainId),
    PAYMENT_CHANNEL_ADDRESS: args.paymentChannelAddress,
    ADJUDICATOR_ADDRESS: args.adjudicatorAddress,
    HUB_FEE_BPS: '0',
    HUB_FEE_FLAT: '0',
    LOG_LEVEL: 'silent',
    PORT: String(args.port ?? 0),
    DB_DRIVER: 'sqlite',
    DB_URL: join(dbDir, 'hub.sqlite'),
    PICO_DEV_ALLOW_ZERO_ADDRESS: 'true',
    PICO_SKIP_PROD_ASSERT: 'true',
    // Force Prometheus to share the API port (mounts /metrics on the main
    // app). Avoids parallel-test conflicts on the default 9090.
    PROMETHEUS_PORT: '0',
    ...(args.extraEnv ?? {}),
  };
  const built: BuildServerResult = await buildServer(env);
  const url = await built.app.listen({ port: args.port ?? 0, host: '127.0.0.1' });
  const wsUrl = `${url.replace(/^http/, 'ws')}/ws`;
  return {
    url: wsUrl,
    async registerChannel(channel: Channel, initialState?: SignedState): Promise<void> {
      await built.api.ws.registerChannel(channel, initialState);
    },
    async registerChannelWithAmounts(
      channel: Channel,
      amounts: { amountA: bigint; amountB: bigint },
    ): Promise<void> {
      // Bypass the WS facade — it only accepts (channel, initialState). Use
      // the pool directly so we can seed amounts without an opener-signed
      // state. Mirrors what the hub's chain-watcher would do if it
      // registered channels itself instead of relying on the harness.
      await built.channelPool.register(channel, undefined, amounts);
      // Seed the liquidity tracker so per-counterparty outbound calculations
      // reflect the on-chain amounts (matters for the topup admission policy).
      const hubAddr = built.api.ws.hubAccount.address.toLowerCase();
      const hubIsA = channel.userA.toLowerCase() === hubAddr;
      built.liquidity.set(channel.id, {
        outbound: hubIsA ? amounts.amountA : amounts.amountB,
        inbound: hubIsA ? amounts.amountB : amounts.amountA,
      });
    },
    _internal: { built },
    async stop(): Promise<void> {
      await built.app.close();
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

async function deployContract(
  wallet: WalletClient,
  publicClient: PublicClient,
  artifact: ForgeArtifact,
  args: readonly unknown[] = [],
): Promise<Address> {
  if (!wallet.account) throw new Error('walletClient has no account');
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: args as never,
    account: wallet.account,
    chain: wallet.chain ?? foundry,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('deployContract: no contractAddress in receipt');
  return receipt.contractAddress;
}

async function anvilSetBalance(rpcUrl: string, address: Address, weiHex: Hex): Promise<void> {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'anvil_setBalance',
      params: [address, weiHex],
    }),
  });
  const body = (await r.json()) as { error?: { message: string } };
  if (body.error) throw new Error(`anvil_setBalance: ${body.error.message}`);
}

export async function bootE2E(opts: BootE2EOptions = {}): Promise<E2EHandle> {
  if (opts.forkUrl) return bootForkMode(opts);
  return bootVanillaMode(opts);
}

async function bootVanillaMode(opts: BootE2EOptions = {}): Promise<E2EHandle> {
  const mockErc20 = loadArtifact('MockERC20.sol', 'MockERC20');
  const adjudicatorArtifact = loadArtifact('Adjudicator.sol', 'Adjudicator');
  const paymentChannelArtifact = loadArtifact('PaymentChannel.sol', 'PaymentChannel');
  const erc1967Proxy = loadArtifact('ERC1967Proxy.sol', 'ERC1967Proxy');

  const anvil: AnvilHandle = await startAnvilFork({
    chainId: ANVIL_DEV_CHAIN_ID,
    accounts: 10,
    silent: true,
  });

  try {
    const transport = http(anvil.rpcUrl);
    const publicClient = createPublicClient({ chain: foundry, transport });

    const deployerAccount = privateKeyToAccount(ANVIL_DEPLOYER_KEY);
    const aliceAccount = privateKeyToAccount(TEST_KEYS.alice.privateKey);
    const bobAccount = privateKeyToAccount(TEST_KEYS.bob.privateKey);
    const hubAccount = privateKeyToAccount(TEST_KEYS.hub.privateKey);

    const deployerWallet = createWalletClient({
      account: deployerAccount,
      chain: foundry,
      transport,
    });
    const aliceWallet = createWalletClient({
      account: aliceAccount,
      chain: foundry,
      transport,
    });
    const bobWallet = createWalletClient({
      account: bobAccount,
      chain: foundry,
      transport,
    });
    const hubWallet = createWalletClient({
      account: hubAccount,
      chain: foundry,
      transport,
    });

    const fundEth = 10n ** 18n;
    for (const to of [aliceAccount.address, bobAccount.address, hubAccount.address]) {
      const hash = await deployerWallet.sendTransaction({
        account: deployerAccount,
        chain: foundry,
        to,
        value: fundEth,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }

    const usdc = await deployContract(deployerWallet, publicClient, mockErc20, [
      'USD Coin',
      'USDC',
      USDC_DECIMALS,
    ]);

    const hubMintAmount = opts.hubUsdcMint ?? 100n * ONE_USDC;
    const mintPlan: ReadonlyArray<{ to: Address; amount: bigint }> = [
      { to: aliceAccount.address, amount: 100n * ONE_USDC },
      { to: bobAccount.address, amount: 100n * ONE_USDC },
      { to: hubAccount.address, amount: hubMintAmount },
    ];
    for (const { to, amount } of mintPlan) {
      const hash = await deployerWallet.writeContract({
        account: deployerAccount,
        chain: foundry,
        address: usdc,
        abi: mockErc20.abi,
        functionName: 'mint',
        args: [to, amount],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }

    const adjImpl = await deployContract(deployerWallet, publicClient, adjudicatorArtifact);
    const adjInitData = encodeFunctionData({
      abi: adjudicatorArtifact.abi,
      functionName: 'initialize',
      args: [deployerAccount.address],
    });
    const adjudicator = await deployContract(deployerWallet, publicClient, erc1967Proxy, [
      adjImpl,
      adjInitData,
    ]);

    const pcImpl = await deployContract(deployerWallet, publicClient, paymentChannelArtifact);
    const pcInitData = encodeFunctionData({
      abi: paymentChannelArtifact.abi,
      functionName: 'initialize',
      args: [deployerAccount.address, adjudicator],
    });
    const paymentChannel = await deployContract(deployerWallet, publicClient, erc1967Proxy, [
      pcImpl,
      pcInitData,
    ]);

    const allowHash = await deployerWallet.writeContract({
      account: deployerAccount,
      chain: foundry,
      address: paymentChannel,
      abi: paymentChannelArtifact.abi,
      functionName: 'setTokenAllowed',
      args: [usdc, true],
    });
    await publicClient.waitForTransactionReceipt({ hash: allowHash });

    for (const wallet of [aliceWallet, bobWallet, hubWallet]) {
      const account = wallet.account;
      if (!account) throw new Error('walletClient missing account');
      const hash = await wallet.writeContract({
        account,
        chain: foundry,
        address: usdc,
        abi: mockErc20.abi,
        functionName: 'approve',
        args: [paymentChannel, 2n ** 256n - 1n],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }

    const hubServer = await startRealHub({
      hubPrivateKey: TEST_KEYS.hub.privateKey,
      rpcUrl: anvil.rpcUrl,
      chainId: ANVIL_DEV_CHAIN_ID,
      paymentChannelAddress: paymentChannel,
      adjudicatorAddress: adjudicator,
      // Pre-seed the hub's USDC token address so the §8 topup-handler can
      // submit on-chain topUps even before any channel is registered. Server's
      // resolveToken() falls back to HUB_USDC_TOKEN when the channel pool is
      // empty (apps/hub/src/server.ts L122-124).
      extraEnv: {
        HUB_USDC_TOKEN: usdc,
        ...(opts.hubEnv ?? {}),
      },
    });

    return {
      rpcUrl: anvil.rpcUrl,
      chainId: ANVIL_DEV_CHAIN_ID,
      usdc,
      paymentChannel,
      adjudicator,
      alice: { address: aliceAccount.address, privateKey: TEST_KEYS.alice.privateKey },
      bob: { address: bobAccount.address, privateKey: TEST_KEYS.bob.privateKey },
      hub: { address: hubAccount.address, privateKey: TEST_KEYS.hub.privateKey },
      hubServer,
      publicClient,
      mode: 'vanilla',
      async fundAndApproveParty(
        privateKey: Hex,
        usdcAmount: bigint = 100n * ONE_USDC,
      ): Promise<E2EParty> {
        const newAccount = privateKeyToAccount(privateKey);
        const ethHash = await deployerWallet.sendTransaction({
          account: deployerAccount,
          chain: foundry,
          to: newAccount.address,
          value: 10n ** 18n,
        });
        await publicClient.waitForTransactionReceipt({ hash: ethHash });
        const mintHash = await deployerWallet.writeContract({
          account: deployerAccount,
          chain: foundry,
          address: usdc,
          abi: mockErc20.abi,
          functionName: 'mint',
          args: [newAccount.address, usdcAmount],
        });
        await publicClient.waitForTransactionReceipt({ hash: mintHash });
        const newWallet = createWalletClient({
          account: newAccount,
          chain: foundry,
          transport,
        });
        const apprHash = await newWallet.writeContract({
          account: newAccount,
          chain: foundry,
          address: usdc,
          abi: mockErc20.abi,
          functionName: 'approve',
          args: [paymentChannel, 2n ** 256n - 1n],
        });
        await publicClient.waitForTransactionReceipt({ hash: apprHash });
        return { address: newAccount.address, privateKey };
      },
      async stop(): Promise<void> {
        await hubServer.stop();
        await anvil.stop();
      },
    };
  } catch (err) {
    await anvil.stop();
    throw err;
  }
}

async function bootForkMode(opts: BootE2EOptions): Promise<E2EHandle> {
  if (!opts.forkUrl) throw new Error('bootForkMode requires forkUrl');
  const addrs = CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID];
  const usdc = USDC_TOKENS[TAIKO_MAINNET_CHAIN_ID].address;

  const anvil: AnvilHandle = await startAnvilFork({
    chainId: TAIKO_MAINNET_CHAIN_ID,
    forkUrl: opts.forkUrl,
    ...(opts.forkBlockNumber !== undefined ? { forkBlockNumber: opts.forkBlockNumber } : {}),
    accounts: 10,
    silent: true,
  });

  try {
    const transport = http(anvil.rpcUrl);
    const publicClient = createPublicClient({ chain: taiko, transport });

    const aliceAccount = privateKeyToAccount(TEST_KEYS.alice.privateKey);
    const bobAccount = privateKeyToAccount(TEST_KEYS.bob.privateKey);
    const hubAccount = privateKeyToAccount(TEST_KEYS.hub.privateKey);

    const fundEthHex = `0x${(10n ** 19n).toString(16)}` as Hex; // 10 ETH each
    await anvilSetBalance(anvil.rpcUrl, aliceAccount.address, fundEthHex);
    await anvilSetBalance(anvil.rpcUrl, bobAccount.address, fundEthHex);
    await anvilSetBalance(anvil.rpcUrl, hubAccount.address, fundEthHex);

    const hubServer = await startRealHub({
      hubPrivateKey: TEST_KEYS.hub.privateKey,
      rpcUrl: anvil.rpcUrl,
      chainId: TAIKO_MAINNET_CHAIN_ID,
      paymentChannelAddress: addrs.PaymentChannel,
      adjudicatorAddress: addrs.Adjudicator,
    });

    return {
      rpcUrl: anvil.rpcUrl,
      chainId: TAIKO_MAINNET_CHAIN_ID,
      usdc,
      paymentChannel: addrs.PaymentChannel,
      adjudicator: addrs.Adjudicator,
      alice: { address: aliceAccount.address, privateKey: TEST_KEYS.alice.privateKey },
      bob: { address: bobAccount.address, privateKey: TEST_KEYS.bob.privateKey },
      hub: { address: hubAccount.address, privateKey: TEST_KEYS.hub.privateKey },
      hubServer,
      publicClient,
      mode: 'fork',
      async fundAndApproveParty(
        privateKey: Hex,
        usdcAmount: bigint = 100n * 10n ** 6n,
      ): Promise<E2EParty> {
        const newAccount = privateKeyToAccount(privateKey);
        await anvilSetBalance(
          anvil.rpcUrl,
          newAccount.address,
          `0x${(10n ** 19n).toString(16)}` as Hex,
        );
        await fundUsdcParty(anvil.rpcUrl, publicClient, usdc, newAccount.address, usdcAmount);
        const newWallet = createWalletClient({
          account: newAccount,
          chain: taiko,
          transport,
        });
        const apprHash = await newWallet.writeContract({
          account: newAccount,
          chain: taiko,
          address: usdc,
          abi: erc20Abi,
          functionName: 'approve',
          args: [addrs.PaymentChannel, 2n ** 256n - 1n],
        });
        await publicClient.waitForTransactionReceipt({ hash: apprHash });
        return { address: newAccount.address, privateKey };
      },
      async stop(): Promise<void> {
        await hubServer.stop();
        await anvil.stop();
      },
    };
  } catch (err) {
    await anvil.stop();
    throw err;
  }
}

export interface ClientBundle {
  readonly client: ChannelClient;
  readonly transport: WebSocketTransport;
  readonly storage: MemoryStorage;
}

export type AliceBundle = ClientBundle;

export interface BuildClientOpts {
  readonly encryption?: { publicKey: Hex; secretKey: Hex };
}

export function buildClient(
  h: E2EHandle,
  party: E2EParty,
  opts: BuildClientOpts = {},
): ClientBundle {
  const account = privateKeyToAccount(party.privateKey);
  const wallet = createWalletClient({
    account,
    chain: viemChainFor(h.chainId),
    transport: http(h.rpcUrl),
  });
  const transport = new WebSocketTransport({ url: h.hubServer.url, autoReconnect: false });
  const storage = new MemoryStorage();
  const client = new ChannelClient({
    signer: localSigner(party.privateKey),
    transport,
    storage,
    chain: new ViemChainAdapter({
      publicClient: h.publicClient,
      walletClient: wallet,
      paymentChannelAddress: h.paymentChannel,
    }),
    chainId: h.chainId,
    verifyingContract: h.adjudicator,
    defaultToken: h.usdc,
    hubFeeBps: 0n,
    hubFeeFlat: 0n,
    settleTimeoutMs: 10_000,
    closeRequestTimeoutMs: 10_000,
    ...(opts.encryption !== undefined
      ? {
          encryptionPubkey: opts.encryption.publicKey,
          encryptionSecretKey: opts.encryption.secretKey,
        }
      : {}),
  });
  return { client, transport, storage };
}

export function buildAliceClient(h: E2EHandle): AliceBundle {
  return buildClient(h, h.alice);
}

export type BobBundle = ClientBundle;

export function buildBobClient(h: E2EHandle, opts: BuildClientOpts = {}): BobBundle {
  return buildClient(h, h.bob, opts);
}

export function buildClientForParty(
  h: E2EHandle,
  party: E2EParty,
  opts: BuildClientOpts = {},
): ClientBundle {
  return buildClient(h, party, opts);
}

export async function timeWarp(rpcUrl: string, seconds: number): Promise<void> {
  const post = async (method: string, params: unknown[]): Promise<void> => {
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!r.ok) throw new Error(`${method} failed: ${r.status}`);
    const body = (await r.json()) as { error?: { message: string } };
    if (body.error) throw new Error(`${method} error: ${body.error.message}`);
  };
  await post('evm_increaseTime', [seconds]);
  await post('evm_mine', []);
}

const pendingWithdrawalsAbi = parseAbi([
  'function pendingWithdrawals(address token, address user) view returns (uint256)',
  'function withdraw(address token) external',
]);

export async function withdrawPending(
  h: E2EHandle,
  party: E2EParty,
  token: Address,
): Promise<void> {
  const pending = await h.publicClient.readContract({
    address: h.paymentChannel,
    abi: pendingWithdrawalsAbi,
    functionName: 'pendingWithdrawals',
    args: [token, party.address],
  });
  if (pending === 0n) return;
  const wallet = createWalletClient({
    account: privateKeyToAccount(party.privateKey),
    chain: viemChainFor(h.chainId),
    transport: http(h.rpcUrl),
  });
  const hash = await wallet.writeContract({
    address: h.paymentChannel,
    abi: pendingWithdrawalsAbi,
    functionName: 'withdraw',
    args: [token],
  });
  await h.publicClient.waitForTransactionReceipt({ hash });
}
