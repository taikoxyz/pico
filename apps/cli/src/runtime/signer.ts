import { existsSync, readFileSync } from 'node:fs';
import { ANVIL_DEV_CHAIN_ID, type ChainId } from '@inferenceroom/pico-protocol';
import {
  type Signer,
  decryptPrivateKey,
  isEncryptedKeyFile,
  loadLocalSigner,
  parseKeyFile,
} from '@inferenceroom/pico-sdk';
import pc from 'picocolors';
import { defaultKeyFilePath } from './config.js';
import { readPassphrase } from './passphrase.js';

const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

const KNOWN_DEV_PRIVATE_KEYS: ReadonlySet<string> = new Set([
  '0x0000000000000000000000000000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000000000000000000000000000002',
  '0x0000000000000000000000000000000000000000000000000000000000000003',
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
]);

export function assertNonDevKeyForChain(privateKey: string, chainId: ChainId): void {
  if (chainId === ANVIL_DEV_CHAIN_ID) return;
  if (KNOWN_DEV_PRIVATE_KEYS.has(privateKey.toLowerCase())) {
    throw new Error(
      `refusing to use a well-known development private key on chainId=${chainId}; generate a real key with \`pico keys generate\` or use chainId=31337 for local dev`,
    );
  }
}

// Closes A-01 (PR #127) for the CLI agent surface: on non-anvil chains, reject
// argv-supplied private keys unless the operator opts in via PICO_ALLOW_ARGV_KEY=1.
// argv leaks via shell history, `ps`, and CI logs; the encrypted key file is the
// supported path. The env var keeps the test/CI escape hatch explicit.
export function assertArgvKeyAllowed(
  opts: { privateKey?: `0x${string}` },
  chainId: ChainId,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!opts.privateKey) return;
  if (chainId === ANVIL_DEV_CHAIN_ID) return;
  if (env.PICO_ALLOW_ARGV_KEY === '1') return;
  throw new Error(
    `refusing --private-key on chainId=${chainId}: argv leaks via shell history, ps, and CI logs. Use --key-file or PICO_ALLOW_ARGV_KEY=1 to opt in explicitly.`,
  );
}

export interface ResolveSignerOpts {
  readonly privateKey?: `0x${string}`;
  readonly keyFile?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr?: { write(s: string): void };
}

export async function resolveSigner(opts: ResolveSignerOpts = {}): Promise<Signer> {
  const env = opts.env ?? process.env;
  const stderr = opts.stderr ?? process.stderr;

  if (opts.privateKey) {
    stderr.write(pc.yellow('warn: --private-key supplied; intended for test/CI only\n'));
    return loadLocalSigner({ privateKey: opts.privateKey });
  }

  if (typeof env.PICO_PRIVATE_KEY === 'string' && env.PICO_PRIVATE_KEY.length > 0) {
    stderr.write(pc.yellow('warn: PICO_PRIVATE_KEY env var in use; intended for test/CI only\n'));
    return loadLocalSigner({ env });
  }

  const keyFile = opts.keyFile ?? defaultKeyFilePath(env);
  if (!existsSync(keyFile)) {
    throw new Error(
      `no key source: set PICO_PRIVATE_KEY, pass --private-key <hex>, or run \`pico keys init\` (default path ${keyFile})`,
    );
  }
  return loadLocalSigner({
    keyFile,
    env,
    passphrase: () => readPassphrase('Passphrase', { env }),
  });
}

export async function resolvePrivateKey(opts: ResolveSignerOpts = {}): Promise<`0x${string}`> {
  const env = opts.env ?? process.env;
  if (opts.privateKey) {
    if (!HEX_PRIVATE_KEY.test(opts.privateKey)) throw new Error('--private-key: malformed hex');
    return opts.privateKey;
  }
  if (typeof env.PICO_PRIVATE_KEY === 'string' && env.PICO_PRIVATE_KEY.length > 0) {
    if (!HEX_PRIVATE_KEY.test(env.PICO_PRIVATE_KEY)) {
      throw new Error('PICO_PRIVATE_KEY: expected 0x-prefixed 32-byte hex');
    }
    return env.PICO_PRIVATE_KEY as `0x${string}`;
  }
  const keyFile = opts.keyFile ?? defaultKeyFilePath(env);
  if (!existsSync(keyFile)) {
    throw new Error(
      `no key source: set PICO_PRIVATE_KEY, pass --private-key <hex>, or run \`pico keys init\` (default path ${keyFile})`,
    );
  }
  const raw = readFileSync(keyFile, 'utf8').trim();
  if (HEX_PRIVATE_KEY.test(raw)) return raw as `0x${string}`;
  if (!isEncryptedKeyFile(raw)) {
    throw new Error(`key file ${keyFile} is not a recognized format`);
  }
  const envelope = parseKeyFile(raw);
  const passphrase = await readPassphrase('Passphrase', { env });
  return decryptPrivateKey(envelope, passphrase);
}
