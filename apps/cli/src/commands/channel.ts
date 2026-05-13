import {
  type Address,
  CONTRACT_ADDRESSES,
  type ChainId,
  type ChannelId,
  TAIKO_HOODI_CHAIN_ID,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
  ZERO_ADDRESS,
} from '@inferenceroom/pico-protocol';
import {
  ChannelClient,
  ViemChainAdapter,
  WebSocketTransport,
  localSigner,
} from '@inferenceroom/pico-sdk';
import { Command } from 'commander';
import {
  http,
  type Chain,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  formatCliError,
  parseAmount,
  readAllowance,
  readTokenDecimals,
  resolveHubUrl,
  warnLocalhostHubOnMainnet,
} from '../runtime/cli-helpers.js';
import { emit, formatChannelTable } from '../runtime/output.js';
import { resolvePrivateKey } from '../runtime/signer.js';
import { openStorage } from '../runtime/storage.js';
import { registerCloseFromOpen } from './channel-close-from-open.js';

export interface ChannelDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: { write(s: string): void };
  readonly stderr?: { write(s: string): void };
  readonly storageOverride?: string;
  readonly chainIdOverride?: ChainId;
  readonly rpcUrlOverride?: string;
  readonly transportOverride?: ConstructorParameters<typeof WebSocketTransport>[0];
  readonly contractAddressOverride?: Address;
  readonly adjudicatorAddressOverride?: Address;
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
    .requiredOption(
      '--amount <amount>',
      'Amount in human units (e.g. 10 or 10.5). Use --raw-amount for raw base units.',
    )
    .option('--raw-amount', 'Interpret --amount as raw integer base units (legacy behavior)', false)
    .option(
      '--via <url>',
      'Hub WebSocket URL (defaults to chain-canonical or $PICO_HUB_URL)',
      'ws://127.0.0.1:9050',
    )
    .option('--rpc <url>', 'RPC URL (defaults to PICO_RPC_URL or chain default)')
    .option('--token <addr>', 'ERC-20 token address (defaults to USDC for chain)')
    .option('--no-approve', 'Skip the auto-approve step (legacy: caller must approve out-of-band)')
    .option('--private-key <hex>', 'Private key (test/CI only)')
    .option('--key-file <path>', 'Encrypted or plaintext key file')
    .option('--json', 'Emit JSON output', false)
    .action(
      async (opts: {
        hub: Address;
        amount: string;
        rawAmount: boolean;
        via: string;
        rpc?: string;
        token?: Address;
        approve: boolean;
        privateKey?: `0x${string}`;
        keyFile?: string;
        json: boolean;
      }) => {
        const env = deps.env ?? process.env;
        const stdout = deps.stdout ?? process.stdout;
        const stderr = deps.stderr ?? process.stderr;
        const chainId = deps.chainIdOverride ?? TAIKO_MAINNET_CHAIN_ID;
        const rpcUrl =
          deps.rpcUrlOverride ??
          opts.rpc ??
          env.PICO_RPC_URL ??
          (chainFor(chainId).rpcUrls.default.http[0] as string);
        const hubUrl = resolveHubUrl({ via: opts.via, env, chainId });
        warnLocalhostHubOnMainnet({ hubUrl, chainId, stderr });
        try {
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
          const adjudicatorAddress =
            deps.adjudicatorAddressOverride ?? CONTRACT_ADDRESSES[chainId].Adjudicator;
          const token = opts.token ?? deps.tokenAddressOverride ?? USDC_TOKENS[chainId].address;

          const decimals = await readTokenDecimals({
            client: publicClient as unknown as PublicClient,
            token,
          });
          const amount = parseAmount({
            amount: opts.amount,
            decimals,
            rawMode: opts.rawAmount,
          });

          let approveTxHash: `0x${string}` | undefined;
          if (opts.approve && token !== ZERO_ADDRESS) {
            const current = await readAllowance({
              client: publicClient as unknown as PublicClient,
              token,
              owner: account.address,
              spender: paymentChannelAddress,
            });
            if (current < amount) {
              if (!opts.json) {
                stderr.write(
                  `auto-approving ${formatUnits(amount, decimals)} of token ${token} for PaymentChannel ${paymentChannelAddress} (current allowance ${formatUnits(current, decimals)})\n`,
                );
              }
              approveTxHash = await walletClient.writeContract({
                address: token,
                abi: erc20Abi,
                functionName: 'approve',
                args: [paymentChannelAddress, amount],
                account,
                chain,
              });
              await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
            }
          }

          const signer = localSigner(privateKey);
          const transport = new WebSocketTransport(
            deps.transportOverride ?? { url: hubUrl, autoReconnect: false, signer },
          );
          const storage = openStorage(env, deps.storageOverride);
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
            verifyingContract: adjudicatorAddress,
            defaultToken: token,
          });
          try {
            await transport.connect();
            const opened = await client.open({
              counterparty: opts.hub,
              amount,
              token,
            });
            const payload = {
              channelId: opened.channel.id,
              openTxHash: opened.txHash,
              blockNumber: opened.blockNumber.toString(),
              ...(approveTxHash ? { approveTxHash } : {}),
              channel: opened.channel,
            };
            if (opts.json) emit(payload, stdout);
            else {
              if (approveTxHash) stdout.write(`approve tx: ${approveTxHash}\n`);
              stdout.write(`openChannel tx: ${opened.txHash}\n`);
              stdout.write(`channelId:     ${opened.channel.id}\n`);
              stdout.write(`block:         ${opened.blockNumber.toString()}\n`);
            }
          } finally {
            await transport.close();
          }
        } catch (err) {
          stderr.write(formatCliError(err));
          process.exitCode = 1;
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
    .option(
      '--via <url>',
      'Hub WebSocket URL (defaults to chain-canonical or $PICO_HUB_URL)',
      'ws://127.0.0.1:9050',
    )
    .option('--rpc <url>', 'RPC URL')
    .option('--private-key <hex>', 'Private key (test/CI only)')
    .option('--key-file <path>', 'Encrypted or plaintext key file')
    .option('--json', 'Emit JSON output', false)
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
          json: boolean;
        },
      ) => {
        const env = deps.env ?? process.env;
        const stdout = deps.stdout ?? process.stdout;
        const stderr = deps.stderr ?? process.stderr;
        const chainId = deps.chainIdOverride ?? TAIKO_MAINNET_CHAIN_ID;
        const rpcUrl =
          deps.rpcUrlOverride ??
          opts.rpc ??
          env.PICO_RPC_URL ??
          (chainFor(chainId).rpcUrls.default.http[0] as string);
        const hubUrl = resolveHubUrl({ via: opts.via, env, chainId });
        warnLocalhostHubOnMainnet({ hubUrl, chainId, stderr });
        try {
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
          const adjudicatorAddress =
            deps.adjudicatorAddressOverride ?? CONTRACT_ADDRESSES[chainId].Adjudicator;
          const signer = localSigner(privateKey);
          const transport = new WebSocketTransport(
            deps.transportOverride ?? { url: hubUrl, autoReconnect: false, signer },
          );
          const storage = openStorage(env, deps.storageOverride);
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
            verifyingContract: adjudicatorAddress,
          });
          try {
            await transport.connect();
            const result = await client.close(id as ChannelId, { cooperative: !opts.unilateral });
            const payload = {
              channelId: id,
              kind: result.kind,
              txHash: result.txHash,
              blockNumber: result.blockNumber.toString(),
            };
            if (opts.json) emit(payload, stdout);
            else {
              stdout.write(`close (${result.kind}) tx: ${result.txHash}\n`);
              stdout.write(`channelId:           ${id}\n`);
              stdout.write(`block:               ${result.blockNumber.toString()}\n`);
            }
          } finally {
            await transport.close();
          }
        } catch (err) {
          stderr.write(formatCliError(err));
          process.exitCode = 1;
        }
      },
    );

  registerCloseFromOpen(cmd, deps);

  return cmd;
}
