import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTRACT_ADDRESSES, TAIKO_MAINNET_CHAIN_ID } from '@inferenceroom/pico-protocol';
import { type MockHubHandle, startMockHub } from '@inferenceroom/pico-test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listenCommand } from './listen.js';

const PK = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;

describe('pico listen', () => {
  let hub: MockHubHandle;

  beforeEach(async () => {
    hub = await startMockHub({
      chainId: TAIKO_MAINNET_CHAIN_ID,
      verifyingContract: CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID].Adjudicator,
    });
  });

  afterEach(async () => {
    await hub.stop();
  });

  it('connects to a hub, subscribes, and exits cleanly on abort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-l-'));
    const ctrl = new AbortController();
    const log = { info: () => {}, warn: () => {} };
    const cmd = listenCommand({
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      storageOverride: join(dir, 'db'),
      logger: log,
      signal: ctrl.signal,
    });
    const promise = cmd.parseAsync(['node', 'pico', '--hub', hub.url]);
    setTimeout(() => ctrl.abort(), 200);
    await expect(promise).resolves.toBeDefined();
  });
});
