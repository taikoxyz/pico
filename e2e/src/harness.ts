import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANVIL_DEV_CHAIN_ID,
  CONTRACT_ADDRESSES,
  type ChainId,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
} from '@tainnel/protocol';
import {
  ChannelClient,
  MemoryStorage,
  ViemChainAdapter,
  WebSocketTransport,
  localSigner,
} from '@tainnel/sdk';
import {
  type AnvilHandle,
  type MockHubHandle,
  TEST_KEYS,
  startAnvilFork,
  startMockHub,
} from '@tainnel/test-utils';
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
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, taiko } from 'viem/chains';

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
}

export interface E2EParty {
  readonly address: Address;
  readonly privateKey: Hex;
}

export interface E2EHandle {
  readonly rpcUrl: string;
  readonly chainId: ChainId;
  readonly usdc: Address;
  readonly paymentChannel: Address;
  readonly adjudicator: Address;
  readonly alice: E2EParty;
  readonly hub: E2EParty;
  readonly hubServer: MockHubHandle;
  readonly publicClient: PublicClient;
  readonly mode: 'vanilla' | 'fork';
  stop(): Promise<void>;
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
  return bootVanillaMode();
}

async function bootVanillaMode(): Promise<E2EHandle> {
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
    const hubWallet = createWalletClient({
      account: hubAccount,
      chain: foundry,
      transport,
    });

    const fundEth = 10n ** 18n;
    for (const to of [aliceAccount.address, hubAccount.address]) {
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

    for (const to of [aliceAccount.address, hubAccount.address]) {
      const hash = await deployerWallet.writeContract({
        account: deployerAccount,
        chain: foundry,
        address: usdc,
        abi: mockErc20.abi,
        functionName: 'mint',
        args: [to, 100n * ONE_USDC],
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

    for (const wallet of [aliceWallet, hubWallet]) {
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

    const hubServer = await startMockHub({
      chainId: ANVIL_DEV_CHAIN_ID,
      verifyingContract: adjudicator,
      hubPrivateKey: TEST_KEYS.hub.privateKey,
    });

    return {
      rpcUrl: anvil.rpcUrl,
      chainId: ANVIL_DEV_CHAIN_ID,
      usdc,
      paymentChannel,
      adjudicator,
      alice: { address: aliceAccount.address, privateKey: TEST_KEYS.alice.privateKey },
      hub: { address: hubAccount.address, privateKey: TEST_KEYS.hub.privateKey },
      hubServer,
      publicClient,
      mode: 'vanilla',
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
    const hubAccount = privateKeyToAccount(TEST_KEYS.hub.privateKey);

    const fundEthHex = `0x${(10n ** 19n).toString(16)}` as Hex; // 10 ETH each
    await anvilSetBalance(anvil.rpcUrl, aliceAccount.address, fundEthHex);
    await anvilSetBalance(anvil.rpcUrl, hubAccount.address, fundEthHex);

    const hubServer = await startMockHub({
      chainId: TAIKO_MAINNET_CHAIN_ID,
      verifyingContract: addrs.Adjudicator,
      hubPrivateKey: TEST_KEYS.hub.privateKey,
    });

    return {
      rpcUrl: anvil.rpcUrl,
      chainId: TAIKO_MAINNET_CHAIN_ID,
      usdc,
      paymentChannel: addrs.PaymentChannel,
      adjudicator: addrs.Adjudicator,
      alice: { address: aliceAccount.address, privateKey: TEST_KEYS.alice.privateKey },
      hub: { address: hubAccount.address, privateKey: TEST_KEYS.hub.privateKey },
      hubServer,
      publicClient,
      mode: 'fork',
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

export interface AliceBundle {
  readonly client: ChannelClient;
  readonly transport: WebSocketTransport;
  readonly storage: MemoryStorage;
}

export function buildAliceClient(h: E2EHandle): AliceBundle {
  const aliceAccount = privateKeyToAccount(h.alice.privateKey);
  const aliceWallet = createWalletClient({
    account: aliceAccount,
    chain: viemChainFor(h.chainId),
    transport: http(h.rpcUrl),
  });
  const transport = new WebSocketTransport({ url: h.hubServer.url, autoReconnect: false });
  const storage = new MemoryStorage();
  const client = new ChannelClient({
    signer: localSigner(h.alice.privateKey),
    transport,
    storage,
    chain: new ViemChainAdapter({
      publicClient: h.publicClient,
      walletClient: aliceWallet,
      paymentChannelAddress: h.paymentChannel,
    }),
    chainId: h.chainId,
    verifyingContract: h.adjudicator,
    defaultToken: h.usdc,
    settleTimeoutMs: 10_000,
    closeRequestTimeoutMs: 10_000,
  });
  return { client, transport, storage };
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
