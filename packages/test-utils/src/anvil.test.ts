import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { startAnvilFork } from './anvil.js';

const HAS_ANVIL = spawnSync('which', ['anvil']).status === 0;

describe.skipIf(!HAS_ANVIL)('startAnvilFork', () => {
  it('spawns anvil and reports an rpc url', async () => {
    const handle = await startAnvilFork({ chainId: 31337, silent: true });
    try {
      expect(handle.rpcUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.chainId).toBe(31337);
      const r = await fetch(handle.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      const body = (await r.json()) as { result: string };
      expect(Number.parseInt(body.result, 16)).toBe(31337);
    } finally {
      await handle.stop();
    }
  }, 60_000);
});

describe('startAnvilFork (offline checks)', () => {
  it('module exports the expected names', async () => {
    const mod = await import('./anvil.js');
    expect(typeof mod.startAnvilFork).toBe('function');
  });
});
