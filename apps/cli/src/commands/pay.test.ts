import type { Address, Channel, ChannelId, Hex } from '@tainnel/protocol';
import { TAIKO_HOODI_CHAIN_ID } from '@tainnel/protocol';
import type { ChannelClient, PaymentResult } from '@tainnel/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastJsonLine } from '../test-helpers.js';

const hubAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const me = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const bob = '0x80997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const channelId = `0x${'cd'.repeat(32)}` as ChannelId;

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

const paymentResult: PaymentResult = {
  channelId,
  preimage: `0x${'aa'.repeat(32)}` as Hex,
  settledAtMs: 123,
  htlcId: `0x${'bb'.repeat(32)}` as Hex,
};

const built = {
  client: {
    list: vi.fn(async () => [channel]),
    pay: vi.fn(async () => paymentResult),
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

async function runPay(...args: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { payCommand } = await import('./pay.js');
  const program = new Command();
  program.name('tainnel').option('--json', 'json out', false).exitOverride();
  program.addCommand(payCommand());
  await program.parseAsync(['node', 'tainnel', ...args]);
}

describe('pay', () => {
  it('routes a payment via the unique open channel with the hub', async () => {
    await runPay('--json', 'pay', '--to', bob, '--amount', '1', '--via', 'ws://localhost:3030');
    expect(built.client.pay).toHaveBeenCalledWith(channelId, {
      to: bob,
      amount: 1_000_000n,
    });
    const parsed = lastJsonLine(writes);
    expect(parsed.kind).toBe('payment.sent');
    expect(parsed.to).toBe(bob);
  });

  it('throws on bad --to address', async () => {
    await expect(
      runPay('pay', '--to', '0xnope', '--amount', '1', '--via', 'ws://localhost:3030'),
    ).rejects.toThrow();
    expect(built.client.pay).not.toHaveBeenCalled();
  });

  it('throws on bad --amount', async () => {
    await expect(
      runPay('pay', '--to', bob, '--amount', 'oops', '--via', 'ws://localhost:3030'),
    ).rejects.toThrow();
  });

  it('passes --memo through to the SDK', async () => {
    await runPay(
      '--json',
      'pay',
      '--to',
      bob,
      '--amount',
      '1',
      '--via',
      'ws://localhost:3030',
      '--memo',
      'lunch',
    );
    expect(built.client.pay).toHaveBeenCalledWith(channelId, {
      to: bob,
      amount: 1_000_000n,
      memo: 'lunch',
    });
  });

  void ({} as ChannelClient);
});
