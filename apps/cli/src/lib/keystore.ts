import type { Hex } from '@tainnel/protocol';
import { CliError } from './errors.js';

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export function loadPrivateKey(env: NodeJS.ProcessEnv = process.env): Hex {
  const raw = env.TAINNEL_PRIVATE_KEY;
  if (!raw || raw.length === 0) {
    throw new CliError(
      'TAINNEL_PRIVATE_KEY is not set. Export your hex-encoded private key (0x + 64 hex chars).',
      { code: 'KEYSTORE_MISSING' },
    );
  }
  if (!PRIVATE_KEY_RE.test(raw)) {
    throw new CliError('TAINNEL_PRIVATE_KEY is malformed. Expected 0x + 64 hex chars.', {
      code: 'KEYSTORE_MALFORMED',
    });
  }
  return raw as Hex;
}
