import type { ChannelState, Signature, SignedState } from '@tainnel/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, makeTestDb } from './_test-helpers.js';
import { StaleVersionError } from './state-repo.js';

const ZERO_SIG: Signature = {
  r: `0x${'00'.repeat(32)}`,
  s: `0x${'00'.repeat(32)}`,
  v: 27,
};

function makeState(channelId: string, version: bigint): ChannelState {
  return {
    channelId: channelId as ChannelState['channelId'],
    version,
    balanceA: 100n,
    balanceB: 0n,
    htlcs: [],
    finalized: false,
  };
}

function signed(s: ChannelState): SignedState {
  return { state: s, sigA: ZERO_SIG, sigB: ZERO_SIG };
}

describe('StateRepo', () => {
  let h: TestDb;
  beforeEach(async () => {
    h = await makeTestDb();
  });
  afterEach(async () => h.cleanup());

  it('stores and retrieves the latest signed state', async () => {
    await h.repos.states.save(signed(makeState('0xaa', 1n)));
    await h.repos.states.save(signed(makeState('0xaa', 2n)));
    const latest = await h.repos.states.latest('0xaa');
    expect(latest?.state.version).toBe(2n);
  });

  it('rejects writes at or below the existing version', async () => {
    await h.repos.states.save(signed(makeState('0xaa', 5n)));
    await expect(h.repos.states.save(signed(makeState('0xaa', 5n)))).rejects.toBeInstanceOf(
      StaleVersionError,
    );
    await expect(h.repos.states.save(signed(makeState('0xaa', 3n)))).rejects.toBeInstanceOf(
      StaleVersionError,
    );
  });

  it('loadAllLatest returns one entry per channel at the highest version', async () => {
    await h.repos.states.save(signed(makeState('0xaa', 1n)));
    await h.repos.states.save(signed(makeState('0xaa', 2n)));
    await h.repos.states.save(signed(makeState('0xbb', 7n)));
    const all = await h.repos.states.loadAllLatest();
    expect(all.size).toBe(2);
    expect(all.get('0xaa' as never)?.state.version).toBe(2n);
    expect(all.get('0xbb' as never)?.state.version).toBe(7n);
  });
});
