import type { Address, Channel, ChannelId } from '@tainnel/protocol';
import { TAIKO_HOODI_CHAIN_ID } from '@tainnel/protocol';
import type { ChannelClient } from '@tainnel/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastJsonLine } from '../test-helpers.js';

const hubAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const me = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const channelId = `0x${'cd'.repeat(32)}` as ChannelId;

interface FakeBuilt {
  client: Partial<ChannelClient>;
  hubInfo: {
    address: Address;
    chainId: number;
    status: string;
    dbReady: boolean;
    chainReady: boolean;
    version: string;
  };
  hubUrls: { ws: string; http: string };
  walletAddress: Address;
  storageDir: string;
  cleanup: () => Promise<void>;
}

const built: FakeBuilt = {
  client: {
    open: vi.fn(),
    list: vi.fn(),
    getBalance: vi.fn(),
    close: vi.fn(),
    waitForFinalized: vi.fn(),
  },
  hubInfo: {
    address: hubAddress,
    chainId: TAIKO_HOODI_CHAIN_ID,
    status: 'ok',
    dbReady: true,
    chainReady: true,
    version: '0.1.0',
  },
  hubUrls: { ws: 'ws://localhost:3030/v1/ws', http: 'http://localhost:3030' },
  walletAddress: me,
  storageDir: '/tmp/tainnel-test',
  cleanup: vi.fn(async () => {}),
};

vi.mock('../lib/client.js', async () => ({
  buildClient: vi.fn(async () => built),
  defaultStorageDir: () => '/tmp/tainnel-test',
  fetchHubInfo: vi.fn(),
  contractAddressFor: vi.fn(),
  usdcTokenFor: vi.fn(),
}));

vi.mock('@tainnel/sdk', async () => {
  const actual = await vi.importActual<typeof import('@tainnel/sdk')>('@tainnel/sdk');
  return {
    ...actual,
    FileStorage: { createNode: vi.fn(async () => ({ list: async () => [] })) },
  };
});

let writes: string[] = [];
let writeOriginal: typeof process.stdout.write;
beforeEach(() => {
  writes = [];
  writeOriginal = process.stdout.write;
  process.stdout.write = ((c: string | Uint8Array) => {
    writes.push(typeof c === 'string' ? c : c.toString());
    return true;
  }) as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = writeOriginal;
  vi.clearAllMocks();
});

async function runChannel(...args: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { channelCommand } = await import('./channel.js');
  const program = new Command();
  program.name('tainnel').option('--json', 'json out', false).exitOverride();
  program.addCommand(channelCommand());
  await program.parseAsync(['node', 'tainnel', ...args]);
}

describe('channel open', () => {
  it('opens a channel and renders JSON when --json is set', async () => {
    const channel: Channel = {
      id: channelId,
      chainId: TAIKO_HOODI_CHAIN_ID,
      contract: '0x1111111111111111111111111111111111111111' as Address,
      userA: me,
      userB: hubAddress,
      token: '0x2222222222222222222222222222222222222222' as Address,
      status: 'open',
      openedAt: 1n,
      disputeWindowMs: 60_000,
    };
    (built.client.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce(channel);
    await runChannel('--json', 'channel', 'open', '--hub', 'ws://localhost:3030', '--amount', '5');
    expect(built.client.open).toHaveBeenCalledWith({ amount: 5_000_000n, counterpartyAmount: 0n });
    expect(built.cleanup).toHaveBeenCalled();
    const parsed = lastJsonLine(writes);
    expect(parsed.kind).toBe('channel.opened');
    expect(parsed.channelId).toBe(channelId);
    expect(parsed.amount).toBe('5000000');
  });

  it('throws on bad --amount', async () => {
    await expect(
      runChannel('channel', 'open', '--hub', 'ws://localhost:3030', '--amount', 'oops'),
    ).rejects.toThrow();
  });
});

describe('channel close', () => {
  it('forwards cooperative=true by default', async () => {
    (built.client.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (built.client.waitForFinalized as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Unsupported'),
    );
    await runChannel('--json', 'channel', 'close', channelId, '--hub', 'ws://localhost:3030');
    expect(built.client.close).toHaveBeenCalledWith(channelId, { cooperative: true });
  });

  it('--unilateral switches to unilateral close', async () => {
    (built.client.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (built.client.waitForFinalized as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Unsupported'),
    );
    await runChannel(
      '--json',
      'channel',
      'close',
      channelId,
      '--hub',
      'ws://localhost:3030',
      '--unilateral',
    );
    expect(built.client.close).toHaveBeenCalledWith(channelId, { cooperative: false });
  });

  it('renders finalized balances when waitForFinalized resolves', async () => {
    const channel: Channel = {
      id: channelId,
      chainId: TAIKO_HOODI_CHAIN_ID,
      contract: '0x1111111111111111111111111111111111111111' as Address,
      userA: me,
      userB: hubAddress,
      token: '0x2222222222222222222222222222222222222222' as Address,
      status: 'closed',
      openedAt: 1n,
      disputeWindowMs: 60_000,
    };
    (built.client.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([channel]);
    (built.client.waitForFinalized as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      channelId,
      paidA: 4_000_000n,
      paidB: 1_000_000n,
      txHash: `0x${'44'.repeat(32)}`,
    });
    await runChannel('--json', 'channel', 'close', channelId, '--hub', 'ws://localhost:3030');
    const parsed = lastJsonLine(writes);
    expect(parsed.kind).toBe('channel.closed');
    expect(parsed.paidUs).toBe('4000000');
    expect(parsed.paidCounterparty).toBe('1000000');
  });
});

describe('channel list', () => {
  it('lists local channels using the SDK when --hub is given', async () => {
    const channel: Channel = {
      id: channelId,
      chainId: TAIKO_HOODI_CHAIN_ID,
      contract: '0x1111111111111111111111111111111111111111' as Address,
      userA: me,
      userB: hubAddress,
      token: '0x2222222222222222222222222222222222222222' as Address,
      status: 'open',
      openedAt: 1n,
      disputeWindowMs: 60_000,
    };
    (built.client.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([channel]);
    (built.client.getBalance as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      balanceUs: 5_000_000n,
      balanceCounterparty: 0n,
      pendingHtlcsTotal: 0n,
    });
    await runChannel('--json', 'channel', 'list', '--hub', 'ws://localhost:3030');
    const parsed = lastJsonLine<{ kind: string; channels: { balanceUs: string }[] }>(writes);
    expect(parsed.kind).toBe('channel.list');
    expect(parsed.channels).toHaveLength(1);
    expect(parsed.channels[0]?.balanceUs).toBe('5000000');
  });

  it('reads the filesystem directly when --hub is omitted', async () => {
    await runChannel('--json', 'channel', 'list');
    const parsed = lastJsonLine<{ kind: string; channels: unknown[] }>(writes);
    expect(parsed.kind).toBe('channel.list');
    expect(parsed.channels).toHaveLength(0);
  });
});
