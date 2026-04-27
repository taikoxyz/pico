import { StaleVersionError } from './errors.js';

export function ensureMonotonicVersion(current: bigint, next: bigint): void {
  if (next <= current) {
    throw new StaleVersionError(current, next);
  }
}

export function isStrictlyNewer(a: { version: bigint }, b: { version: bigint }): boolean {
  return a.version > b.version;
}
