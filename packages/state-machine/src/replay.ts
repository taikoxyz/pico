import { StaleVersionError, StateMachineError } from './errors.js';

export function ensureMonotonicVersion(current: bigint, next: bigint): void {
  if (next <= current) {
    throw new StaleVersionError(current, next);
  }
}

export function isStrictlyNewer(a: { version: bigint }, b: { version: bigint }): boolean {
  return a.version > b.version;
}

/**
 * Cooperative-close freshness check (§6.2). Mirrors the on-chain Adjudicator
 * predicate: the close's `version` MUST be strictly greater than the channel's
 * on-chain `postedVersion`, and the close MUST NOT have expired
 * (`validUntil >= nowSec`).
 */
export function ensureCoopCloseFresh(
  close: { version: bigint; validUntil: bigint },
  postedVersion: bigint,
  nowSec: bigint,
): void {
  if (close.version <= postedVersion) {
    throw new StaleVersionError(postedVersion, close.version);
  }
  if (close.validUntil < nowSec) {
    throw new StateMachineError(
      `cooperative close expired (validUntil=${close.validUntil} now=${nowSec})`,
      'COOP_CLOSE_EXPIRED',
    );
  }
}
