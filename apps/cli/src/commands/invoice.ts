import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Address,
  CONTRACT_ADDRESSES,
  type ChainId,
  type PaymentHash,
  TAIKO_MAINNET_CHAIN_ID,
} from '@inferenceroom/pico-protocol';
import {
  ChannelClient,
  type InvoiceRecord,
  type Signer,
  ViemChainAdapter,
  WebSocketTransport,
} from '@inferenceroom/pico-sdk';
import type { FileStorage } from '@inferenceroom/pico-sdk';
import { Command } from 'commander';
import { http, createPublicClient, createWalletClient } from 'viem';
import { defaultDbDir } from '../runtime/config.js';
import { encodeInvoiceEnvelope } from '../runtime/invoice-envelope.js';
import { emit } from '../runtime/output.js';
import { resolveSigner } from '../runtime/signer.js';
import { openStorage } from '../runtime/storage.js';

interface SerializedInvoiceFile {
  invoice: {
    paymentHash: string;
    amount: string;
    recipient: string;
    expiryMs: string;
    nonce: string;
    memo?: string;
    hubHint?: string;
    signature: string;
  };
  preimage: string;
  consumedAt?: number;
}

function listInvoiceFiles(root: string): InvoiceRecord[] {
  const dir = join(root, 'invoices');
  if (!existsSync(dir)) return [];
  const out: InvoiceRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    const ser = JSON.parse(text) as SerializedInvoiceFile;
    out.push({
      invoice: {
        paymentHash: ser.invoice.paymentHash as `0x${string}`,
        amount: BigInt(ser.invoice.amount),
        recipient: ser.invoice.recipient as `0x${string}`,
        expiryMs: BigInt(ser.invoice.expiryMs),
        nonce: ser.invoice.nonce as `0x${string}`,
        signature: ser.invoice.signature as `0x${string}`,
        ...(ser.invoice.memo !== undefined ? { memo: ser.invoice.memo } : {}),
        ...(ser.invoice.hubHint !== undefined ? { hubHint: ser.invoice.hubHint } : {}),
      },
      preimage: ser.preimage as `0x${string}`,
      ...(ser.consumedAt !== undefined ? { consumedAt: ser.consumedAt } : {}),
    });
  }
  return out;
}

async function listInvoiceRecords(_storage: FileStorage): Promise<InvoiceRecord[]> {
  return [];
}
void listInvoiceRecords;

export interface InvoiceDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly resolveSigner?: typeof resolveSigner;
  readonly openStorage?: (env: NodeJS.ProcessEnv, override?: string) => FileStorage;
  readonly stdout?: { write(s: string): void };
  readonly storageOverride?: string;
  readonly chainIdOverride?: ChainId;
  readonly contractAddressOverride?: Address;
}

interface NoopChainAdapter {
  openChannel(): Promise<never>;
  closeCooperative(): Promise<never>;
  closeUnilateral(): Promise<never>;
  finalize(): Promise<never>;
  waitForFinalized(): Promise<never>;
}

function noopChain(): NoopChainAdapter {
  const fail = (op: string) => async (): Promise<never> => {
    throw new Error(`pico invoice: chain.${op} should not be called`);
  };
  return {
    openChannel: fail('openChannel'),
    closeCooperative: fail('closeCooperative'),
    closeUnilateral: fail('closeUnilateral'),
    finalize: fail('finalize'),
    waitForFinalized: fail('waitForFinalized'),
  };
}

function noopTransport(): {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(): Promise<void>;
  request(): Promise<never>;
  onMessage(): () => void;
  onReconnect(): () => void;
  isConnected(): boolean;
} {
  return {
    async connect() {},
    async close() {},
    async send() {},
    request: async () => {
      throw new Error('pico invoice: transport.request should not be called');
    },
    onMessage: () => () => {},
    onReconnect: () => () => {},
    isConnected: () => false,
  };
}

function buildClient(opts: {
  readonly env: NodeJS.ProcessEnv;
  readonly storageOverride?: string;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
  readonly signer: Signer;
  readonly openStorage: (env: NodeJS.ProcessEnv, override?: string) => FileStorage;
}): ChannelClient {
  return new ChannelClient({
    signer: opts.signer,
    transport: noopTransport() as unknown as ConstructorParameters<
      typeof ChannelClient
    >[0]['transport'],
    storage: opts.openStorage(opts.env, opts.storageOverride),
    chain: noopChain() as unknown as ConstructorParameters<typeof ChannelClient>[0]['chain'],
    chainId: opts.chainId,
    verifyingContract: opts.verifyingContract,
  });
}

export function invoiceCommand(deps: InvoiceDeps = {}): Command {
  const cmd = new Command('invoice').description('Invoice operations');

  cmd
    .command('create')
    .description('Create a signed invoice and persist it locally')
    .requiredOption(
      '--amount <raw>',
      "Amount in raw base units of the paying channel's token (e.g. 1000000 = 1 USDC at 6 decimals, or 1000000000000000 = 0.001 ETH at 18 decimals). The invoice itself is token-agnostic; the paying channel's token decides what the units mean.",
    )
    .option('--memo <s>', 'Optional memo')
    .option('--expiry <s>', 'Expiry seconds from now', '3600')
    .option('--hub-hint <url>', 'Optional hub URL hint for the payer')
    .option('--private-key <hex>', 'Private key (test/CI only)')
    .option('--key-file <path>', 'Encrypted or plaintext key file')
    .option('--json', 'Emit JSON output instead of an envelope', false)
    .option('--reveal-preimage', 'Include the preimage in the JSON output (off by default)', false)
    .action(
      async (opts: {
        amount: string;
        memo?: string;
        expiry: string;
        hubHint?: string;
        privateKey?: `0x${string}`;
        keyFile?: string;
        json: boolean;
        revealPreimage: boolean;
      }) => {
        const env = deps.env ?? process.env;
        const stdout = deps.stdout ?? process.stdout;
        const chainId = deps.chainIdOverride ?? TAIKO_MAINNET_CHAIN_ID;
        const verifyingContract =
          deps.contractAddressOverride ?? CONTRACT_ADDRESSES[chainId].PaymentChannel;
        const signer = await (deps.resolveSigner ?? resolveSigner)({
          ...(opts.privateKey !== undefined ? { privateKey: opts.privateKey } : {}),
          ...(opts.keyFile !== undefined ? { keyFile: opts.keyFile } : {}),
          env,
        });
        const client = buildClient({
          env,
          ...(deps.storageOverride !== undefined ? { storageOverride: deps.storageOverride } : {}),
          chainId,
          verifyingContract,
          signer,
          openStorage: deps.openStorage ?? openStorage,
        });
        const expiryMs = BigInt(Date.now() + Number(opts.expiry) * 1000);
        const created = await client.createInvoice({
          amount: BigInt(opts.amount),
          expiryMs,
          ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
          ...(opts.hubHint !== undefined ? { hubHint: opts.hubHint } : {}),
        });
        if (opts.json) {
          // F-06: only include the preimage when explicitly requested.
          // Receivers persist the preimage in their local store and don't
          // need it in the JSON pipeline; if it's needed for backup, the
          // user can opt in.
          emit(
            {
              invoice: created.invoice,
              ...(opts.revealPreimage ? { preimage: created.preimage } : {}),
              paymentHash: created.paymentHash,
              envelope: encodeInvoiceEnvelope(created.invoice),
            },
            stdout,
          );
        } else {
          stdout.write(`${encodeInvoiceEnvelope(created.invoice)}\n`);
        }
      },
    );

  cmd
    .command('list')
    .description('List local invoices')
    .option('--unpaid', 'Only invoices not yet consumed', false)
    .option('--paid', 'Only consumed invoices', false)
    .option('--json', 'Output JSON', false)
    .action(async (opts: { unpaid: boolean; paid: boolean; json: boolean }) => {
      const env = deps.env ?? process.env;
      const stdout = deps.stdout ?? process.stdout;
      const root = deps.storageOverride ?? defaultDbDir(env);
      const records = listInvoiceFiles(root);
      const filtered = records.filter((r) => {
        const paid = r.consumedAt !== undefined;
        if (opts.paid && !paid) return false;
        if (opts.unpaid && paid) return false;
        return true;
      });
      if (opts.json) {
        emit(filtered, stdout);
      } else if (filtered.length === 0) {
        stdout.write('(no invoices)\n');
      } else {
        for (const r of filtered) {
          const status = r.consumedAt !== undefined ? 'paid' : 'issued';
          stdout.write(
            `${r.invoice.paymentHash}  ${status.padEnd(8)} amount=${r.invoice.amount.toString()}\n`,
          );
        }
      }
    });

  cmd
    .command('show <paymentHash>')
    .description('Show one invoice')
    .option('--reveal-preimage', 'Print the preimage', false)
    .action(async (paymentHash: string, opts: { revealPreimage: boolean }) => {
      const env = deps.env ?? process.env;
      const stdout = deps.stdout ?? process.stdout;
      const storage = (deps.openStorage ?? openStorage)(env, deps.storageOverride);
      const rec = await storage.loadInvoice(paymentHash as PaymentHash);
      if (!rec) throw new Error('invoice not found');
      stdout.write(`paymentHash: ${rec.invoice.paymentHash}\n`);
      stdout.write(`status:      ${rec.consumedAt !== undefined ? 'paid' : 'issued'}\n`);
      stdout.write(`amount:      ${rec.invoice.amount.toString()}\n`);
      stdout.write(`recipient:   ${rec.invoice.recipient}\n`);
      stdout.write(`expiryMs:    ${rec.invoice.expiryMs.toString()}\n`);
      if (rec.consumedAt !== undefined) stdout.write(`paidAt:      ${rec.consumedAt}\n`);
      if (opts.revealPreimage) stdout.write(`preimage:    ${rec.preimage}\n`);
    });

  return cmd;
}

void createPublicClient;
void createWalletClient;
void http;
void ViemChainAdapter;
void WebSocketTransport;
