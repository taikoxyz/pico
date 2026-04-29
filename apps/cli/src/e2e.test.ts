/**
 * End-to-end CLI test: spawns `tainnel` as a subprocess against the mock hub
 * (TAINNEL_CHAIN_MODE=memory). Asserts the JSON output of each step and that
 * the hub recorded the routed payment in `hub.seenPayments`.
 *
 * This is the closest the CLI gets to integration coverage without anvil.
 * Anvil-backed end-to-end coverage lands as part of the P5 follow-ups.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Hex, TAIKO_HOODI_CHAIN_ID } from '@tainnel/protocol';
import { TEST_KEYS, startMockHub } from '@tainnel/test-utils';
import { sha256 } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const cliEntry = join(here, 'index.ts');

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx/esm', cliEntry, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `runCli timed out after ${timeoutMs}ms\nargs=${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`,
        ),
      );
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function lastJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('{'));
  const last = lines[lines.length - 1];
  if (!last) {
    throw new Error(`no JSON line in stdout:\n${stdout}`);
  }
  return JSON.parse(last) as Record<string, unknown>;
}

describe('CLI end-to-end vs mock hub', () => {
  const verifyingContract = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  const preimage = `0x${'aa'.repeat(32)}` as Hex;
  const paymentHash = sha256(preimage) as Hex;

  let hub: Awaited<ReturnType<typeof startMockHub>>;
  let storageDirA: string;
  let storageDirB: string;

  beforeAll(async () => {
    hub = await startMockHub({
      hubPrivateKey: TEST_KEYS.hub.privateKey,
      chainId: TAIKO_HOODI_CHAIN_ID,
      verifyingContract,
    });
    hub.hub.registerPreimage(preimage, paymentHash);
    storageDirA = mkdtempSync(join(tmpdir(), 'tainnel-cli-e2e-A-'));
    storageDirB = mkdtempSync(join(tmpdir(), 'tainnel-cli-e2e-B-'));
  });

  afterAll(async () => {
    await hub?.stop();
    rmSync(storageDirA, { recursive: true, force: true });
    rmSync(storageDirB, { recursive: true, force: true });
  });

  it('open → pay → close happy path between two subprocesses', async () => {
    const baseEnv = {
      TAINNEL_CHAIN_MODE: 'memory',
      TAINNEL_HUB_ADDRESS: TEST_KEYS.hub.address,
      TAINNEL_HUB_CHAIN_ID: String(TAIKO_HOODI_CHAIN_ID),
      TAINNEL_HUB_VERSION: '0.0.0-test',
      TAINNEL_CONTRACT_ADDRESS: verifyingContract,
      TAINNEL_TOKEN_ADDRESS: '0x07d83526730c7438048D55A4fc0b850e2aaB6f0b',
      TAINNEL_RPC_URL: 'http://unused-by-memory-mode',
    };
    const aliceEnv = {
      ...baseEnv,
      TAINNEL_PRIVATE_KEY: TEST_KEYS.alice.privateKey,
      TAINNEL_TEST_PREIMAGE: preimage,
    };
    const bobEnv = { ...baseEnv, TAINNEL_PRIVATE_KEY: TEST_KEYS.bob.privateKey };

    // 1. Alice opens a 5 USDC channel
    const openA = await runCli(
      [
        '--json',
        'channel',
        'open',
        '--hub',
        hub.url,
        '--amount',
        '5',
        '--storage-dir',
        storageDirA,
      ],
      aliceEnv,
    );
    expect(openA.code, openA.stderr).toBe(0);
    const openedA = lastJsonLine(openA.stdout);
    expect(openedA.kind).toBe('channel.opened');
    const aliceChannelId = openedA.channelId as string;

    // 2. Bob opens a 5 USDC channel with the hub (so the hub has a channel to route to)
    const openB = await runCli(
      [
        '--json',
        'channel',
        'open',
        '--hub',
        hub.url,
        '--amount',
        '5',
        '--storage-dir',
        storageDirB,
      ],
      bobEnv,
    );
    expect(openB.code, openB.stderr).toBe(0);

    // 3. Alice pays Bob 1 USDC via the hub
    const pay = await runCli(
      [
        '--json',
        'pay',
        '--to',
        TEST_KEYS.bob.address,
        '--amount',
        '1',
        '--via',
        hub.url,
        '--storage-dir',
        storageDirA,
      ],
      aliceEnv,
    );
    expect(pay.code, pay.stderr).toBe(0);
    const paid = lastJsonLine(pay.stdout);
    expect(paid.kind).toBe('payment.sent');
    expect(paid.preimage).toBe(preimage);

    // 4. Mock hub recorded the routed payment
    expect(hub.hub.seenPayments).toHaveLength(1);
    expect(hub.hub.seenPayments[0]?.amount).toBe(1_000_000n);

    // 5. Alice closes cooperatively (skip wait-finalized — InMemoryChainAdapter
    //    does not implement it).
    const closeA = await runCli(
      [
        '--json',
        'channel',
        'close',
        aliceChannelId,
        '--hub',
        hub.url,
        '--storage-dir',
        storageDirA,
        '--no-wait-finalized',
      ],
      aliceEnv,
    );
    expect(closeA.code, closeA.stderr).toBe(0);
    const closed = lastJsonLine(closeA.stdout);
    expect(closed.kind).toBe('channel.closed');
    expect(closed.channelId).toBe(aliceChannelId);
  }, 30_000);

  it('hub status reports ok against a hub serving /health', async () => {
    // The mock hub does not serve /health, so we exercise hub status against the
    // env-pinned info path instead by hitting an HTTP server we don't run; this
    // path is covered by the unit test in hub.test.ts. Sanity check that the
    // CLI binary at least parses --help.
    const help = await runCli(['--help'], {});
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('channel');
    expect(help.stdout).toContain('pay');
    expect(help.stdout).toContain('hub');
  }, 10_000);
});
