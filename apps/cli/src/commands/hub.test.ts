import { TAIKO_HOODI_CHAIN_ID } from '@tainnel/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastJsonLine } from '../test-helpers.js';

const fetchHubInfo = vi.fn();
vi.mock('../lib/client.js', async () => ({
  buildClient: vi.fn(),
  defaultStorageDir: () => '/tmp/tainnel-test',
  fetchHubInfo,
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
  process.exitCode = 0;
});
afterEach(() => {
  process.stdout.write = writeOriginal;
  process.exitCode = 0;
  vi.clearAllMocks();
});

async function runHub(...args: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { hubCommand } = await import('./hub.js');
  const program = new Command();
  program.name('tainnel').option('--json', 'json out', false).exitOverride();
  program.addCommand(hubCommand());
  await program.parseAsync(['node', 'tainnel', ...args]);
}

describe('hub status', () => {
  it('renders hub status JSON and exits 0 when ok', async () => {
    fetchHubInfo.mockResolvedValueOnce({
      status: 'ok',
      dbReady: true,
      chainReady: true,
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      chainId: TAIKO_HOODI_CHAIN_ID,
      version: '0.1.0',
    });
    await runHub('--json', 'hub', 'status', 'http://localhost:3030');
    const parsed = lastJsonLine(writes);
    expect(parsed.kind).toBe('hub.status');
    expect(parsed.address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(parsed.url).toBe('http://localhost:3030');
    expect(process.exitCode).toBe(0);
  });

  it('sets exitCode=2 when status is degraded', async () => {
    fetchHubInfo.mockResolvedValueOnce({
      status: 'degraded',
      dbReady: false,
      chainReady: false,
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      chainId: TAIKO_HOODI_CHAIN_ID,
      version: '0.1.0',
    });
    await runHub('--json', 'hub', 'status', 'http://localhost:3030');
    expect(process.exitCode).toBe(2);
  });

  it('hits /health (HTTP) even when given a ws:// URL', async () => {
    fetchHubInfo.mockResolvedValueOnce({
      status: 'ok',
      dbReady: true,
      chainReady: true,
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      chainId: TAIKO_HOODI_CHAIN_ID,
      version: '0.1.0',
    });
    await runHub('--json', 'hub', 'status', 'ws://localhost:3030/v1/ws');
    expect(fetchHubInfo).toHaveBeenCalledWith('http://localhost:3030');
  });
});
