import type { Address, Channel, ChannelId, Hex } from '@tainnel/protocol';
import type { PaymentResult } from '@tainnel/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonRenderer, pickRenderer, prettyRenderer } from './render.js';

const channelId = `0x${'cd'.repeat(32)}` as ChannelId;
const txHash = `0x${'11'.repeat(32)}` as Hex;
const counterparty = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;

let stdout: string[] = [];
let stderr: string[] = [];
let writeStdout: typeof process.stdout.write;
let writeStderr: typeof process.stderr.write;

beforeEach(() => {
  stdout = [];
  stderr = [];
  writeStdout = process.stdout.write;
  writeStderr = process.stderr.write;
  process.stdout.write = ((c: string | Uint8Array) => {
    stdout.push(typeof c === 'string' ? c : c.toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderr.push(typeof c === 'string' ? c : c.toString());
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stdout.write = writeStdout;
  process.stderr.write = writeStderr;
  vi.restoreAllMocks();
});

describe('pickRenderer', () => {
  it('selects pretty when useJson=false', () => {
    expect(pickRenderer(false)).toBe(prettyRenderer);
  });
  it('selects json when useJson=true', () => {
    expect(pickRenderer(true)).toBe(jsonRenderer);
  });
});

describe('jsonRenderer', () => {
  it('emits one JSON object per line for channelOpened with bigints as strings', () => {
    jsonRenderer.channelOpened({
      channelId,
      txHash,
      status: 'open',
      counterparty,
      amount: 5_000_000n,
    });
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0] ?? '');
    expect(parsed.kind).toBe('channel.opened');
    expect(parsed.channelId).toBe(channelId);
    expect(parsed.amount).toBe('5000000');
  });

  it('emits a structured payment.sent line', () => {
    const result: PaymentResult & { to: Address } = {
      channelId,
      preimage: `0x${'aa'.repeat(32)}` as Hex,
      settledAtMs: 123,
      htlcId: `0x${'bb'.repeat(32)}` as Hex,
      to: counterparty,
    };
    jsonRenderer.paymentSent(result);
    const parsed = JSON.parse(stdout[0] ?? '');
    expect(parsed.kind).toBe('payment.sent');
    expect(parsed.to).toBe(counterparty);
  });

  it('serializes channel.list with bigint balance fields', () => {
    const channel: Channel = {
      id: channelId,
      chainId: 167009,
      contract: '0x1111111111111111111111111111111111111111' as Address,
      userA: `0x${'1'.repeat(40)}` as Address,
      userB: counterparty,
      token: `0x${'2'.repeat(40)}` as Address,
      status: 'open',
      openedAt: 1n,
      disputeWindowMs: 1,
    };
    jsonRenderer.channelList([
      {
        channel,
        balance: {
          balanceUs: 100n,
          balanceCounterparty: 200n,
          pendingHtlcsTotal: 0n,
        },
      },
    ]);
    const parsed = JSON.parse(stdout[0] ?? '');
    expect(parsed.kind).toBe('channel.list');
    expect(parsed.channels[0].balanceUs).toBe('100');
  });

  it('writes errors to stderr', () => {
    jsonRenderer.error(new Error('boom'));
    const parsed = JSON.parse(stderr[0] ?? '');
    expect(parsed.kind).toBe('error');
    expect(parsed.message).toBe('boom');
  });
});

describe('prettyRenderer', () => {
  it('writes channelOpened to stdout with the channel id', () => {
    prettyRenderer.channelOpened({
      channelId,
      txHash,
      status: 'open',
      counterparty,
      amount: 5_000_000n,
    });
    const out = stdout.join('');
    expect(out).toContain(channelId);
    expect(out).toContain('5 USDC');
  });

  it('writes "no local channels" when list is empty', () => {
    prettyRenderer.channelList([]);
    expect(stdout.join('')).toContain('no local channels');
  });

  it('writes channelList rows when populated', () => {
    const channel = {
      id: channelId,
      chainId: 167009,
      contract: '0x1' as Address,
      userA: '0xa' as Address,
      userB: counterparty,
      token: '0xt' as Address,
      status: 'open' as const,
      openedAt: 1n,
      disputeWindowMs: 1,
    };
    prettyRenderer.channelList([
      {
        channel,
        balance: { balanceUs: 1_000_000n, balanceCounterparty: 0n, pendingHtlcsTotal: 0n },
      },
      { channel: { ...channel, id: `0x${'aa'.repeat(32)}` as ChannelId }, balance: undefined },
    ]);
    const out = stdout.join('');
    expect(out).toContain(channelId);
    expect(out).toContain('open');
  });

  it('writes channelClosed with paid totals + tx hash', () => {
    prettyRenderer.channelClosed({
      channelId,
      cooperative: true,
      status: 'closed',
      paidUs: 4_000_000n,
      paidCounterparty: 1_000_000n,
      txHash,
    });
    const out = stdout.join('');
    expect(out).toContain('cooperative');
    expect(out).toContain('4 USDC');
    expect(out).toContain('1 USDC');
    expect(out).toContain(txHash);
  });

  it('writes channelClosed when finalize info is missing', () => {
    prettyRenderer.channelClosed({ channelId, cooperative: false, status: 'closing-unilateral' });
    const out = stdout.join('');
    expect(out).toContain('unilateral');
  });

  it('writes paymentSent with all fields', () => {
    prettyRenderer.paymentSent({
      channelId,
      preimage: `0x${'aa'.repeat(32)}` as Hex,
      settledAtMs: 1,
      htlcId: `0x${'bb'.repeat(32)}` as Hex,
      to: counterparty,
    });
    const out = stdout.join('');
    expect(out).toContain('payment settled');
    expect(out).toContain(counterparty);
  });

  it('writes hubStatus (healthy)', () => {
    prettyRenderer.hubStatus({
      status: 'ok',
      dbReady: true,
      chainReady: true,
      address: `0x${'1'.repeat(40)}` as Address,
      chainId: 167009,
      version: '0.1.0',
      url: 'http://hub',
    });
    const out = stdout.join('');
    expect(out).toContain('healthy');
    expect(out).toContain('167009');
    expect(out).toContain('0.1.0');
  });

  it('writes hubStatus (degraded)', () => {
    prettyRenderer.hubStatus({
      status: 'degraded',
      dbReady: false,
      chainReady: false,
      address: `0x${'1'.repeat(40)}` as Address,
      chainId: 167009,
      version: '0.1.0',
      url: 'http://hub',
    });
    expect(stdout.join('')).toContain('degraded');
  });

  it('writes errors to stderr', () => {
    prettyRenderer.error(new Error('boom'));
    expect(stderr.join('')).toContain('boom');
  });
});
