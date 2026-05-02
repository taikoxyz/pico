import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BuildServerResult, buildServer } from '@tainnel/hub';
import { ANVIL_DEV_CHAIN_ID, type Channel, type SignedState } from '@tainnel/protocol';
import {
  ChannelClient,
  MemoryStorage,
  ViemChainAdapter,
  WebSocketTransport,
  encodeChannelStateForOnChain,
  localSigner,
  signatureToHex,
} from '@tainnel/sdk';
import { TEST_KEYS, startAnvilFork } from '@tainnel/test-utils';
import {
  http,
  type Abi,
  type Address,
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
import { foundry } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type WatchtowerHandle, startWatchtower } from './index.js';

const ANVIL_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const USDC_DECIMALS = 6;
const ONE_USDC = 1_000_000n;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_OUT = join(__dirname, '..', '..', '..', 'packages', 'contracts', 'out');

interface ForgeArtifact {
  readonly abi: Abi;
  readonly bytecode: { readonly object: Hex };
}

function loadArtifact(folder: string, name: string): ForgeArtifact {
  const raw = readFileSync(join(CONTRACTS_OUT, folder, `${name}.json`), 'utf8');
  return JSON.parse(raw) as ForgeArtifact;
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

async function anvilTimeWarp(rpcUrl: string, seconds: number): Promise<void> {
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

const paymentChannelAbi = parseAbi([
  'function closeUnilateral(bytes32 channelId, bytes state, bytes sigCounterparty)',
  'function finalize(bytes32 channelId)',
  'function channels(bytes32) view returns (address userA, address userB, address token, uint256 amountA, uint256 amountB, uint64 openedAt, uint64 disputeDeadline, uint64 postedVersion, uint256 postedBalanceA, uint256 postedBalanceB, bool penalized, uint8 status, address closer)',
]);

interface IntegrationFixture {
  rpcUrl: string;
  publicClient: PublicClient;
  paymentChannel: Address;
  adjudicator: Address;
  usdc: Address;
  hubServer: BuildServerResult;
  hubServerUrl: string;
  client: ChannelClient;
  clientTransport: WebSocketTransport;
  clientStorage: MemoryStorage;
  alice: { address: Address; privateKey: Hex };
  hub: { address: Address; privateKey: Hex };
  stop: () => Promise<void>;
}

async function bootIntegration(): Promise<IntegrationFixture> {
  const mockErc20 = loadArtifact('MockERC20.sol', 'MockERC20');
  const adjudicatorArtifact = loadArtifact('Adjudicator.sol', 'Adjudicator');
  const paymentChannelArtifact = loadArtifact('PaymentChannel.sol', 'PaymentChannel');
  const erc1967Proxy = loadArtifact('ERC1967Proxy.sol', 'ERC1967Proxy');

  const anvil = await startAnvilFork({
    chainId: ANVIL_DEV_CHAIN_ID,
    accounts: 10,
    silent: true,
  });

  try {
    const transport = http(anvil.rpcUrl);
    const publicClient = createPublicClient({ chain: foundry, transport }) as PublicClient;

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
      const mintHash = await deployerWallet.writeContract({
        account: deployerAccount,
        chain: foundry,
        address: usdc,
        abi: mockErc20.abi,
        functionName: 'mint',
        args: [to, 100n * ONE_USDC],
      });
      await publicClient.waitForTransactionReceipt({ hash: mintHash });
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

    const hubServer = await buildServer({
      HUB_PRIVATE_KEY: TEST_KEYS.hub.privateKey,
      RPC_URL: anvil.rpcUrl,
      CHAIN_ID: String(ANVIL_DEV_CHAIN_ID),
      PAYMENT_CHANNEL_ADDRESS: paymentChannel,
      ADJUDICATOR_ADDRESS: adjudicator,
      HUB_FEE_BPS: '0',
      HUB_FEE_FLAT: '0',
      LOG_LEVEL: 'silent',
      PORT: '0',
      TAINNEL_DEV_ALLOW_ZERO_ADDRESS: 'true',
      TAINNEL_SKIP_PROD_ASSERT: 'true',
    });
    const httpUrl = await hubServer.app.listen({ port: 0, host: '127.0.0.1' });
    const wsUrl = `${httpUrl.replace(/^http/, 'ws')}/ws`;

    const clientTransport = new WebSocketTransport({ url: wsUrl, autoReconnect: false });
    const clientStorage = new MemoryStorage();
    const aliceWalletForClient = createWalletClient({
      account: aliceAccount,
      chain: foundry,
      transport,
    });
    const client = new ChannelClient({
      signer: localSigner(TEST_KEYS.alice.privateKey),
      transport: clientTransport,
      storage: clientStorage,
      chain: new ViemChainAdapter({
        publicClient,
        walletClient: aliceWalletForClient,
        paymentChannelAddress: paymentChannel,
      }),
      chainId: ANVIL_DEV_CHAIN_ID,
      verifyingContract: adjudicator,
      defaultToken: usdc,
      hubFeeBps: 0n,
      hubFeeFlat: 0n,
      settleTimeoutMs: 10_000,
      closeRequestTimeoutMs: 10_000,
    });

    return {
      rpcUrl: anvil.rpcUrl,
      publicClient,
      paymentChannel,
      adjudicator,
      usdc,
      hubServer,
      hubServerUrl: wsUrl,
      client,
      clientTransport,
      clientStorage,
      alice: { address: aliceAccount.address, privateKey: TEST_KEYS.alice.privateKey },
      hub: { address: hubAccount.address, privateKey: TEST_KEYS.hub.privateKey },
      async stop(): Promise<void> {
        try {
          await clientTransport.close();
        } catch {
          // ignore
        }
        try {
          await hubServer.app.close();
        } catch {
          // ignore
        }
        await anvil.stop();
      },
    };
  } catch (err) {
    await anvil.stop();
    throw err;
  }
}

describe('integration: watchtower catches stale-state fraud on anvil', () => {
  let f: IntegrationFixture | undefined;
  let watchtower: WatchtowerHandle | undefined;

  beforeEach(async () => {
    f = await bootIntegration();
  }, 60_000);

  afterEach(async () => {
    if (watchtower) {
      try {
        await watchtower.stop();
      } catch {
        // ignore
      }
      watchtower = undefined;
    }
    if (f) {
      await f.stop();
      f = undefined;
    }
  });

  it('hub posts stale v3, watchtower disputes with v6, alice gets full pot after finalize', async () => {
    if (!f) throw new Error('fixture not initialized');
    const fixture = f;

    const channel: Channel = await fixture.client.open({
      counterparty: fixture.hub.address,
      amount: 100n * ONE_USDC,
    });
    const v1 = await fixture.clientStorage.loadLatestState(channel.id);
    if (!v1) throw new Error('no v1 state after open');
    expect(v1.state.version).toBe(1n);
    fixture.hubServer.api.ws.registerChannel(channel, v1);

    const watchtowerKey = TEST_KEYS.watchtower.privateKey;
    const watchtowerAccount = privateKeyToAccount(watchtowerKey);
    await anvilSetBalance(
      fixture.rpcUrl,
      watchtowerAccount.address,
      `0x${(10n ** 18n).toString(16)}` as Hex,
    );

    watchtower = await startWatchtower({
      rpcUrl: fixture.rpcUrl,
      privateKey: watchtowerKey,
      paymentChannelAddress: fixture.paymentChannel,
      chainId: ANVIL_DEV_CHAIN_ID,
      pollingIntervalMs: 100,
      confirmations: 1,
      schedulerIntervalMs: 1_000,
      startHttp: false,
    });
    await watchtower.remember(v1);

    await fixture.client.payDirect(channel.id, { amount: 5n * ONE_USDC });
    const v2 = await fixture.clientStorage.loadLatestState(channel.id);
    if (!v2) throw new Error('no v2 state');
    await watchtower.remember(v2);

    await fixture.client.payDirect(channel.id, { amount: 3n * ONE_USDC });
    const v3 = await fixture.clientStorage.loadLatestState(channel.id);
    if (!v3) throw new Error('no v3 state');
    await watchtower.remember(v3);

    await fixture.client.payDirect(channel.id, { amount: 2n * ONE_USDC });
    const v4 = await fixture.clientStorage.loadLatestState(channel.id);
    if (!v4) throw new Error('no v4 state');
    await watchtower.remember(v4);

    await fixture.client.payDirect(channel.id, { amount: 4n * ONE_USDC });
    const v5 = await fixture.clientStorage.loadLatestState(channel.id);
    if (!v5) throw new Error('no v5 state');
    await watchtower.remember(v5);

    await fixture.client.payDirect(channel.id, { amount: 1n * ONE_USDC });
    const v6 = await fixture.clientStorage.loadLatestState(channel.id);
    if (!v6) throw new Error('no v6 state');
    expect(v6.state.version).toBe(6n);
    await watchtower.remember(v6);

    const stale: SignedState = v3;

    const hubAttackerWallet = createWalletClient({
      account: privateKeyToAccount(fixture.hub.privateKey),
      chain: foundry,
      transport: http(fixture.rpcUrl),
    });
    const closeHash = await hubAttackerWallet.writeContract({
      address: fixture.paymentChannel,
      abi: paymentChannelAbi,
      functionName: 'closeUnilateral',
      args: [channel.id, encodeChannelStateForOnChain(stale.state), signatureToHex(stale.sigA)],
    });
    await fixture.publicClient.waitForTransactionReceipt({ hash: closeHash });

    let posted = 0n;
    let penalized = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const row = await fixture.publicClient.readContract({
        address: fixture.paymentChannel,
        abi: paymentChannelAbi,
        functionName: 'channels',
        args: [channel.id],
      });
      posted = row[7];
      penalized = row[10];
      if (posted === 6n && penalized) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(posted).toBe(6n);
    expect(penalized).toBe(true);

    await anvilTimeWarp(fixture.rpcUrl, 24 * 60 * 60 + 1);

    const aliceWallet = createWalletClient({
      account: privateKeyToAccount(fixture.alice.privateKey),
      chain: foundry,
      transport: http(fixture.rpcUrl),
    });
    const finalizeHash = await aliceWallet.writeContract({
      address: fixture.paymentChannel,
      abi: paymentChannelAbi,
      functionName: 'finalize',
      args: [channel.id],
    });
    await fixture.publicClient.waitForTransactionReceipt({ hash: finalizeHash });

    const aliceUsdc = await fixture.publicClient.readContract({
      address: fixture.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [fixture.alice.address],
    });
    const hubUsdc = await fixture.publicClient.readContract({
      address: fixture.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [fixture.hub.address],
    });
    expect(aliceUsdc).toBe(100n * ONE_USDC);
    expect(hubUsdc).toBe(100n * ONE_USDC);

    const knownLatest = watchtower.detector.getLatest(channel.id);
    expect(knownLatest?.state.version).toBe(6n);
  }, 90_000);
});
