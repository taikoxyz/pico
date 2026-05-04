import { CONTRACT_ADDRESSES, TAIKO_MAINNET_CHAIN_ID } from '@pico/protocol';
import { startAnvilFork, startMockHub } from '@pico/test-utils';
import { Command } from 'commander';

export interface DevDeps {
  readonly stdout?: { write(s: string): void };
  readonly signal?: AbortSignal;
}

export function devCommand(deps: DevDeps = {}): Command {
  const cmd = new Command('dev').description('Local development helpers');

  cmd
    .command('anvil-fork')
    .description('Spawn anvil forking Taiko mainnet (requires Foundry)')
    .option('--fork-url <url>', 'RPC URL to fork')
    .option('--fork-block <n>', 'Pin to a specific block')
    .option('--port <n>', 'Port (0=auto)', '0')
    .option('--chain-id <n>', 'Override chain id', String(TAIKO_MAINNET_CHAIN_ID))
    .action(
      async (opts: { forkUrl?: string; forkBlock?: string; port: string; chainId: string }) => {
        const port = Number(opts.port);
        const handle = await startAnvilFork({
          ...(opts.forkUrl !== undefined ? { forkUrl: opts.forkUrl } : {}),
          ...(opts.forkBlock !== undefined ? { forkBlockNumber: BigInt(opts.forkBlock) } : {}),
          ...(port > 0 ? { port } : {}),
          chainId: Number(opts.chainId),
        });
        const stdout = deps.stdout ?? process.stdout;
        stdout.write(`${JSON.stringify({ rpcUrl: handle.rpcUrl, chainId: handle.chainId })}\n`);
        await new Promise<void>((resolve) => {
          const stop = async (): Promise<void> => {
            await handle.stop();
            resolve();
          };
          if (deps.signal) {
            if (deps.signal.aborted) void stop();
            else deps.signal.addEventListener('abort', () => void stop());
          } else {
            process.once('SIGINT', () => void stop());
          }
        });
      },
    );

  cmd
    .command('mock-hub')
    .description('Run an in-process mock hub (Fastify + WS)')
    .option('--port <n>', 'Port (0=auto)', '0')
    .option('--chain-id <n>', 'Chain id for the hub', String(TAIKO_MAINNET_CHAIN_ID))
    .action(async (opts: { port: string; chainId: string }) => {
      const chainId =
        Number(opts.chainId) === TAIKO_MAINNET_CHAIN_ID
          ? TAIKO_MAINNET_CHAIN_ID
          : TAIKO_MAINNET_CHAIN_ID;
      const port = Number(opts.port);
      const handle = await startMockHub({
        ...(port > 0 ? { port } : {}),
        chainId,
        verifyingContract: CONTRACT_ADDRESSES[chainId].PaymentChannel,
      });
      const stdout = deps.stdout ?? process.stdout;
      stdout.write(`${JSON.stringify({ url: handle.url, hubAddress: handle.hubAddress })}\n`);
      await new Promise<void>((resolve) => {
        const stop = async (): Promise<void> => {
          await handle.stop();
          resolve();
        };
        if (deps.signal) {
          if (deps.signal.aborted) void stop();
          else deps.signal.addEventListener('abort', () => void stop());
        } else {
          process.once('SIGINT', () => void stop());
        }
      });
    });

  return cmd;
}
