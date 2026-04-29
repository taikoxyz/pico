import { existsSync, readFileSync } from 'node:fs';
import {
  type Signer,
  decryptPrivateKey,
  isEncryptedKeyFile,
  loadLocalSigner,
  parseKeyFile,
} from '@tainnel/sdk';
import pc from 'picocolors';
import { defaultKeyFilePath } from './config.js';
import { readPassphrase } from './passphrase.js';

const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

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

  if (typeof env.TAINNEL_PRIVATE_KEY === 'string' && env.TAINNEL_PRIVATE_KEY.length > 0) {
    stderr.write(
      pc.yellow('warn: TAINNEL_PRIVATE_KEY env var in use; intended for test/CI only\n'),
    );
    return loadLocalSigner({ env });
  }

  const keyFile = opts.keyFile ?? defaultKeyFilePath(env);
  if (!existsSync(keyFile)) {
    throw new Error(
      `no key source: set TAINNEL_PRIVATE_KEY, pass --private-key <hex>, or run \`tainnel keys init\` (default path ${keyFile})`,
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
  if (typeof env.TAINNEL_PRIVATE_KEY === 'string' && env.TAINNEL_PRIVATE_KEY.length > 0) {
    if (!HEX_PRIVATE_KEY.test(env.TAINNEL_PRIVATE_KEY)) {
      throw new Error('TAINNEL_PRIVATE_KEY: expected 0x-prefixed 32-byte hex');
    }
    return env.TAINNEL_PRIVATE_KEY as `0x${string}`;
  }
  const keyFile = opts.keyFile ?? defaultKeyFilePath(env);
  if (!existsSync(keyFile)) {
    throw new Error(
      `no key source: set TAINNEL_PRIVATE_KEY, pass --private-key <hex>, or run \`tainnel keys init\` (default path ${keyFile})`,
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
