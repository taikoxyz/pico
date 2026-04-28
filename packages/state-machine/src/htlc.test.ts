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

describe('error codes', () => {
  it('zero-amount → ZERO_AMOUNT_HTLC', () => {
    try {
      addHtlc(makeState(), makeHtlc({ amount: 0n }));
    } catch (err) {
      expect(err).toBeInstanceOf(StateMachineError);
      expect((err as StateMachineError).code).toBe('ZERO_AMOUNT_HTLC');
    }
  });

  it('duplicate id → DUPLICATE_HTLC', () => {
    try {
      const state = addHtlc(makeState(), makeHtlc());
      addHtlc(state, makeHtlc());
    } catch (err) {
      expect((err as StateMachineError).code).toBe('DUPLICATE_HTLC');
    }
  });

  it('insufficient balance → INSUFFICIENT_BALANCE', () => {
    try {
      addHtlc(makeState(), makeHtlc({ amount: 10_000_000n }));
    } catch (err) {
      expect((err as StateMachineError).code).toBe('INSUFFICIENT_BALANCE');
    }
  });

  it('invalid preimage → INVALID_PREIMAGE', () => {
    const state = addHtlc(makeState(), makeHtlc());
    try {
      const bad: Preimage = '0x2222222222222222222222222222222222222222222222222222222222222222';
      settleHtlc(state, makeHtlc().id, bad);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPreimageError);
      expect((err as StateMachineError).code).toBe('INVALID_PREIMAGE');
    }
  });

  it('unknown htlc → UNKNOWN_HTLC', () => {
    const unknown = `0x${'de'.repeat(32)}`;
    try {
      failHtlc(makeState(), unknown);
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownHtlcError);
      expect((err as StateMachineError).code).toBe('UNKNOWN_HTLC');
    }
  });
});

describe('immutability', () => {
  it('addHtlc does not mutate the input state', () => {
    const state = makeState();
    const balanceASnap = state.balanceA;
    const htlcsRefSnap = state.htlcs;
    addHtlc(state, makeHtlc());
    expect(state.balanceA).toBe(balanceASnap);
    expect(state.htlcs).toBe(htlcsRefSnap);
    expect(state.htlcs.length).toBe(0);
  });

  it('settleHtlc does not mutate the input state', () => {
    const start = addHtlc(makeState(), makeHtlc());
    const lenBefore = start.htlcs.length;
    settleHtlc(start, makeHtlc().id, PREIMAGE);
    expect(start.htlcs.length).toBe(lenBefore);
    expect(start.balanceA).toBe(900n);
  });

  it('failHtlc does not mutate the input state', () => {
    const start = addHtlc(makeState(), makeHtlc());
    failHtlc(start, makeHtlc().id);
    expect(start.htlcs.length).toBe(1);
    expect(start.balanceA).toBe(900n);
  });

  it('expireHtlcs does not mutate the input state', () => {
    const htlc = makeHtlc({ expiryMs: 100n });
    const start = addHtlc(makeState(), htlc);
    const lenBefore = start.htlcs.length;
    expireHtlcs(start, 1_000n);
    expect(start.htlcs.length).toBe(lenBefore);
    expect(start.balanceA).toBe(900n);
  });
});

describe('htlc lifecycle edge cases', () => {
  it('settling the same htlc twice throws UnknownHtlcError on the second call', () => {
    const start = addHtlc(makeState(), makeHtlc());
    const once = settleHtlc(start, makeHtlc().id, PREIMAGE);
    expect(() => settleHtlc(once, makeHtlc().id, PREIMAGE)).toThrow(UnknownHtlcError);
  });

  it('failing the same htlc twice throws UnknownHtlcError on the second call', () => {
    const start = addHtlc(makeState(), makeHtlc());
    const once = failHtlc(start, makeHtlc().id);
    expect(() => failHtlc(once, makeHtlc().id)).toThrow(UnknownHtlcError);
  });

  it('an id can be reused after the original htlc is settled', () => {
    const first = addHtlc(makeState(), makeHtlc());
    const settled = settleHtlc(first, makeHtlc().id, PREIMAGE);
    expect(() => addHtlc(settled, makeHtlc({ amount: 50n }))).not.toThrow();
  });

  it('an id can be reused after the original htlc is failed', () => {
    const first = addHtlc(makeState(), makeHtlc());
    const failed = failHtlc(first, makeHtlc().id);
    expect(() => addHtlc(failed, makeHtlc({ amount: 50n }))).not.toThrow();
  });

  it('two htlcs with the same paymentHash but different ids are independent', () => {
    const a = makeHtlc({ id: `0x${'a1'.repeat(32)}` });
    const b = makeHtlc({ id: `0x${'b2'.repeat(32)}` });
    let s = addHtlc(makeState(), a);
    s = addHtlc(s, b);
    expect(s.balanceA).toBe(800n);
    s = settleHtlc(s, a.id, PREIMAGE);
    expect(s.htlcs.length).toBe(1);
    expect(s.htlcs[0]?.id).toBe(b.id);
    s = settleHtlc(s, b.id, PREIMAGE);
    expect(s.htlcs.length).toBe(0);
    expect(s.balanceA).toBe(800n);
    expect(s.balanceB).toBe(1_200n);
  });

  it('expireHtlcs is inclusive at the boundary nowMs == expiryMs', () => {
    const htlc = makeHtlc({ expiryMs: 1_000n });
    const start = addHtlc(makeState(), htlc);
    const expired = expireHtlcs(start, 1_000n);
    expect(expired.htlcs.length).toBe(0);
  });

  it('expireHtlcs leaves htlcs whose expiry is strictly greater than nowMs', () => {
    const htlc = makeHtlc({ expiryMs: 1_001n });
    const start = addHtlc(makeState(), htlc);
    const result = expireHtlcs(start, 1_000n);
    expect(result.htlcs.length).toBe(1);
  });

  it('exhausting balanceA via successive htlcs then refunding returns whole balance', () => {
    let s = makeState();
    const htlcs = [
      makeHtlc({ id: `0x${'01'.repeat(32)}`, amount: 250n }),
      makeHtlc({ id: `0x${'02'.repeat(32)}`, amount: 350n }),
      makeHtlc({ id: `0x${'03'.repeat(32)}`, amount: 400n }),
    ];
    for (const h of htlcs) s = addHtlc(s, h);
    expect(s.balanceA).toBe(0n);
    for (const h of htlcs) s = failHtlc(s, h.id);
    expect(s.balanceA).toBe(1_000n);
    expect(s.balanceB).toBe(1_000n);
  });

  it('mixing AtoB and BtoA htlcs preserves independent accounting', () => {
    const a = makeHtlc({ id: `0x${'a1'.repeat(32)}`, amount: 200n, direction: 'AtoB' });
    const b = makeHtlc({ id: `0x${'b1'.repeat(32)}`, amount: 300n, direction: 'BtoA' });
    let s = addHtlc(makeState(), a);
    s = addHtlc(s, b);
    expect(s.balanceA).toBe(800n);
    expect(s.balanceB).toBe(700n);
    s = settleHtlc(s, a.id, PREIMAGE);
    expect(s.balanceA).toBe(800n);
    expect(s.balanceB).toBe(900n);
    s = failHtlc(s, b.id);
    expect(s.balanceA).toBe(800n);
    expect(s.balanceB).toBe(1_200n);
  });

  it('htlc with amount equal to full balanceA is allowed', () => {
    const htlc = makeHtlc({ amount: 1_000n });
    const next = addHtlc(makeState(), htlc);
    expect(next.balanceA).toBe(0n);
  });

  it('verifyPreimage handles longer preimages (sha256 over arbitrary bytes)', () => {
    const preimage: Preimage = `0x${'ab'.repeat(64)}`;
    const hash = sha256(preimage);
    expect(verifyPreimage(hash, preimage)).toBe(true);
  });
});
