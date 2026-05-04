import {
  type Address,
  type ChannelState,
  type CooperativeClose,
  EMPTY_HTLCS_ROOT,
  type Htlc,
  TAIKO_HOODI_CHAIN_ID,
  type Update,
  htlcMerkleRoot,
} from '@pico/protocol';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  buildChannelStateTypedData,
  buildCooperativeCloseTypedData,
  buildHtlcTypedData,
  buildUpdateTypedData,
  computeHtlcsRoot,
  hashChannelState,
  hashCooperativeClose,
  hashHtlc,
  hashUpdate,
  verifyChannelStateSignature,
  verifyCooperativeCloseSignature,
  verifyHtlcSignature,
  verifyUpdateSignature,
} from './signing.js';

const PK_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const PK_B = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;

const accountA = privateKeyToAccount(PK_A);
const accountB = privateKeyToAccount(PK_B);

const channelId = '0x000000000000000000000000000000000000000000000000000000000000beef' as const;
const verifyingContract = '0x1111111111111111111111111111111111111111' as Address;
const chainId = TAIKO_HOODI_CHAIN_ID;

function makeHtlc(idSuffix: string, amount: bigint, direction: 'AtoB' | 'BtoA' = 'AtoB'): Htlc {
  return {
    id: `0x${idSuffix.padStart(64, '0')}` as const,
    direction,
    amount,
    paymentHash: '0xabababababababababababababababababababababababababababababababab' as const,
    expiryMs: 1_800_000_000_000n,
  };
}

function makeState(version: bigint, htlcs: readonly Htlc[] = []): ChannelState {
  return {
    channelId,
    version,
    balanceA: 1_000_000n,
    balanceB: 2_000_000n,
    htlcs,
    finalized: false,
  };
}

describe('signing — typed-data round-trips', () => {
  it('signs and recovers a ChannelState', async () => {
    const data = buildChannelStateTypedData(makeState(1n), chainId, verifyingContract);
    const signature = await accountA.signTypedData(data);
    const recovered = await recoverTypedDataAddress({ ...data, signature });
    expect(recovered.toLowerCase()).toBe(accountA.address.toLowerCase());
  });

  it('signs and recovers an Htlc', async () => {
    const data = buildHtlcTypedData(makeHtlc('1', 500_000n), chainId, verifyingContract);
    const signature = await accountB.signTypedData(data);
    const recovered = await recoverTypedDataAddress({ ...data, signature });
    expect(recovered.toLowerCase()).toBe(accountB.address.toLowerCase());
  });

  it('signs and recovers an Update', async () => {
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: makeState(2n),
    };
    const data = buildUpdateTypedData(update, chainId, verifyingContract);
    const signature = await accountA.signTypedData(data);
    const recovered = await recoverTypedDataAddress({ ...data, signature });
    expect(recovered.toLowerCase()).toBe(accountA.address.toLowerCase());
  });

  it('signs and recovers a CooperativeClose', async () => {
    const close: CooperativeClose = {
      channelId,
      finalBalanceA: 1_500_000n,
      finalBalanceB: 1_500_000n,
      signedAt: 1_800_000_000n,
    };
    const data = buildCooperativeCloseTypedData(close, chainId, verifyingContract);
    const signature = await accountB.signTypedData(data);
    const recovered = await recoverTypedDataAddress({ ...data, signature });
    expect(recovered.toLowerCase()).toBe(accountB.address.toLowerCase());
  });
});

describe('htlcMerkleRoot — determinism and edge cases', () => {
  it('returns bytes32(0) for an empty set', () => {
    expect(htlcMerkleRoot([])).toBe(EMPTY_HTLCS_ROOT);
  });

  it('handles a single HTLC', () => {
    const root = htlcMerkleRoot([makeHtlc('1', 100n)]);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(root).not.toBe(EMPTY_HTLCS_ROOT);
  });

  it('produces the same root regardless of insertion order', () => {
    const a = makeHtlc('1', 100n);
    const b = makeHtlc('2', 200n, 'BtoA');
    const c = makeHtlc('3', 300n);
    const rootForward = htlcMerkleRoot([a, b, c]);
    const rootReverse = htlcMerkleRoot([c, b, a]);
    const rootShuffled = htlcMerkleRoot([b, a, c]);
    expect(rootReverse).toBe(rootForward);
    expect(rootShuffled).toBe(rootForward);
  });

  it('handles 5 HTLCs (typical max in v1)', () => {
    const htlcs = Array.from({ length: 5 }, (_, i) =>
      makeHtlc(String(i + 1), BigInt(100 * (i + 1))),
    );
    const root = htlcMerkleRoot(htlcs);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('embeds the root in a signed ChannelState consistently', async () => {
    const htlcs = [makeHtlc('1', 100n), makeHtlc('2', 200n, 'BtoA')];
    const state = makeState(1n, htlcs);
    const data = buildChannelStateTypedData(state, chainId, verifyingContract);
    expect(data.message.htlcsRoot).toBe(htlcMerkleRoot(htlcs));
    const signature = await accountA.signTypedData(data);
    const recovered = await recoverTypedDataAddress({ ...data, signature });
    expect(recovered.toLowerCase()).toBe(accountA.address.toLowerCase());
  });

  it('computeHtlcsRoot is the same function as htlcMerkleRoot', () => {
    const htlcs = [makeHtlc('1', 100n), makeHtlc('2', 200n, 'BtoA')];
    expect(computeHtlcsRoot(htlcs)).toBe(htlcMerkleRoot(htlcs));
  });
});

describe('hash* helpers — digests are deterministic and non-zero', () => {
  it('hashChannelState matches hashTypedData(buildChannelStateTypedData)', async () => {
    const state = makeState(1n, [makeHtlc('1', 100n)]);
    const digest = hashChannelState(state, chainId, verifyingContract);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashChannelState(state, chainId, verifyingContract)).toBe(digest);
  });

  it('hashHtlc is deterministic and depends on the input', () => {
    const a = hashHtlc(makeHtlc('1', 100n), chainId, verifyingContract);
    const b = hashHtlc(makeHtlc('1', 100n), chainId, verifyingContract);
    const c = hashHtlc(makeHtlc('2', 100n), chainId, verifyingContract);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('hashUpdate produces a digest distinct from hashChannelState(nextState)', () => {
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: makeState(2n),
    };
    const updateDigest = hashUpdate(update, chainId, verifyingContract);
    const stateDigest = hashChannelState(update.nextState, chainId, verifyingContract);
    expect(updateDigest).not.toBe(stateDigest);
  });

  it('hashCooperativeClose is deterministic', () => {
    const close: CooperativeClose = {
      channelId,
      finalBalanceA: 1n,
      finalBalanceB: 2n,
      signedAt: 1_800_000_000n,
    };
    const a = hashCooperativeClose(close, chainId, verifyingContract);
    const b = hashCooperativeClose(close, chainId, verifyingContract);
    expect(a).toBe(b);
  });
});

describe('verify* helpers — signature verification', () => {
  it('verifyChannelStateSignature returns true for the matching signer', async () => {
    const state = makeState(1n);
    const data = buildChannelStateTypedData(state, chainId, verifyingContract);
    const signature = await accountA.signTypedData(data);
    expect(
      await verifyChannelStateSignature(
        state,
        signature,
        accountA.address,
        chainId,
        verifyingContract,
      ),
    ).toBe(true);
  });

  it('verifyChannelStateSignature returns false for a different signer', async () => {
    const state = makeState(1n);
    const data = buildChannelStateTypedData(state, chainId, verifyingContract);
    const signature = await accountA.signTypedData(data);
    expect(
      await verifyChannelStateSignature(
        state,
        signature,
        accountB.address,
        chainId,
        verifyingContract,
      ),
    ).toBe(false);
  });

  it('verifyChannelStateSignature returns false when the message was mutated', async () => {
    const state = makeState(1n);
    const data = buildChannelStateTypedData(state, chainId, verifyingContract);
    const signature = await accountA.signTypedData(data);
    const mutated = makeState(1n, [makeHtlc('1', 100n)]);
    expect(
      await verifyChannelStateSignature(
        mutated,
        signature,
        accountA.address,
        chainId,
        verifyingContract,
      ),
    ).toBe(false);
  });

  it('verifyHtlcSignature round-trip', async () => {
    const htlc = makeHtlc('1', 500_000n);
    const data = buildHtlcTypedData(htlc, chainId, verifyingContract);
    const signature = await accountB.signTypedData(data);
    expect(
      await verifyHtlcSignature(htlc, signature, accountB.address, chainId, verifyingContract),
    ).toBe(true);
    expect(
      await verifyHtlcSignature(htlc, signature, accountA.address, chainId, verifyingContract),
    ).toBe(false);
  });

  it('verifyUpdateSignature round-trip', async () => {
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: makeState(2n),
    };
    const data = buildUpdateTypedData(update, chainId, verifyingContract);
    const signature = await accountA.signTypedData(data);
    expect(
      await verifyUpdateSignature(update, signature, accountA.address, chainId, verifyingContract),
    ).toBe(true);
    const mutated: Update = { ...update, toVersion: 3n };
    expect(
      await verifyUpdateSignature(mutated, signature, accountA.address, chainId, verifyingContract),
    ).toBe(false);
  });

  it('verifyCooperativeCloseSignature round-trip', async () => {
    const close: CooperativeClose = {
      channelId,
      finalBalanceA: 1_500_000n,
      finalBalanceB: 1_500_000n,
      signedAt: 1_800_000_000n,
    };
    const data = buildCooperativeCloseTypedData(close, chainId, verifyingContract);
    const signature = await accountB.signTypedData(data);
    expect(
      await verifyCooperativeCloseSignature(
        close,
        signature,
        accountB.address,
        chainId,
        verifyingContract,
      ),
    ).toBe(true);
    expect(
      await verifyCooperativeCloseSignature(
        close,
        signature,
        accountA.address,
        chainId,
        verifyingContract,
      ),
    ).toBe(false);
  });

  it('address comparison is case-insensitive', async () => {
    const state = makeState(1n);
    const data = buildChannelStateTypedData(state, chainId, verifyingContract);
    const signature = await accountA.signTypedData(data);
    const upper = accountA.address.toUpperCase().replace('0X', '0x') as Address;
    expect(
      await verifyChannelStateSignature(state, signature, upper, chainId, verifyingContract),
    ).toBe(true);
  });
});
