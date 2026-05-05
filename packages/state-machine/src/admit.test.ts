import {
  type Address,
  type Channel,
  type ChannelState,
  type Htlc,
  type Signature,
  type SignedState,
  TAIKO_HOODI_CHAIN_ID,
} from '@pico/protocol';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  StateAdmissionError,
  admitClose,
  admitHtlcFail,
  admitHtlcOffer,
  admitHtlcSettle,
  admitSignedState,
} from './admit.js';
import { buildChannelStateTypedData } from './signing.js';

const PK_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const PK_B = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;

const accountA = privateKeyToAccount(PK_A);
const accountB = privateKeyToAccount(PK_B);

const channelId = '0x000000000000000000000000000000000000000000000000000000000000beef' as const;
const verifyingContract = '0x1111111111111111111111111111111111111111' as Address;
const chainId = TAIKO_HOODI_CHAIN_ID;

const channel: Channel = {
  id: channelId,
  chainId,
  contract: verifyingContract,
  userA: accountA.address,
  userB: accountB.address,
  token: '0x0000000000000000000000000000000000000099',
  status: 'open',
  openedAt: 0n,
  disputeWindowMs: 86_400_000,
};

const ZERO_SIG: Signature = { r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}`, v: 27 };

function hexToSig(hex: `0x${string}`): Signature {
  return {
    r: `0x${hex.slice(2, 66)}` as `0x${string}`,
    s: `0x${hex.slice(66, 130)}` as `0x${string}`,
    v: Number.parseInt(hex.slice(130, 132), 16),
  };
}

async function signBy(account: typeof accountA, state: ChannelState): Promise<Signature> {
  const td = buildChannelStateTypedData(state, chainId, verifyingContract);
  return hexToSig(await account.signTypedData(td));
}

async function bothSign(state: ChannelState): Promise<SignedState> {
  return {
    state,
    sigA: await signBy(accountA, state),
    sigB: await signBy(accountB, state),
  };
}

function buildState(
  version: bigint,
  balanceA: bigint,
  balanceB: bigint,
  htlcs: readonly Htlc[] = [],
): ChannelState {
  return {
    channelId,
    version,
    balanceA,
    balanceB,
    htlcs,
    finalized: false,
  };
}

const ctx = { channel, chainId, verifyingContract };

describe('admitSignedState', () => {
  it('accepts a properly signed monotonic state', async () => {
    const prev = buildState(1n, 100n, 0n);
    const next = buildState(2n, 90n, 10n);
    const signed = await bothSign(next);
    await expect(admitSignedState(signed, ctx, { prev })).resolves.toBeUndefined();
  });

  it('rejects mismatched channel id', async () => {
    const prev = buildState(1n, 100n, 0n);
    const otherChannelId =
      '0x000000000000000000000000000000000000000000000000000000000000dead' as const;
    const next = {
      ...buildState(2n, 90n, 10n),
      channelId: otherChannelId,
    } as ChannelState;
    const signed = await bothSign(next);
    await expect(admitSignedState(signed, ctx, { prev })).rejects.toThrow(StateAdmissionError);
  });

  it('rejects stale version', async () => {
    const prev = buildState(2n, 90n, 10n);
    const next = buildState(2n, 80n, 20n);
    const signed = await bothSign(next);
    await expect(admitSignedState(signed, ctx, { prev })).rejects.toMatchObject({
      code: 'VERSION_NOT_MONOTONIC',
    });
  });

  it('rejects non-conserved balance', async () => {
    const prev = buildState(1n, 100n, 0n);
    const next = buildState(2n, 0n, 200n); // total grew
    const signed = await bothSign(next);
    await expect(admitSignedState(signed, ctx, { prev })).rejects.toMatchObject({
      code: 'BALANCE_NOT_CONSERVED',
    });
  });

  it('rejects bad sigA (zero signature)', async () => {
    const next = buildState(1n, 100n, 0n);
    const signed: SignedState = { state: next, sigA: ZERO_SIG, sigB: await signBy(accountB, next) };
    await expect(admitSignedState(signed, ctx, { prev: undefined })).rejects.toMatchObject({
      code: 'BAD_SIGNATURE_A',
    });
  });

  it('rejects bad sigB (signed by wrong key)', async () => {
    const next = buildState(1n, 100n, 0n);
    const signed: SignedState = {
      state: next,
      sigA: await signBy(accountA, next),
      sigB: await signBy(accountA, next),
    };
    await expect(admitSignedState(signed, ctx, { prev: undefined })).rejects.toMatchObject({
      code: 'BAD_SIGNATURE_B',
    });
  });

  it('rejects a placeholder for an explicitly required signer', async () => {
    const next = buildState(1n, 100n, 0n);
    const signed: SignedState = {
      state: next,
      sigA: await signBy(accountA, next),
      sigB: ZERO_SIG,
    };
    await expect(
      admitSignedState(signed, ctx, {
        prev: undefined,
        allowPartialSigs: true,
        requireSignerAddresses: [accountB.address],
      }),
    ).rejects.toMatchObject({ code: 'BAD_SIGNATURE_B' });
  });
});

describe('admitHtlcOffer', () => {
  const expectedHtlc: Htlc = {
    id: '0x1111111111111111111111111111111111111111111111111111111111111111',
    direction: 'AtoB',
    amount: 10n,
    paymentHash: '0xabababababababababababababababababababababababababababababababab',
    expiryMs: 9_999_999_999n,
  };

  it('accepts a state with the expected new HTLC', async () => {
    const prev = buildState(1n, 100n, 0n);
    const next = buildState(2n, 90n, 0n, [expectedHtlc]);
    const signed = await bothSign(next);
    await expect(admitHtlcOffer(signed, ctx, { prev, expectedHtlc })).resolves.toBeUndefined();
  });

  it('rejects when expected HTLC is missing', async () => {
    const prev = buildState(1n, 100n, 0n);
    const next = buildState(2n, 100n, 0n);
    const signed = await bothSign(next);
    await expect(admitHtlcOffer(signed, ctx, { prev, expectedHtlc })).rejects.toMatchObject({
      code: 'HTLC_NOT_FOUND',
    });
  });

  it('rejects when HTLC fields differ', async () => {
    const prev = buildState(1n, 100n, 0n);
    const wrongHtlc: Htlc = { ...expectedHtlc, amount: 5n };
    const next = buildState(2n, 95n, 0n, [wrongHtlc]);
    const signed = await bothSign(next);
    await expect(admitHtlcOffer(signed, ctx, { prev, expectedHtlc })).rejects.toMatchObject({
      code: 'HTLC_FIELDS_MISMATCH',
    });
  });
});

describe('admitHtlcSettle', () => {
  const htlc: Htlc = {
    id: '0x2222222222222222222222222222222222222222222222222222222222222222',
    direction: 'AtoB',
    amount: 10n,
    paymentHash: '0xb0e6e0c4ecbf72f9ad48f4f1c8dba1d6d8b0c5fec77c83c3edda8a93820cd0f3',
    expiryMs: 9_999_999_999n,
  };
  const preimage = '0xdeadbeef00000000000000000000000000000000000000000000000000000000' as const;

  it('accepts a state where the HTLC has been removed', async () => {
    const prev = buildState(2n, 90n, 0n, [htlc]);
    const next = buildState(3n, 90n, 10n, []);
    const signed = await bothSign(next);
    await expect(
      admitHtlcSettle(signed, ctx, { prev, htlcId: htlc.id, preimage }),
    ).resolves.toBeUndefined();
  });

  it('rejects a state where the HTLC is still present', async () => {
    const prev = buildState(2n, 90n, 0n, [htlc]);
    const next = buildState(3n, 90n, 0n, [htlc]);
    const signed = await bothSign(next);
    await expect(
      admitHtlcSettle(signed, ctx, { prev, htlcId: htlc.id, preimage }),
    ).rejects.toMatchObject({ code: 'EXPECTED_HTLC_ABSENT' });
  });
});

describe('admitHtlcFail', () => {
  const htlc: Htlc = {
    id: '0x4444444444444444444444444444444444444444444444444444444444444444',
    direction: 'AtoB',
    amount: 10n,
    paymentHash: '0xabababababababababababababababababababababababababababababababab',
    expiryMs: 9_999_999_999n,
  };

  it('accepts a state where the HTLC has been removed and refunded', async () => {
    const prev = buildState(2n, 90n, 0n, [htlc]);
    const next = buildState(3n, 100n, 0n, []);
    const signed = await bothSign(next);
    await expect(admitHtlcFail(signed, ctx, { prev, htlcId: htlc.id })).resolves.toBeUndefined();
  });

  it('rejects a state where the failed HTLC is still present', async () => {
    const prev = buildState(2n, 90n, 0n, [htlc]);
    const next = buildState(3n, 90n, 0n, [htlc]);
    const signed = await bothSign(next);
    await expect(admitHtlcFail(signed, ctx, { prev, htlcId: htlc.id })).rejects.toMatchObject({
      code: 'EXPECTED_HTLC_ABSENT',
    });
  });
});

describe('admitClose', () => {
  it('accepts a finalized empty-HTLC state', async () => {
    const next: ChannelState = {
      channelId,
      version: 5n,
      balanceA: 50n,
      balanceB: 50n,
      htlcs: [],
      finalized: true,
    };
    const signed = await bothSign(next);
    await expect(admitClose(signed, ctx)).resolves.toBeUndefined();
  });

  it('rejects close with non-empty HTLCs', async () => {
    const htlc: Htlc = {
      id: '0x3333333333333333333333333333333333333333333333333333333333333333',
      direction: 'AtoB',
      amount: 5n,
      paymentHash: '0xabababababababababababababababababababababababababababababababab',
      expiryMs: 9_999_999_999n,
    };
    const next: ChannelState = {
      channelId,
      version: 5n,
      balanceA: 45n,
      balanceB: 50n,
      htlcs: [htlc],
      finalized: true,
    };
    const signed = await bothSign(next);
    await expect(admitClose(signed, ctx)).rejects.toMatchObject({ code: 'NON_EMPTY_HTLCS' });
  });

  it('rejects non-finalized state', async () => {
    const next: ChannelState = {
      channelId,
      version: 5n,
      balanceA: 50n,
      balanceB: 50n,
      htlcs: [],
      finalized: false,
    };
    const signed = await bothSign(next);
    await expect(admitClose(signed, ctx)).rejects.toMatchObject({ code: 'NOT_FINALIZED' });
  });
});
