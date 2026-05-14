import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { generateKeysendKeypair } from '@inferenceroom/pico-sdk';
import { configDir } from './config.js';

export interface KeysendKeypair {
  readonly publicKey: `0x${string}`;
  readonly secretKey: `0x${string}`;
}

export function defaultKeysendKeypairPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PICO_KEYSEND_KEYPAIR ?? join(configDir(env), 'keysend.json');
}

export function loadOrCreateKeysendKeypair(
  path: string = defaultKeysendKeypairPath(),
): KeysendKeypair {
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as KeysendKeypair;
    if (
      typeof parsed.publicKey !== 'string' ||
      typeof parsed.secretKey !== 'string' ||
      !parsed.publicKey.startsWith('0x') ||
      !parsed.secretKey.startsWith('0x')
    ) {
      throw new Error(`keysend keypair at ${path} is malformed`);
    }
    return parsed;
  }
  const kp = generateKeysendKeypair();
  persistKeysendKeypair(path, kp);
  return kp;
}

function persistKeysendKeypair(path: string, kp: KeysendKeypair): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(kp), { mode: 0o600 });
  try {
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // fsync best-effort on filesystems that don't support it
  }
  renameSync(tmp, path);
  try {
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // best-effort
  }
}
