import {
  type Address,
  CONTRACT_ADDRESSES,
  type ChainId,
  type ChannelId,
  TAIKO_HOODI_CHAIN_ID,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
} from '@tainnel/protocol';
import { ChannelClient, ViemChainAdapter, WebSocketTransport, localSigner } from '@tainnel/sdk';
import { Command } from 'commander';
import { http, type Chain, createPublicClient, createWalletClient, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { emit, formatChannelTable } from '../runtime/output.js';
import { resolvePrivateKey } from '../runtime/signer.js';
import { openStorage } from '../runtime/storage.js';

export interface ChannelDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: { write(s: string): void };
  readonly stderr?: { write(s: string): void };
  readonly storageOverride?: string;
  readonly chainIdOverride?: ChainId;
  readonly rpcUrlOverride?: string;
  readonly transportOverride?: ConstructorParameters<typeof WebSocketTransport>[0];
  readonly contractAddressOverride?: Address;
  readonly tokenAddressOverride?: Address;
}

const TAIKO_MAINNET: Chain = defineChain({
  id: TAIKO_MAINNET_CHAIN_ID,
  name: 'Taiko Mainnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.taiko.xyz'] } },
});

const TAIKO_HOODI: Chain = defineChain({
  id: TAIKO_HOODI_CHAIN_ID,
  name: 'Taiko Hoodi Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.hoodi.taiko.xyz'] } },
});

function chainFor(id: ChainId): Chain {
  if (id === TAIKO_MAINNET_CHAIN_ID) return TAIKO_MAINNET;
  if (id === TAIKO_HOODI_CHAIN_ID) return TAIKO_HOODI;
  throw new Error(`unsupported chainId ${id as number}`);
}

export function channelCommand(deps: ChannelDeps = {}): Command {
  const cmd = new Command('channel').description('Manage payment channels');

  cmd
    .command('open')
    .description('Open a new payment channel with a hub')
    .requiredOption('--hub <addr>', 'Hub EVM address (counterparty)')
    .requiredOption('--amount <usdc>', 'Amount in USDC base units (6 decimals)')
    .option('--via <url>', 'Hub WebSocket URL', 'ws://127.0.0.1:9050')
    .option('--rpc <url>', 'RPC URL (defaults to TAINNEL_RPC_URL or chain default)')
    .option('--token <addr>', 'ERC-20 token address (defaults to USDC for chain)')
    .option('--private-key <hex>', 'Private key (test/CI only)')
    .option('--key-file <path>', 'Encrypted or plaintext key file')
    .option('--json', 'Emit JSON output', false)
    .action(
      async (opts: {
        hub: Address;
        amount: string;
        via: string;
        rpc?: string;
        token?: Address;
        privateKey?: `0x${string}`;
        keyFile?: string;
        json: boolean;
      }) => {
        const env = deps.env ?? process.env;
        const stdout = deps.stdout ?? process.stdout;
        const chainId = deps.chainIdOverride ?? TAIKO_MAINNET_CHAIN_ID;
        const rpcUrl =
          deps.rpcUrlOverride ??
          opts.rpc ??
          env.TAINNEL_RPC_URL ??
          (chainFor(chainId).rpcUrls.default.http[0] as string);
        const privateKey = await resolvePrivateKey({
          ...(opts.privateKey !== undefined ? { privateKey: opts.privateKey } : {}),
          ...(opts.keyFile !== undefined ? { keyFile: opts.keyFile } : {}),
          env,
        });
        const account = privateKeyToAccount(privateKey);
        const chain = chainFor(chainId);
        const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
        const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
        const paymentChannelAddress =
          deps.contractAddressOverride ?? CONTRACT_ADDRESSES[chainId].PaymentChannel;
        const token = opts.token ?? deps.tokenAddressOverride ?? USDC_TOKENS[chainId].address;

        const transport = new WebSocketTransport(
          deps.transportOverride ?? { url: opts.via, autoReconnect: false },
        );
        const storage = openStorage(env, deps.storageOverride);
        const signer = localSigner(privateKey);
        const chainAdapter = new ViemChainAdapter({
          publicClient,
          walletClient,
          paymentChannelAddress,
        });
        const client = new ChannelClient({
          signer,
          transport,
          storage,
          chain: chainAdapter,
          chainId,
          verifyingContract: paymentChannelAddress,
          defaultToken: token,
        });
        try {
          await transport.connect();
          const channel = await client.open({
            counterparty: opts.hub,
            amount: BigInt(opts.amount),
            token,
          });
          if (opts.json) emit(channel, stdout);
          else stdout.write(`opened: ${channel.id}\n`);
        } finally {
          await transport.close();
        }
      },
    );

  cmd
    .command('list')
    .description('List local channels')
    .option('--json', 'Output JSON array', false)
    .action(async (opts: { json: boolean }) => {
      const env = deps.env ?? process.env;
      const stdout = deps.stdout ?? process.stdout;
      const storage = openStorage(env, deps.storageOverride);
      const list = await storage.list();
      if (opts.json) emit(list, stdout);
      else stdout.write(`${formatChannelTable(list)}\n`);
    });

  cmd
    .command('close <id>')
    .description('Close a channel by id')
    .option('--cooperative', 'Try cooperative close first (default true)', true)
    .option('--unilateral', 'Skip cooperative attempt and force unilateral close', false)
    .option('--via <url>', 'Hub WebSocket URL', 'ws://127.0.0.1:9050')
    .option('--rpc <url>', 'RPC URL')
    .option('--private-key <hex>', 'Private key (test/CI only)')
    .option('--key-file <path>', 'Encrypted or plaintext key file')
    .action(
      async (
        id: string,
        opts: {
          cooperative: boolean;
          unilateral: boolean;
          via: string;
          rpc?: string;
          privateKey?: `0x${string}`;
          keyFile?: string;
        },
      ) => {
        const env = deps.env ?? process.env;
        const stdout = deps.stdout ?? process.stdout;
        const chainId = deps.chainIdOverride ?? TAIKO_MAINNET_CHAIN_ID;
        const rpcUrl =
          deps.rpcUrlOverride ??
          opts.rpc ??
          env.TAINNEL_RPC_URL ??
          (chainFor(chainId).rpcUrls.default.http[0] as string);
        const privateKey = await resolvePrivateKey({
          ...(opts.privateKey !== undefined ? { privateKey: opts.privateKey } : {}),
          ...(opts.keyFile !== undefined ? { keyFile: opts.keyFile } : {}),
          env,
        });
        const account = privateKeyToAccount(privateKey);
        const chain = chainFor(chainId);
        const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
        const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
        const paymentChannelAddress =
          deps.contractAddressOverride ?? CONTRACT_ADDRESSES[chainId].PaymentChannel;
        const transport = new WebSocketTransport(
          deps.transportOverride ?? { url: opts.via, autoReconnect: false },
        );
        const storage = openStorage(env, deps.storageOverride);
        const signer = localSigner(privateKey);
        const chainAdapter = new ViemChainAdapter({
          publicClient,
          walletClient,
          paymentChannelAddress,
        });
        const client = new ChannelClient({
          signer,
          transport,
          storage,
          chain: chainAdapter,
          chainId,
          verifyingContract: paymentChannelAddress,
        });
        try {
          await transport.connect();
          await client.close(id as ChannelId, { cooperative: !opts.unilateral });
          stdout.write(`closed: ${id}\n`);
        } finally {
          await transport.close();
        }
      },
    );

  return cmd;
}
