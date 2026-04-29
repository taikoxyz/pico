import type { Address, Channel, ChannelId } from '@tainnel/protocol';
import type { ChannelClient } from '@tainnel/sdk';
import { describe, expect, it } from 'vitest';
import { selectChannel } from './channel-select.js';
import { CliError } from './errors.js';

const hub = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const otherHub = '0x80997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const me = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

function makeChannel(over: Partial<Channel> = {}): Channel {
  return {
    id: `0x${'cd'.repeat(32)}` as ChannelId,
    chainId: 167009,
    contract: '0x1111111111111111111111111111111111111111' as Address,
    userA: me,
    userB: hub,
    token: '0x2222222222222222222222222222222222222222' as Address,
    status: 'open',
    openedAt: 1n,
    disputeWindowMs: 60_000,
    ...over,
  };
}

function fakeClient(channels: Channel[]): ChannelClient {
  return { list: async () => channels } as unknown as ChannelClient;
}

describe('selectChannel', () => {
  it('returns the unique open channel with the hub', async () => {
    const ch = makeChannel();
    const got = await selectChannel({ client: fakeClient([ch]), hubAddress: hub });
    expect(got.id).toBe(ch.id);
  });

  it('returns the channel matching --channel-id verbatim', async () => {
    const a = makeChannel({ id: `0x${'aa'.repeat(32)}` as ChannelId });
    const b = makeChannel({ id: `0x${'bb'.repeat(32)}` as ChannelId });
    const got = await selectChannel({
      client: fakeClient([a, b]),
      hubAddress: hub,
      channelId: b.id,
    });
    expect(got.id).toBe(b.id);
  });

  it('throws when --channel-id is unknown', async () => {
    await expect(
      selectChannel({
        client: fakeClient([]),
        hubAddress: hub,
        channelId: `0x${'00'.repeat(32)}`,
      }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('throws when no open channel with the hub', async () => {
    await expect(selectChannel({ client: fakeClient([]), hubAddress: hub })).rejects.toBeInstanceOf(
      CliError,
    );
  });

  it('skips closed channels when picking the unique candidate', async () => {
    const closed = makeChannel({ id: `0x${'aa'.repeat(32)}` as ChannelId, status: 'closed' });
    const open = makeChannel({ id: `0x${'bb'.repeat(32)}` as ChannelId });
    const got = await selectChannel({ client: fakeClient([closed, open]), hubAddress: hub });
    expect(got.id).toBe(open.id);
  });

  it('skips channels with a different hub', async () => {
    const otherChannel = makeChannel({ id: `0x${'aa'.repeat(32)}` as ChannelId, userB: otherHub });
    const correct = makeChannel({ id: `0x${'bb'.repeat(32)}` as ChannelId });
    const got = await selectChannel({
      client: fakeClient([otherChannel, correct]),
      hubAddress: hub,
    });
    expect(got.id).toBe(correct.id);
  });

  it('throws when multiple open channels with the hub exist', async () => {
    const a = makeChannel({ id: `0x${'aa'.repeat(32)}` as ChannelId });
    const b = makeChannel({ id: `0x${'bb'.repeat(32)}` as ChannelId });
    await expect(selectChannel({ client: fakeClient([a, b]), hubAddress: hub })).rejects.toThrow(
      /multiple open channels/,
    );
  });
});
