import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type ChainId,
  TAIKO_HOODI_CHAIN_ID,
  TAIKO_MAINNET_CHAIN_ID,
} from '@inferenceroom/pico-protocol';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  inflatedFeesFromBlock,
  isEncryptedKeyFile,
  parseKeyFile,
  serializeKeyFile,
} from '@inferenceroom/pico-sdk';
import { Command } from 'commander';
import {
  http,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { formatCliError, readTokenDecimals } from '../runtime/cli-helpers.js';
import { defaultKeyFilePath } from '../runtime/config.js';
import { readNewPassphrase, readPassphrase } from '../runtime/passphrase.js';
import { resolvePrivateKey } from '../runtime/signer.js';

export interface KeysDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly readPassphrase?: typeof readPassphrase;
  readonly readNewPassphrase?: typeof readNewPassphrase;
  readonly stdout?: { write(s: string): void };
  readonly generatePrivateKey?: () => `0x${string}`;
}

const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export function keysCommand(deps: KeysDeps = {}): Command {
  const cmd = new Command('keys').description('Key-management commands');

  cmd
    .command('init')
    .description('Generate a new key, passphrase-encrypt, write to disk')
    .option('--out <path>', 'Output path (defaults to $XDG_CONFIG_HOME/pico/key.enc)')
    .option('--force', 'Overwrite existing file', false)
    .action(async (opts: { out?: string; force: boolean }) => {
      await runInit(opts, deps);
    });

  cmd
    .command('import')
    .description('Import an existing private key (hex)')
    .requiredOption('--from <hex>', 'Private key as 0x-prefixed 32-byte hex')
    .option('--out <path>', 'Output path')
    .option('--force', 'Overwrite existing file', false)
    .action(async (opts: { from: `0x${string}`; out?: string; force: boolean }) => {
      await runImport(opts, deps);
    });

  cmd
    .command('show')
    .description('Print the address (and optionally the private key) for a key file')
    .option('--path <path>', 'Key file path')
    .option('--reveal-private', 'Decrypt and print the private key', false)
    .action(async (opts: { path?: string; revealPrivate: boolean }) => {
      await runShow(opts, deps);
    });

  cmd
    .command('drain')
    .description(
      'Sweep residual native ETH and listed ERC-20 balances to a target address. ' +
        'Intended for cleaning up ephemeral test wallets after smoke runs.',
    )
    .requiredOption('--to <addr>', 'Destination address to receive swept funds')
    .option(
      '--tokens <addrs>',
      'Comma-separated ERC-20 contract addresses to sweep (in addition to native)',
    )
    .option('--rpc <url>', 'RPC URL (defaults to PICO_RPC_URL or chain default)')
    .option('--chain <id>', 'Chain id (default 167000)')
    .option('--private-key <hex>', 'Private key of the wallet to drain (test/CI only)')
    .option('--key-file <path>', 'Encrypted or plaintext key file of the wallet to drain')
    .option('--json', 'Emit JSON output', false)
    .action(
      async (opts: {
        to: Address;
        tokens?: string;
        rpc?: string;
        chain?: string;
        privateKey?: `0x${string}`;
        keyFile?: string;
        json: boolean;
      }) => {
        await runDrain(opts, deps);
      },
    );

  return cmd;
}

const KEYS_TAIKO_MAINNET: Chain = defineChain({
  id: TAIKO_MAINNET_CHAIN_ID,
  name: 'Taiko Mainnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.taiko.xyz'] } },
});

const KEYS_TAIKO_HOODI: Chain = defineChain({
  id: TAIKO_HOODI_CHAIN_ID,
  name: 'Taiko Hoodi Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.hoodi.taiko.xyz'] } },
});

function chainForDrain(id: ChainId): Chain {
  if (id === TAIKO_MAINNET_CHAIN_ID) return KEYS_TAIKO_MAINNET;
  if (id === TAIKO_HOODI_CHAIN_ID) return KEYS_TAIKO_HOODI;
  throw new Error(`unsupported chainId ${id as number}`);
}

async function runInit(opts: { out?: string; force: boolean }, deps: KeysDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const path = opts.out ?? defaultKeyFilePath(env);
  if (existsSync(path) && !opts.force) {
    throw new Error(`refuse to overwrite ${path} (pass --force to replace)`);
  }
  const generate = deps.generatePrivateKey ?? generatePrivateKey;
  const privateKey = generate();
  const newPP = deps.readNewPassphrase ?? readNewPassphrase;
  const passphrase = await newPP({ env });
  const envelope = encryptPrivateKey(privateKey, passphrase);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeKeyFile(envelope), { mode: 0o600 });
  const stdout = deps.stdout ?? process.stdout;
  stdout.write(`address: ${envelope.address}\n`);
  stdout.write(`file:    ${path}\n`);
}

async function runImport(
  opts: { from: `0x${string}`; out?: string; force: boolean },
  deps: KeysDeps,
): Promise<void> {
  if (!HEX_PRIVATE_KEY.test(opts.from)) {
    throw new Error('--from: expected 0x-prefixed 32-byte hex private key');
  }
  const env = deps.env ?? process.env;
  const path = opts.out ?? defaultKeyFilePath(env);
  if (existsSync(path) && !opts.force) {
    throw new Error(`refuse to overwrite ${path} (pass --force to replace)`);
  }
  const newPP = deps.readNewPassphrase ?? readNewPassphrase;
  const passphrase = await newPP({ env });
  const envelope = encryptPrivateKey(opts.from, passphrase);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeKeyFile(envelope), { mode: 0o600 });
  const stdout = deps.stdout ?? process.stdout;
  stdout.write(`address: ${envelope.address}\n`);
  stdout.write(`file:    ${path}\n`);
}

async function runShow(
  opts: { path?: string; revealPrivate: boolean },
  deps: KeysDeps,
): Promise<void> {
  const env = deps.env ?? process.env;
  const path = opts.path ?? defaultKeyFilePath(env);
  if (!existsSync(path)) throw new Error(`key file not found: ${path}`);
  const raw = readFileSync(path, 'utf8').trim();
  const stdout = deps.stdout ?? process.stdout;

  if (HEX_PRIVATE_KEY.test(raw)) {
    const addr = privateKeyToAccount(raw as `0x${string}`).address;
    stdout.write(`address: ${addr}\n`);
    stdout.write(`file:    ${path}\n`);
    stdout.write('format:  plaintext\n');
    if (opts.revealPrivate) stdout.write(`private: ${raw}\n`);
    return;
  }

  if (!isEncryptedKeyFile(raw)) {
    throw new Error(`key file ${path} is not a recognized format`);
  }
  const envelope = parseKeyFile(raw);
  stdout.write(`address: ${envelope.address}\n`);
  stdout.write(`file:    ${path}\n`);
  stdout.write('format:  encrypted (scrypt + xsalsa20-poly1305)\n');
  if (opts.revealPrivate) {
    const readPP = deps.readPassphrase ?? readPassphrase;
    const pp = await readPP('Passphrase to reveal private key', { env });
    const pk = decryptPrivateKey(envelope, pp);
    stdout.write(`private: ${pk}\n`);
  }
}

interface DrainOpts {
  to: Address;
  tokens?: string;
  rpc?: string;
  chain?: string;
  privateKey?: `0x${string}`;
  keyFile?: string;
  json: boolean;
}

interface SweptToken {
  readonly token: Address;
  readonly amount: string;
  readonly decimals: number;
  readonly txHash: `0x${string}`;
}

async function runDrain(opts: DrainOpts, deps: KeysDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const chainId = (opts.chain ? Number(opts.chain) : TAIKO_MAINNET_CHAIN_ID) as ChainId;
  const chain = chainForDrain(chainId);
  const rpcUrl = opts.rpc ?? env.PICO_RPC_URL ?? (chain.rpcUrls.default.http[0] as string);
  try {
    const privateKey = await resolvePrivateKey({
      ...(opts.privateKey !== undefined ? { privateKey: opts.privateKey } : {}),
      ...(opts.keyFile !== undefined ? { keyFile: opts.keyFile } : {}),
      env,
    });
    const account = privateKeyToAccount(privateKey);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    }) as WalletClient;

    const tokens: Address[] = opts.tokens
      ? opts.tokens
          .split(',')
          .map((t) => t.trim())
          .filter((t): t is Address => /^0x[0-9a-fA-F]{40}$/.test(t))
      : [];

    const swept: SweptToken[] = [];

    // Compute fees BEFORE the loops so token sweeps and the native sweep
    // use the same gas math. Round-3 finding #13/#4 showed viem's default
    // gasPrice can be ~3× below the chain's current basefee on Taiko,
    // causing both stuck txs and false-positive "balance < cost" errors.
    const fees = await inflatedFeesFromBlock(publicClient);

    for (const token of tokens) {
      const balance = (await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      })) as bigint;
      if (balance === 0n) continue;
      const decimals = await readTokenDecimals({ client: publicClient, token });
      const txHash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [opts.to, balance],
        account,
        chain,
        ...fees,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      swept.push({ token, amount: balance.toString(), decimals, txHash });
    }

    // Sweep residual native ETH last so we don't lose the gas budget for
    // token sweeps. Reserve enough wei for the final transfer's gas at the
    // INFLATED maxFeePerGas (round-3 finding #4). On near-empty wallets the
    // native sweep can legitimately not fit; if so, swallow the error,
    // surface a warning in the payload, and exit 0 — the token sweeps that
    // already succeeded are still useful and the caller can finish the
    // native dust via cast or just leave it.
    const eth = await publicClient.getBalance({ address: account.address });
    const maxFeePerWei = 'maxFeePerGas' in fees ? fees.maxFeePerGas : fees.gasPrice;
    // 2× the 21000 gas budget — a single sendTransaction never uses more,
    // but viem's pre-flight balance check uses maxFeePerGas * gasLimit.
    const reserve = maxFeePerWei * 21000n * 2n;
    let nativeSwept: { amount: string; txHash: `0x${string}` } | undefined;
    let nativeSkipped: string | undefined;
    if (eth > reserve) {
      const value = eth - reserve;
      try {
        const txHash = await walletClient.sendTransaction({
          to: opts.to,
          value,
          account,
          chain,
          gas: 21000n,
          ...fees,
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        nativeSwept = { amount: value.toString(), txHash };
      } catch (err) {
        nativeSkipped = (err as Error).message;
      }
    } else {
      nativeSkipped = 'balance below gas reserve';
    }

    if (opts.json) {
      const payload = {
        from: account.address,
        to: opts.to,
        native: nativeSwept,
        tokens: swept,
        ...(nativeSkipped ? { nativeSkipped } : {}),
      };
      stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    stdout.write(`drained ${account.address} -> ${opts.to}\n`);
    for (const s of swept) {
      stdout.write(
        `  token ${s.token}: ${formatUnits(BigInt(s.amount), s.decimals)} (tx ${s.txHash})\n`,
      );
    }
    if (nativeSwept) {
      stdout.write(
        `  native ETH: ${formatUnits(BigInt(nativeSwept.amount), 18)} (tx ${nativeSwept.txHash})\n`,
      );
    } else {
      stdout.write(`  native ETH: skipped — ${nativeSkipped ?? 'unknown'}\n`);
    }
  } catch (err) {
    (deps.stdout ?? process.stdout).write(formatCliError(err));
    process.exitCode = 1;
  }
}
