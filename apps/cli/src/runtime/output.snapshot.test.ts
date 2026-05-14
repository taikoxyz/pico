import type { Channel } from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import { jsonLine } from './output.js';

// Snapshot the JSON shape of every payload the CLI's `emit` function
// produces with `--json`. Agent parsers depend on these key names and
// value formats; renaming or reshaping any field is a breaking change
// for downstream consumers and must surface as a snapshot diff.
//
// Each fixture mirrors a literal payload assembled in apps/cli/src/commands/*.
// If a CLI command's payload changes, update the corresponding fixture
// here and the inline snapshot in lockstep — the diff is the contract.

const SAMPLE_CHANNEL: Channel = {
  id: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  chainId: 167000,
  contract: '0x0000000000000000000000000000000000000010',
  userA: '0x0000000000000000000000000000000000000011',
  userB: '0x0000000000000000000000000000000000000012',
  token: '0x0000000000000000000000000000000000000099',
  status: 'open',
  openedAt: 1_700_000_000_000n,
  disputeWindowMs: 86_400_000,
};

describe('CLI JSON output — shape snapshots', () => {
  it('channel open success payload', () => {
    const payload = {
      channelId: SAMPLE_CHANNEL.id,
      openTxHash: '0xbbbb000000000000000000000000000000000000000000000000000000000001',
      blockNumber: '12345',
      approveTxHash: '0xcccc000000000000000000000000000000000000000000000000000000000002',
      channel: SAMPLE_CHANNEL,
    };
    expect(jsonLine(payload)).toMatchInlineSnapshot(
      `"{"channelId":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","openTxHash":"0xbbbb000000000000000000000000000000000000000000000000000000000001","blockNumber":"12345","approveTxHash":"0xcccc000000000000000000000000000000000000000000000000000000000002","channel":{"id":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","chainId":167000,"contract":"0x0000000000000000000000000000000000000010","userA":"0x0000000000000000000000000000000000000011","userB":"0x0000000000000000000000000000000000000012","token":"0x0000000000000000000000000000000000000099","status":"open","openedAt":"1700000000000","disputeWindowMs":86400000}}"`,
    );
  });

  it('channel open subscribe-failure payload (post-open warning)', () => {
    const payload = {
      channelId: SAMPLE_CHANNEL.id,
      openTxHash: '0xbbbb000000000000000000000000000000000000000000000000000000000001',
      blockNumber: '12345',
      channel: SAMPLE_CHANNEL,
      warning: 'hub subscribe failed; channel is on-chain and persisted locally',
      subscribeError: 'connection refused',
    };
    expect(jsonLine(payload)).toMatchInlineSnapshot(
      `"{"channelId":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","openTxHash":"0xbbbb000000000000000000000000000000000000000000000000000000000001","blockNumber":"12345","channel":{"id":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","chainId":167000,"contract":"0x0000000000000000000000000000000000000010","userA":"0x0000000000000000000000000000000000000011","userB":"0x0000000000000000000000000000000000000012","token":"0x0000000000000000000000000000000000000099","status":"open","openedAt":"1700000000000","disputeWindowMs":86400000},"warning":"hub subscribe failed; channel is on-chain and persisted locally","subscribeError":"connection refused"}"`,
    );
  });

  it('channel list payload — an array of Channel objects', () => {
    expect(jsonLine([SAMPLE_CHANNEL])).toMatchInlineSnapshot(
      `"[{"id":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","chainId":167000,"contract":"0x0000000000000000000000000000000000000010","userA":"0x0000000000000000000000000000000000000011","userB":"0x0000000000000000000000000000000000000012","token":"0x0000000000000000000000000000000000000099","status":"open","openedAt":"1700000000000","disputeWindowMs":86400000}]"`,
    );
  });

  it('channel close-from-open payload', () => {
    const payload = {
      channelId: SAMPLE_CHANNEL.id,
      kind: 'unilateralFromOpen',
      txHash: '0xdddd000000000000000000000000000000000000000000000000000000000003',
      blockNumber: '12350',
      disputeDeadlineMs: '1700086400000',
    };
    expect(jsonLine(payload)).toMatchInlineSnapshot(
      `"{"channelId":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"unilateralFromOpen","txHash":"0xdddd000000000000000000000000000000000000000000000000000000000003","blockNumber":"12350","disputeDeadlineMs":"1700086400000"}"`,
    );
  });

  it('channel close (cooperative or unilateral) payload', () => {
    const payload = {
      channelId: SAMPLE_CHANNEL.id,
      kind: 'cooperative',
      txHash: '0xeeee000000000000000000000000000000000000000000000000000000000004',
      blockNumber: '12360',
    };
    expect(jsonLine(payload)).toMatchInlineSnapshot(
      `"{"channelId":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"cooperative","txHash":"0xeeee000000000000000000000000000000000000000000000000000000000004","blockNumber":"12360"}"`,
    );
  });

  it('pay verifying stage payload', () => {
    expect(jsonLine({ stage: 'verifying' })).toMatchInlineSnapshot(`"{"stage":"verifying"}"`);
  });

  it('pay settled (invoice) payload', () => {
    const payload = {
      settled: true,
      preimage: '0x1111111111111111111111111111111111111111111111111111111111111111',
      channelId: SAMPLE_CHANNEL.id,
    };
    expect(jsonLine(payload)).toMatchInlineSnapshot(
      `"{"settled":true,"preimage":"0x1111111111111111111111111111111111111111111111111111111111111111","channelId":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"`,
    );
  });

  it('pay settled (invoice, preimage withheld) payload', () => {
    const payload = {
      settled: true,
      preimage: undefined,
      channelId: SAMPLE_CHANNEL.id,
    };
    // JSON.stringify drops keys whose value is undefined — agent parsers
    // must tolerate the field being absent rather than `null`.
    expect(jsonLine(payload)).toMatchInlineSnapshot(
      `"{"settled":true,"channelId":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"`,
    );
  });

  it('pay settled (keysend) payload', () => {
    const payload = {
      settled: true,
      preimage: '0x2222222222222222222222222222222222222222222222222222222222222222',
      channelId: SAMPLE_CHANNEL.id,
      keysend: true,
    };
    expect(jsonLine(payload)).toMatchInlineSnapshot(
      `"{"settled":true,"preimage":"0x2222222222222222222222222222222222222222222222222222222222222222","channelId":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","keysend":true}"`,
    );
  });

  it('invoice create payload (with preimage revealed)', () => {
    const payload = {
      invoice: {
        paymentHash: '0xaaaa000000000000000000000000000000000000000000000000000000000010',
        amount: 1_000n,
        expiresAt: 1_700_000_300_000n,
      },
      preimage: '0x3333333333333333333333333333333333333333333333333333333333333333',
      paymentHash: '0xaaaa000000000000000000000000000000000000000000000000000000000010',
      envelope: 'picoinv1...',
    };
    expect(jsonLine(payload)).toMatchInlineSnapshot(
      `"{"invoice":{"paymentHash":"0xaaaa000000000000000000000000000000000000000000000000000000000010","amount":"1000","expiresAt":"1700000300000"},"preimage":"0x3333333333333333333333333333333333333333333333333333333333333333","paymentHash":"0xaaaa000000000000000000000000000000000000000000000000000000000010","envelope":"picoinv1..."}"`,
    );
  });

  it('hub status payload', () => {
    const payload = {
      hubUrl: 'ws://127.0.0.1:9050',
      health: { ok: true },
      info: { hubAddress: '0x0000000000000000000000000000000000000022', chainId: 167000 },
      stats: { channels: 3, payments: 42 },
    };
    expect(jsonLine(payload)).toMatchInlineSnapshot(
      `"{"hubUrl":"ws://127.0.0.1:9050","health":{"ok":true},"info":{"hubAddress":"0x0000000000000000000000000000000000000022","chainId":167000},"stats":{"channels":3,"payments":42}}"`,
    );
  });

  it('bigints are always serialized as JSON strings (never numbers)', () => {
    // The custom replacer maps every bigint to its decimal string. Agent
    // parsers MUST treat numeric fields like `openedAt`, `blockNumber`,
    // and `amount` as strings — JavaScript's Number cannot losslessly
    // hold them.
    expect(jsonLine({ a: 0n, b: 2n ** 64n - 1n })).toBe('{"a":"0","b":"18446744073709551615"}');
  });
});
