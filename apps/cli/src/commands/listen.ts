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
  type Signer,
  ViemChainAdapter,
  WebSocketTransport,
} from '@inferenceroom/pico-sdk';
import { Command } from 'commander';
import pino from 'pino';
import { http, type Chain, createPublicClient, createWalletClient, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadOrCreateKeysendKeypair } from '../runtime/keysend-keypair.js';
import { resolvePrivateKey } from '../runtime/signer.js';
import { openStorage } from '../runtime/storage.js';

export interface ListenDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: { write(s: string): void };
  readonly storageOverride?: string;
  readonly chainIdOverride?: ChainId;
  readonly contractAddressOverride?: Address;
  readonly adjudicatorAddressOverride?: Address;
  readonly transportOverride?: ConstructorParameters<typeof WebSocketTransport>[0];
  readonly signerOverride?: Signer;
  readonly logger?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void };
  readonly signal?: AbortSignal;
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

export function listenCommand(deps: ListenDeps = {}): Command {
  return new Command('listen')
    .description('Run as a long-lived receiver, settling inbound payments')
    .option('--hub <url>', 'Hub WebSocket URL', 'ws://127.0.0.1:9050')
    .option('--rpc <url>', 'RPC URL (optional, used for chain reads)')
    .option('--channel <id...>', 'Subscribe to specific channel ids (default: all)')
    .option('--private-key <hex>', 'Private key (test/CI only)')
    .option('--key-file <path>', 'Encrypted or plaintext key file')
    .option('--log-format <fmt>', 'pretty | json', 'pretty')
    .action(
      async (opts: {
        hub: string;
        rpc?: string;
        channel?: string[];
        privateKey?: `0x${string}`;
        keyFile?: string;
        logFormat: 'pretty' | 'json';
      }) => {
        const env = deps.env ?? process.env;
        const log =
          deps.logger ??
          pino(opts.logFormat === 'pretty' ? { transport: { target: 'pino-pretty' } } : {});
        const chainId = deps.chainIdOverride ?? TAIKO_MAINNET_CHAIN_ID;
        const paymentChannelAddress =
          deps.contractAddressOverride ?? CONTRACT_ADDRESSES[chainId].PaymentChannel;
        const verifyingContract =
          deps.adjudicatorAddressOverride ?? CONTRACT_ADDRESSES[chainId].Adjudicator;
        const rpcUrl =
          opts.rpc ?? env.PICO_RPC_URL ?? (chainFor(chainId).rpcUrls.default.http[0] as string);
        const privateKey = await resolvePrivateKey({
          ...(opts.privateKey !== undefined ? { privateKey: opts.privateKey } : {}),
          ...(opts.keyFile !== undefined ? { keyFile: opts.keyFile } : {}),
          env,
        });
        const account = privateKeyToAccount(privateKey);
        const chain = chainFor(chainId);
        const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
        const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
        const chainAdapter = new ViemChainAdapter({
          publicClient,
          walletClient,
          paymentChannelAddress,
        });
        const signer: Signer =
          deps.signerOverride ?? (await import('@inferenceroom/pico-sdk')).localSigner(privateKey);
        const transport = new WebSocketTransport(
          deps.transportOverride ?? { url: opts.hub, autoReconnect: true, signer },
        );
        const storage = openStorage(env, deps.storageOverride);
        // R-09: persist the keysend keypair so in-flight keysend payloads remain
        // decryptable across `listen` restarts. Without this the keypair was
        // regenerated each run and any in-flight keysend memo became unreadable.
        const keypair = loadOrCreateKeysendKeypair();

        const client = new ChannelClient({
          signer,
          transport,
          storage,
          chain: chainAdapter,
          chainId,
          verifyingContract,
          encryptionPubkey: keypair.publicKey,
          encryptionSecretKey: keypair.secretKey,
        });

        const offSettled = client.on('htlc:settled', (p) => {
          log.info(
            { channelId: p.channelId, htlcId: p.htlc.id, direction: p.direction },
            'htlc settled',
          );
        });
        const offFailed = client.on('htlc:failed', (p) => {
          log.warn({ channelId: p.channelId, htlcId: p.htlc.id, reason: p.reason }, 'htlc failed');
        });
        const offError = client.on('error', (p) => {
          log.warn({ err: p.error.message, context: p.context }, 'sdk error');
        });

        await transport.connect();
        const channels =
          opts.channel?.map((c) => c as ChannelId) ?? (await storage.list()).map((c) => c.id);
        await client.ensureSubscribed(channels);
        log.info(
          { hub: opts.hub, address: await signer.address(), channels: channels.length },
          'listen: started',
        );

        await new Promise<void>((resolve) => {
          const stop = async (): Promise<void> => {
            log.info({}, 'listen: shutdown');
            offSettled();
            offFailed();
            offError();
            await transport.close();
            resolve();
          };
          if (deps.signal) {
            if (deps.signal.aborted) void stop();
            else deps.signal.addEventListener('abort', () => void stop());
          } else {
            process.once('SIGINT', () => void stop());
            process.once('SIGTERM', () => void stop());
          }
        });
      },
    );
}
