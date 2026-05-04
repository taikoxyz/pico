import type { Address, Hex } from '@pico/protocol';
import type { DbDriver } from '../types.js';

export class DuplicateNonceError extends Error {
  readonly code = 'DUPLICATE_NONCE';
  constructor(nonce: Hex) {
    super(`nonce ${nonce} already seen`);
    this.name = 'DuplicateNonceError';
  }
}

export class NonceRepo {
  constructor(private readonly db: DbDriver) {}

  async record(nonce: Hex, signer: Address, expiresAt: number): Promise<void> {
    try {
      await this.db.exec('INSERT INTO seen_nonces (nonce, signer, expires_at) VALUES (?, ?, ?)', [
        nonce.toLowerCase(),
        signer.toLowerCase(),
        String(expiresAt),
      ]);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/UNIQUE|duplicate|conflict|primary key/i.test(msg)) {
        throw new DuplicateNonceError(nonce);
      }
      throw err;
    }
  }

  async isSeen(nonce: Hex): Promise<boolean> {
    const rows = await this.db.query<{ nonce: string }>(
      'SELECT nonce FROM seen_nonces WHERE nonce = ?',
      [nonce.toLowerCase()],
    );
    return rows.length > 0;
  }

  async prune(now: number): Promise<number> {
    const r = await this.db.exec('DELETE FROM seen_nonces WHERE expires_at < ?', [String(now)]);
    return r.changes;
  }
}
