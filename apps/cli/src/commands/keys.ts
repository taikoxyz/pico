import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  isEncryptedKeyFile,
  parseKeyFile,
  serializeKeyFile,
} from '@inferenceroom/pico-sdk';
import { Command } from 'commander';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { defaultKeyFilePath } from '../runtime/config.js';
import { readNewPassphrase, readPassphrase } from '../runtime/passphrase.js';

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

  return cmd;
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
