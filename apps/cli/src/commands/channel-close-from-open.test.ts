import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelId, Hash } from '@inferenceroom/pico-protocol';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerCloseFromOpen } from './channel-close-from-open.js';

class StubStream {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

const PK = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const CHANNEL_ID = `0x${'cd'.repeat(32)}` as ChannelId;

function makeRoot(): Command {
  return new Command('channel');
}

describe('pico channel close-from-open', () => {
  it('happy path: invokes client.closeUnilateralFromOpen and prints txHash + deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-cfo-'));
    const stdout = new StubStream();
    const stderr = new StubStream();
    const calls: ChannelId[] = [];
    const txHash = `0x${'ab'.repeat(32)}` as Hash;
    // 2026-05-11T00:00:00Z
    const deadlineMs = Date.UTC(2026, 4, 11, 0, 0, 0);

    const root = makeRoot();
    registerCloseFromOpen(root, {
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      stdout,
      stderr,
      storageOverride: join(dir, 'db'),
      clientFactory: () => ({
        client: {
          async closeUnilateralFromOpen(id) {
            calls.push(id);
            return { txHash, disputeDeadlineMs: BigInt(deadlineMs) };
          },
        },
        dispose: async () => {},
      }),
    });

    await root.parseAsync(['node', 'pico', 'close-from-open', CHANNEL_ID]);
    expect(calls).toEqual([CHANNEL_ID]);
    expect(stdout.buf).toContain(`closing-unilateral: ${CHANNEL_ID}`);
    expect(stdout.buf).toContain(txHash);
    expect(stdout.buf).toContain(new Date(deadlineMs).toISOString());
    expect(stdout.buf).toContain('Funds will be available after the dispute window');
  });

  it('error path: surfaces SDK error with hint when state is not initial', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-cfo-'));
    const stdout = new StubStream();
    const stderr = new StubStream();

    const root = makeRoot();
    registerCloseFromOpen(root, {
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      stdout,
      stderr,
      storageOverride: join(dir, 'db'),
      clientFactory: () => ({
        client: {
          async closeUnilateralFromOpen() {
            throw new Error('postedVersion != 0');
          },
        },
        dispose: async () => {},
      }),
    });

    await expect(root.parseAsync(['node', 'pico', 'close-from-open', CHANNEL_ID])).rejects.toThrow(
      /postedVersion/,
    );
    expect(stderr.buf).toContain('close-from-open failed: postedVersion != 0');
    expect(stderr.buf).toContain('use `pico channel close` instead');
  });
});
