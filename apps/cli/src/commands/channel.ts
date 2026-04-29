import type { ChannelId } from '@tainnel/protocol';
import { Command } from 'commander';
import { selectChannel } from '../lib/channel-select.js';
import { buildClient, defaultStorageDir } from '../lib/client.js';
import { CliError } from '../lib/errors.js';
import { type Renderer, pickRenderer } from '../lib/render.js';
import { parseUsdc } from '../lib/units.js';

interface GlobalOpts {
  json?: boolean;
}

function rendererFromCmd(cmd: Command): Renderer {
  const root = cmd.parent?.parent ?? cmd.parent ?? cmd;
  const opts = root.opts() as GlobalOpts;
  return pickRenderer(Boolean(opts.json));
}

export function channelCommand(): Command {
  const cmd = new Command('channel').description('Manage payment channels');

  cmd
    .command('open')
    .description('Open a new payment channel with a hub')
    .requiredOption('--hub <url>', 'Hub URL (ws://, wss://, http://, or https://)')
    .requiredOption('--amount <usdc>', 'Amount in USDC (6-decimals)')
    .option('--counterparty-amount <usdc>', 'Optional counterparty deposit (default 0)')
    .option('--storage-dir <path>', 'Override channel storage directory')
    .action(
      async (
        opts: {
          hub: string;
          amount: string;
          counterpartyAmount?: string;
          storageDir?: string;
        },
        cmd: Command,
      ) => {
        const renderer = rendererFromCmd(cmd);
        const amount = parseUsdc(opts.amount);
        const counterpartyAmount =
          opts.counterpartyAmount !== undefined ? parseUsdc(opts.counterpartyAmount) : 0n;
        const built = await buildClient({
          hubUrl: opts.hub,
          ...(opts.storageDir !== undefined ? { storageDir: opts.storageDir } : {}),
        });
        try {
          const channel = await built.client.open({ amount, counterpartyAmount });
          renderer.channelOpened({
            channelId: channel.id,
            counterparty: built.hubInfo.address,
            amount,
            status: channel.status,
            txHash: `0x${'00'.repeat(32)}`, // not surfaced by SDK; fill at receipt time when wired
          });
        } finally {
          await built.cleanup();
        }
      },
    );

  cmd
    .command('list')
    .description('List local channels')
    .option(
      '--hub <url>',
      'Filter to channels with this hub (still requires keystore for balance lookup)',
    )
    .option('--storage-dir <path>', 'Override channel storage directory')
    .action(async (opts: { hub?: string; storageDir?: string }, cmd: Command) => {
      const renderer = rendererFromCmd(cmd);
      if (!opts.hub) {
        // No hub URL: read filesystem directly so we don't require a running hub.
        const { FileStorage } = await import('@tainnel/sdk');
        const storage = await FileStorage.createNode(opts.storageDir ?? defaultStorageDir());
        const channels = await storage.list();
        renderer.channelList(channels.map((channel) => ({ channel, balance: undefined })));
        return;
      }
      const built = await buildClient({
        hubUrl: opts.hub,
        ...(opts.storageDir !== undefined ? { storageDir: opts.storageDir } : {}),
      });
      try {
        const channels = await built.client.list();
        const rows = await Promise.all(
          channels.map(async (channel) => {
            try {
              const balance = await built.client.getBalance(channel.id);
              return { channel, balance };
            } catch {
              return { channel, balance: undefined };
            }
          }),
        );
        renderer.channelList(rows);
      } finally {
        await built.cleanup();
      }
    });

  cmd
    .command('close <id>')
    .description('Close a channel by id')
    .requiredOption('--hub <url>', 'Hub URL the channel belongs to')
    .option('--cooperative', 'Try a cooperative close first', true)
    .option('--unilateral', 'Force a unilateral close (skip the cooperative path)', false)
    .option('--storage-dir <path>', 'Override channel storage directory')
    .option('--no-wait-finalized', 'Do not block waiting for the on-chain ChannelFinalized event')
    .action(
      async (
        idArg: string,
        opts: {
          hub: string;
          cooperative: boolean;
          unilateral: boolean;
          storageDir?: string;
          waitFinalized: boolean;
        },
        cmd: Command,
      ) => {
        const renderer = rendererFromCmd(cmd);
        const cooperative = opts.unilateral ? false : opts.cooperative;
        const built = await buildClient({
          hubUrl: opts.hub,
          ...(opts.storageDir !== undefined ? { storageDir: opts.storageDir } : {}),
        });
        try {
          const channelId = idArg as ChannelId;
          await built.client.close(channelId, { cooperative });
          let finalized: { paidA: bigint; paidB: bigint; txHash: string } | undefined;
          if (opts.waitFinalized) {
            try {
              finalized = await built.client.waitForFinalized(channelId);
            } catch (err) {
              const e = err as Error;
              if (!/Unsupported|memory|in-memory/i.test(e.message)) throw err;
            }
          }
          const channels = await built.client.list();
          const post = channels.find((c) => c.id === channelId);
          // Determine which side is "us" so balances render from our perspective.
          const me = built.walletAddress.toLowerCase();
          const wasUserA = post?.userA.toLowerCase() === me;
          renderer.channelClosed({
            channelId,
            cooperative,
            status: post?.status ?? 'unknown',
            ...(finalized
              ? {
                  paidUs: wasUserA ? finalized.paidA : finalized.paidB,
                  paidCounterparty: wasUserA ? finalized.paidB : finalized.paidA,
                  txHash: finalized.txHash as `0x${string}`,
                }
              : {}),
          });
        } finally {
          await built.cleanup();
        }
      },
    );

  return cmd;
}

void selectChannel;
void CliError;
