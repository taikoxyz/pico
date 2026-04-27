import { Command } from 'commander';

export function channelCommand(): Command {
  const cmd = new Command('channel').description('Manage payment channels');

  cmd
    .command('open')
    .requiredOption('--hub <url>', 'Hub WebSocket URL')
    .requiredOption('--amount <usdc>', 'Amount in USDC (6-decimals)')
    .description('Open a new payment channel with a hub')
    .action(() => {
      throw new Error('not implemented');
    });

  cmd
    .command('list')
    .description('List local channels')
    .action(() => {
      throw new Error('not implemented');
    });

  cmd
    .command('close <id>')
    .option('--cooperative', 'Try a cooperative close first', false)
    .description('Close a channel by id')
    .action(() => {
      throw new Error('not implemented');
    });

  return cmd;
}
