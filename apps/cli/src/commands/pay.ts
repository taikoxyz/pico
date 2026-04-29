import type { Address } from '@tainnel/protocol';
import { Command } from 'commander';
import { isAddress } from 'viem';
import { selectChannel } from '../lib/channel-select.js';
import { buildClient } from '../lib/client.js';
import { CliError } from '../lib/errors.js';
import { type Renderer, pickRenderer } from '../lib/render.js';
import { parseUsdc } from '../lib/units.js';

interface GlobalOpts {
  json?: boolean;
}

function rendererFromCmd(cmd: Command): Renderer {
  const root = cmd.parent ?? cmd;
  const opts = root.opts() as GlobalOpts;
  return pickRenderer(Boolean(opts.json));
}

export function payCommand(): Command {
  return new Command('pay')
    .description('Send a payment to a recipient via a hub')
    .requiredOption('--to <address>', 'Recipient EVM address')
    .requiredOption('--amount <usdc>', 'Amount in USDC (6-decimals)')
    .requiredOption('--via <hub>', 'Hub URL to route through')
    .option('--channel-id <id>', 'Disambiguate when multiple channels exist with this hub')
    .option('--memo <text>', 'Optional human-readable note (sent to the hub)')
    .option('--storage-dir <path>', 'Override channel storage directory')
    .action(
      async (
        opts: {
          to: string;
          amount: string;
          via: string;
          channelId?: string;
          memo?: string;
          storageDir?: string;
        },
        cmd: Command,
      ) => {
        const renderer = rendererFromCmd(cmd);
        if (!isAddress(opts.to, { strict: false })) {
          throw new CliError(`--to is not a valid EVM address: ${opts.to}`, {
            code: 'BAD_ADDRESS',
          });
        }
        const amount = parseUsdc(opts.amount);
        const built = await buildClient({
          hubUrl: opts.via,
          ...(opts.storageDir !== undefined ? { storageDir: opts.storageDir } : {}),
        });
        try {
          const channel = await selectChannel({
            client: built.client,
            hubAddress: built.hubInfo.address,
            ...(opts.channelId !== undefined ? { channelId: opts.channelId } : {}),
          });
          const result = await built.client.pay(channel.id, {
            to: opts.to as Address,
            amount,
            ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
          });
          renderer.paymentSent({ ...result, to: opts.to as Address });
        } finally {
          await built.cleanup();
        }
      },
    );
}
