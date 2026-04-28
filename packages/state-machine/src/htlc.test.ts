import type { ChannelState, Htlc, Preimage } from '@tainnel/protocol';
import { sha256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { InvalidPreimageError, StateMachineError, UnknownHtlcError } from './errors.js';
import {
  addHtlc,
  computeHtlcLeaf,
  computeHtlcsRoot,
  expireHtlcs,
  failHtlc,
  settleHtlc,
  verifyPreimage,
} from './htlc.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000099' as const;

function makeHtlc(overrides: Partial<Htlc> = {}): Htlc {
  const preimage: Preimage = '0x1111111111111111111111111111111111111111111111111111111111111111';
  return {
    id: '0x0000000000000000000000000000000000000000000000000000000000000001',
    direction: 'AtoB',
    amount: 100n,
    paymentHash: sha256(preimage),
    expiryMs: 9_999_999n,
    ...overrides,
  };
}

function makeState(htlcs: readonly Htlc[] = []): ChannelState {
  return {
    channelId,
    version: 1n,
    balanceA: 1_000n,
    balanceB: 1_000n,
    htlcs,
    finalized: false,
  };
}

const PREIMAGE: Preimage = '0x1111111111111111111111111111111111111111111111111111111111111111';
const PAYMENT_HASH = sha256(PREIMAGE);

describe('verifyPreimage', () => {
  it('accepts the matching preimage', () => {
    expect(verifyPreimage(PAYMENT_HASH, PREIMAGE)).toBe(true);
  });

  it('rejects a tampered preimage', () => {
    const bad: Preimage = '0x1111111111111111111111111111111111111111111111111111111111111110';
    expect(verifyPreimage(PAYMENT_HASH, bad)).toBe(false);
  });

  it('is case-insensitive on payment-hash hex', () => {
    const upperHash = PAYMENT_HASH.toUpperCase().replace('0X', '0x') as typeof PAYMENT_HASH;
    expect(verifyPreimage(upperHash, PREIMAGE)).toBe(true);
  });
});

describe('addHtlc', () => {
  it('rejects zero-amount htlcs', () => {
    expect(() => addHtlc(makeState(), makeHtlc({ amount: 0n }))).toThrow(StateMachineError);
    expect(() => addHtlc(makeState(), makeHtlc({ amount: 0n }))).toThrow(/zero-amount/);
  });

  it('rejects duplicate ids', () => {
    const htlc = makeHtlc();
    const state = addHtlc(makeState(), htlc);
    expect(() => addHtlc(state, htlc)).toThrow(/duplicate/);
  });

  it('rejects when sender lacks balance', () => {
    expect(() => addHtlc(makeState(), makeHtlc({ amount: 99_999n }))).toThrow(/insufficient/);
  });

  it('locks the amount from balanceA for AtoB', () => {
    const next = addHtlc(makeState(), makeHtlc({ amount: 100n, direction: 'AtoB' }));
    expect(next.balanceA).toBe(900n);
    expect(next.balanceB).toBe(1_000n);
    expect(next.htlcs.length).toBe(1);
  });

  it('locks the amount from balanceB for BtoA', () => {
    const next = addHtlc(makeState(), makeHtlc({ amount: 100n, direction: 'BtoA' }));
    expect(next.balanceA).toBe(1_000n);
    expect(next.balanceB).toBe(900n);
  });

  it('rejects BtoA when sender B lacks balance', () => {
    expect(() => addHtlc(makeState(), makeHtlc({ direction: 'BtoA', amount: 99_999n }))).toThrow(
      /insufficient/,
    );
  });
});

describe('settleHtlc', () => {
  it('credits the receiver when preimage matches', () => {
    const state = addHtlc(makeState(), makeHtlc());
    const next = settleHtlc(state, makeHtlc().id, PREIMAGE);
    expect(next.balanceA).toBe(900n);
    expect(next.balanceB).toBe(1_100n);
    expect(next.htlcs.length).toBe(0);
  });

  it('rejects an invalid preimage', () => {
    const state = addHtlc(makeState(), makeHtlc());
    const bad: Preimage = '0x2222222222222222222222222222222222222222222222222222222222222222';
    expect(() => settleHtlc(state, makeHtlc().id, bad)).toThrow(InvalidPreimageError);
  });

  it('throws UnknownHtlcError for an unknown id', () => {
    const unknown = '0x000000000000000000000000000000000000000000000000000000000000dead';
    expect(() => settleHtlc(makeState(), unknown, PREIMAGE)).toThrow(UnknownHtlcError);
  });

  it('credits balanceA for BtoA settlement', () => {
    const htlc = makeHtlc({ direction: 'BtoA' });
    const state = addHtlc(makeState(), htlc);
    const next = settleHtlc(state, htlc.id, PREIMAGE);
    expect(next.balanceA).toBe(1_100n);
    expect(next.balanceB).toBe(900n);
  });
});

describe('failHtlc', () => {
  it('throws UnknownHtlcError for an unknown id', () => {
    const unknown = '0x000000000000000000000000000000000000000000000000000000000000beef';
    expect(() => failHtlc(makeState(), unknown)).toThrow(UnknownHtlcError);
  });

  it('refunds AtoB sender on failure', () => {
    const htlc = makeHtlc();
    const next = failHtlc(addHtlc(makeState(), htlc), htlc.id);
    expect(next.balanceA).toBe(1_000n);
    expect(next.balanceB).toBe(1_000n);
  });

  it('refunds BtoA sender on failure', () => {
    const htlc = makeHtlc({ direction: 'BtoA' });
    const next = failHtlc(addHtlc(makeState(), htlc), htlc.id);
    expect(next.balanceA).toBe(1_000n);
    expect(next.balanceB).toBe(1_000n);
  });
});

describe('expireHtlcs', () => {
  it('refunds all htlcs whose expiry is at or before nowMs', () => {
    const a = makeHtlc({ id: `0x${'01'.repeat(32)}`, expiryMs: 100n });
    const b = makeHtlc({ id: `0x${'02'.repeat(32)}`, expiryMs: 9_999n, direction: 'BtoA' });
    let s = addHtlc(makeState(), a);
    s = addHtlc(s, b);
    const next = expireHtlcs(s, 100n);
    expect(next.htlcs.length).toBe(1);
    expect(next.htlcs[0]?.id).toBe(b.id);
    expect(next.balanceA).toBe(1_000n);
  });

  it('is a no-op when nothing has expired', () => {
    const htlc = makeHtlc({ expiryMs: 9_999_999n });
    const s = addHtlc(makeState(), htlc);
    const next = expireHtlcs(s, 0n);
    expect(next).toEqual(s);
  });
});

describe('computeHtlcsRoot / computeHtlcLeaf', () => {
  it('re-exports htlcMerkleRoot from protocol', () => {
    expect(computeHtlcsRoot([])).toMatch(/^0x0+$/);
  });

  it('produces deterministic leaf hashes', () => {
    const a = computeHtlcLeaf(makeHtlc());
    const b = computeHtlcLeaf(makeHtlc());
    expect(a).toBe(b);
  });
});
