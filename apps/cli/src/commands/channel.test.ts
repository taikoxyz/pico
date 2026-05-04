import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '@pico/sdk';
import { describe, expect, it } from 'vitest';
import { channelCommand } from './channel.js';

class StubStream {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

const PK = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;

describe('pico channel list', () => {
  it('prints (no channels) when storage is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-ch-'));
    const stdout = new StubStream();
    const cmd = channelCommand({
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      stdout,
      storageOverride: join(dir, 'db'),
    });
    await cmd.parseAsync(['node', 'pico', 'list']);
    expect(stdout.buf).toContain('(no channels)');
  });

  it('emits JSON when --json is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-ch-'));
    const root = join(dir, 'db');
    const storage = new FileStorage({ root });
    await storage.saveChannel({
      id: `0x${'cd'.repeat(32)}` as `0x${string}`,
      chainId: 167000,
      contract: '0x0000000000000000000000000000000000000000',
      userA: '0x0000000000000000000000000000000000000001',
      userB: '0x0000000000000000000000000000000000000002',
      token: '0x0000000000000000000000000000000000000000',
      status: 'open',
      openedAt: 1n,
      disputeWindowMs: 86_400_000,
    });
    const stdout = new StubStream();
    const cmd = channelCommand({
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      stdout,
      storageOverride: root,
    });
    await cmd.parseAsync(['node', 'pico', 'list', '--json']);
    expect(stdout.buf).toContain('"id":"0xcdcd');
  });

  it('table format renders rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-ch-'));
    const root = join(dir, 'db');
    const storage = new FileStorage({ root });
    await storage.saveChannel({
      id: `0x${'ab'.repeat(32)}` as `0x${string}`,
      chainId: 167000,
      contract: '0x0000000000000000000000000000000000000000',
      userA: '0x0000000000000000000000000000000000000001',
      userB: '0x0000000000000000000000000000000000000002',
      token: '0x0000000000000000000000000000000000000000',
      status: 'open',
      openedAt: 1n,
      disputeWindowMs: 86_400_000,
    });
    const stdout = new StubStream();
    const cmd = channelCommand({
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      stdout,
      storageOverride: root,
    });
    await cmd.parseAsync(['node', 'pico', 'list']);
    expect(stdout.buf).toContain('open');
  });
});
