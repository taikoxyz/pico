import {
  type Address,
  CONTRACT_ADDRESSES,
  type ChainId,
  type ChannelId,
  TAIKO_HOODI_CHAIN_ID,
  TAIKO_MAINNET_CHAIN_ID,
} from '@inferenceroom/pico-protocol';
import {
  ChannelClient,
  ViemChainAdapter,
  WebSocketTransport,
  localSigner,
} from '@inferenceroom/pico-sdk';
import type { Command } from 'commander';
import { http, type Chain, createPublicClient, createWalletClient, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { resolvePrivateKey } from '../runtime/signer.js';
import { openStorage } from '../runtime/storage.js';

export interface ChannelCloseFromOpenDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: { write(s: string): void };
  readonly stderr?: { write(s: string): void };
  readonly storageOverride?: string;
  readonly chainIdOverride?: ChainId;
  readonly rpcUrlOverride?: string;
  readonly transportOverride?: ConstructorParameters<typeof WebSocketTransport>[0];
  readonly contractAddressOverride?: Address;
  readonly adjudicatorAddressOverride?: Address;
  readonly clientFactory?: (args: {
    privateKey: `0x${string}`;
    chainId: ChainId;
    rpcUrl: string;
    via: string;
  }) => { client: Pick<ChannelClient, 'closeUnilateralFromOpen'>; dispose: () => Promise<void> };
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

function explainError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('postedversion') || m.includes('not initial') || m.includes('has off-chain')) {
    return ' (this channel has off-chain state; use `pico channel close` instead)';
  }
  if (m.includes('status') || m.includes('not open')) {
    return ' (channel is not in `open` state; use `pico channel close` or check `pico channel list`)';
  }
  return '';
}

export function registerCloseFromOpen(parent: Command, deps: ChannelCloseFromOpenDeps = {}): void {
  parent
    .command('close-from-open <id>')
    .description(
      'Unilaterally close a freshly-opened channel with no off-chain state (anti-hostage path)',
    )
    .option('--via <url>', 'Hub WebSocket URL', 'ws://127.0.0.1:9050')
    .option('--rpc <url>', 'RPC URL')
    .option('--private-key <hex>', 'Private key (test/CI only)')
    .option('--key-file <path>', 'Encrypted or plaintext key file')
    .action(
      async (
        id: string,
        opts: {
          via: string;
          rpc?: string;
          privateKey?: `0x${string}`;
          keyFile?: string;
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
        const privateKey = await resolvePrivateKey({
          ...(opts.privateKey !== undefined ? { privateKey: opts.privateKey } : {}),
          ...(opts.keyFile !== undefined ? { keyFile: opts.keyFile } : {}),
          env,
        });

        let client: Pick<ChannelClient, 'closeUnilateralFromOpen'>;
        let dispose: () => Promise<void>;
        if (deps.clientFactory) {
          const made = deps.clientFactory({ privateKey, chainId, rpcUrl, via: opts.via });
          client = made.client;
          dispose = made.dispose;
        } else {
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
            deps.transportOverride ?? { url: opts.via, autoReconnect: false, signer },
          );
          const storage = openStorage(env, deps.storageOverride);
          const chainAdapter = new ViemChainAdapter({
            publicClient,
            walletClient,
            paymentChannelAddress,
          });
          const realClient = new ChannelClient({
            signer,
            transport,
            storage,
            chain: chainAdapter,
            chainId,
            verifyingContract: adjudicatorAddress,
          });
          await transport.connect();
          client = realClient;
          dispose = async () => {
            await transport.close();
          };
        }

        try {
          const result = await client.closeUnilateralFromOpen(id as ChannelId);
          const deadlineMs = Number(result.disputeDeadlineMs);
          const deadline = new Date(deadlineMs).toISOString();
          stdout.write(`closing-unilateral: ${id}\n`);
          stdout.write(`  txHash:           ${result.txHash}\n`);
          stdout.write(`  disputeDeadline:  ${deadline}\n`);
          stdout.write(
            'Funds will be available after the dispute window (24h on mainnet). Run `pico channel list` to track status.\n',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          stderr.write(`close-from-open failed: ${msg}${explainError(msg)}\n`);
          throw err;
        } finally {
          await dispose();
        }
      },
    );
}
