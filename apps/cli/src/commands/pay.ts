import {
  type Address,
  CONTRACT_ADDRESSES,
  type ChainId,
  TAIKO_HOODI_CHAIN_ID,
  TAIKO_MAINNET_CHAIN_ID,
} from '@pico/protocol';
import {
  ChannelClient,
  type Signer,
  ViemChainAdapter,
  WebSocketTransport,
  generateKeysendKeypair,
} from '@pico/sdk';
import { Command } from 'commander';
import { http, type Chain, createPublicClient, createWalletClient, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeInvoiceEnvelope } from '../runtime/invoice-envelope.js';
import { emit } from '../runtime/output.js';
import { resolvePrivateKey } from '../runtime/signer.js';
import { openStorage } from '../runtime/storage.js';

export interface PayDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: { write(s: string): void };
  readonly storageOverride?: string;
  readonly chainIdOverride?: ChainId;
  readonly contractAddressOverride?: Address;
  readonly adjudicatorAddressOverride?: Address;
  readonly transportOverride?: ConstructorParameters<typeof WebSocketTransport>[0];
  readonly signerOverride?: Signer;
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

export function payCommand(deps: PayDeps = {}): Command {
  return new Command('pay')
    .description('Send a payment via invoice (default) or keysend')
    .option('--invoice <s>', 'Invoice envelope to pay')
    .option('--keysend', 'Push payment without an invoice', false)
    .option('--to <addr>', 'Recipient address (required with --keysend)')
    .option('--amount <usdc>', 'Amount in USDC base units (required with --keysend)')
    .option('--memo <s>', 'Optional memo (keysend only)')
    .option('--recipient-pubkey <hex>', 'Recipient encryption pubkey (required with --keysend)')
    .option('--via <url>', 'Hub WebSocket URL', 'ws://127.0.0.1:9050')
    .option('--rpc <url>', 'RPC URL (used for read-side; fees only)')
    .option('--private-key <hex>', 'Private key (test/CI only)')
    .option('--key-file <path>', 'Encrypted or plaintext key file')
    .option('--json', 'Emit one JSON object per state transition', false)
    .option(
      '--reveal-preimage',
      'Print the settlement preimage (off by default for security)',
      false,
    )
    .action(
      async (opts: {
        invoice?: string;
        keysend: boolean;
        to?: Address;
        amount?: string;
        memo?: string;
        recipientPubkey?: `0x${string}`;
        via: string;
        rpc?: string;
        privateKey?: `0x${string}`;
        keyFile?: string;
        json: boolean;
        revealPreimage: boolean;
      }) => {
        if (opts.invoice && opts.keysend) {
          throw new Error('--invoice and --keysend are mutually exclusive');
        }
        if (!opts.invoice && !opts.keysend) {
          throw new Error('one of --invoice or --keysend is required');
        }
        const env = deps.env ?? process.env;
        const stdout = deps.stdout ?? process.stdout;
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
        const transport = new WebSocketTransport(
          deps.transportOverride ?? { url: opts.via, autoReconnect: false },
        );
        const storage = openStorage(env, deps.storageOverride);
        const signer: Signer =
          deps.signerOverride ?? (await import('@pico/sdk')).localSigner(privateKey);

        let encryptionPubkey: `0x${string}` | undefined;
        let encryptionSecretKey: `0x${string}` | undefined;
        if (opts.keysend) {
          const kp = generateKeysendKeypair();
          encryptionPubkey = kp.publicKey;
          encryptionSecretKey = kp.secretKey;
        }

        const client = new ChannelClient({
          signer,
          transport,
          storage,
          chain: chainAdapter,
          chainId,
          verifyingContract,
          ...(encryptionPubkey !== undefined ? { encryptionPubkey } : {}),
          ...(encryptionSecretKey !== undefined ? { encryptionSecretKey } : {}),
        });

        try {
          await transport.connect();
          await client.ensureSubscribed([]);
          // F-06: redact preimages by default. Operator must opt in via
          // --reveal-preimage. Preimages settle matching HTLCs, so leaking
          // them in shell history / CI logs is fund-sensitive.
          const showPreimage = (p: string): string =>
            opts.revealPreimage ? p : '***redacted (use --reveal-preimage to show)***';
          if (opts.invoice) {
            const invoice = decodeInvoiceEnvelope(opts.invoice);
            if (opts.json) emit({ stage: 'verifying' }, stdout);
            const result = await client.pay({ invoice });
            if (opts.json) {
              emit(
                {
                  settled: true,
                  preimage: opts.revealPreimage ? result.preimage : undefined,
                  channelId: result.channelId,
                },
                stdout,
              );
            } else {
              stdout.write(`settled: ${showPreimage(result.preimage)}\n`);
            }
          } else {
            if (!opts.to || !opts.amount) {
              throw new Error('--keysend requires --to and --amount');
            }
            if (!opts.recipientPubkey) {
              throw new Error('--keysend requires --recipient-pubkey');
            }
            if (opts.json) emit({ stage: 'verifying' }, stdout);
            const result = await client.pay({
              to: opts.to,
              amount: BigInt(opts.amount),
              keysend: true,
              recipientEncryptionPubkey: opts.recipientPubkey,
              ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
            });
            if (opts.json) {
              emit(
                {
                  settled: true,
                  preimage: opts.revealPreimage ? result.preimage : undefined,
                  channelId: result.channelId,
                  keysend: true,
                },
                stdout,
              );
            } else {
              stdout.write(`settled (keysend): ${showPreimage(result.preimage)}\n`);
            }
          }
        } finally {
          await transport.close();
        }
      },
    );
}
