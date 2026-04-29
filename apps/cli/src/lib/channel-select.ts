import type { Address, Channel, ChannelId } from '@tainnel/protocol';
import type { ChannelClient } from '@tainnel/sdk';
import { CliError } from './errors.js';

export interface SelectChannelOpts {
  readonly client: ChannelClient;
  readonly hubAddress: Address;
  readonly channelId?: string;
}

/** Pick a single channel for a payment or close. Match by channelId if given;
 * otherwise prefer the unique open channel with this hub. */
export async function selectChannel(opts: SelectChannelOpts): Promise<Channel> {
  const channels = await opts.client.list();
  if (opts.channelId) {
    const found = channels.find((c) => c.id === opts.channelId);
    if (!found) {
      throw new CliError(`channel ${opts.channelId} not found in local storage`, {
        code: 'UNKNOWN_CHANNEL',
      });
    }
    return found;
  }
  const candidates = channels.filter(
    (c) =>
      c.status === 'open' &&
      (c.userA.toLowerCase() === opts.hubAddress.toLowerCase() ||
        c.userB.toLowerCase() === opts.hubAddress.toLowerCase()),
  );
  if (candidates.length === 0) {
    throw new CliError(`no open channel with hub ${opts.hubAddress}`, {
      code: 'NO_OPEN_CHANNEL',
    });
  }
  if (candidates.length > 1) {
    const ids = candidates.map((c) => c.id).join(', ');
    throw new CliError(
      `multiple open channels with hub ${opts.hubAddress}; pass --channel-id to disambiguate (${ids})`,
      { code: 'AMBIGUOUS_CHANNEL' },
    );
  }
  const [only] = candidates;
  if (!only) {
    throw new CliError(`no open channel with hub ${opts.hubAddress}`, { code: 'NO_OPEN_CHANNEL' });
  }
  return only;
}

export type { ChannelId };
