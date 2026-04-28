import type { Address, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import type { Log, PublicClient, WalletClient } from 'viem';
import { taiko } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type WatchtowerHandle, assemble } from './index.js';
import { logger } from './logger.js';
import { PenaltyResponder } from './responder.js';
import { openSqlite } from './storage.js';
import { ChainEventWatcher } from './watcher.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000999' as ChannelId;
const contractAddress = '0x07B32f52523Fdf0780821595422DccEF31FA2335' as Address;
const privateKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as Hex;

function makeSignedState(version: bigint): SignedState {
  return {
    state: {
      channelId,
      version,
      balanceA: 100n,
      balanceB: 200n,
      htlcs: [],
      finalized: false,
    },
    sigA: { r: `0x${'aa'.repeat(32)}` as Hex, s: `0x${'bb'.repeat(32)}` as Hex, v: 27 },
    sigB: { r: `0x${'cc'.repeat(32)}` as Hex, s: `0x${'dd'.repeat(32)}` as Hex, v: 28 },
  };
}

interface FakeChain {
  block: bigint;
  emit: (logs: Log[]) => void;
  client: PublicClient;
  walletClient: WalletClient;
  sentTxs: number;
}

function makeFakeChain(): FakeChain {
  let onLogs: ((logs: Log[]) => void) | undefined;
  const f: FakeChain = {
    block: 100n,
    emit: (logs) => onLogs?.(logs),
    sentTxs: 0,
    client: {
      watchContractEvent: ({ onLogs: ol }: { onLogs: (logs: Log[]) => void }) => {
        onLogs = ol;
        return () => {
          onLogs = undefined;
        };
      },
      getBlockNumber: async () => f.block,
      estimateFeesPerGas: async () => ({
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
      }),
      estimateGas: async () => 250_000n,
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({
        status: 'success',
        transactionHash: hash,
      }),
    } as unknown as PublicClient,
    walletClient: {
      sendTransaction: async () => {
        f.sentTxs += 1;
        return `0x${'ee'.repeat(32)}` as Hex;
      },
    } as unknown as WalletClient,
  };
  return f;
}

describe('watchtower integration', () => {
  let handle: WatchtowerHandle;
  let fake: FakeChain;
  let sqlite: ReturnType<typeof openSqlite>;

  beforeEach(() => {
    fake = makeFakeChain();
    sqlite = openSqlite(':memory:');
  });

  afterEach(async () => {
    await handle.stop();
  });

  it('seeds, observes a stale close, and submits a penalty', async () => {
    // pre-seed a known state into the DB so hydrate picks it up
    sqlite.raw
      .prepare(
        `INSERT INTO signed_states (channel_id, version, state_json, sig_a, sig_b, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        channelId,
        '10',
        JSON.stringify({
          state: {
            channelId,
            version: '10',
            balanceA: '100',
            balanceB: '200',
            finalized: false,
            htlcs: [],
          },
          sigA: makeSignedState(10n).sigA,
          sigB: makeSignedState(10n).sigB,
        }),
        JSON.stringify(makeSignedState(10n).sigA),
        JSON.stringify(makeSignedState(10n).sigB),
        Date.now(),
      );

    const responder = new PenaltyResponder({
      rpcUrl: 'http://nope',
      chain: taiko,
      contractAddress,
      privateKey,
      logger,
      publicClient: fake.client,
      walletClient: fake.walletClient,
    });
    const watcher = new ChainEventWatcher({
      rpcUrl: 'http://nope',
      chain: taiko,
      contractAddress,
      logger,
      client: fake.client,
      pollIntervalMs: 30,
      confirmations: 1,
    });

    handle = await assemble(
      {
        port: 0,
        logLevel: 'silent',
        privateKey,
        rpcUrl: 'http://nope',
        dbUrl: ':memory:',
        mode: 'self-hosted',
        chainId: 167000,
        contractAddress,
        windowMs: 24 * 60 * 60 * 1000,
        threshold: 0,
        schedulerIntervalMs: 50,
      },
      { sqliteHandle: sqlite, watcher, responder },
    );

    fake.block = 105n;
    fake.emit([
      {
        eventName: 'ChannelClosingUnilateral',
        args: { channelId, postedVersion: 5n, disputeDeadline: 9_999_999n },
        blockNumber: 100n,
        transactionHash: `0x${'aa'.repeat(32)}` as Hex,
        logIndex: 0,
        address: contractAddress,
        blockHash: `0x${'bb'.repeat(32)}` as Hex,
        data: '0x' as Hex,
        topics: [],
        transactionIndex: 0,
        removed: false,
      } as unknown as Log,
    ]);
    // wait for watcher to advance + scheduler to tick
    await new Promise((res) => setTimeout(res, 200));
    expect(fake.sentTxs).toBeGreaterThanOrEqual(1);
  });
});
