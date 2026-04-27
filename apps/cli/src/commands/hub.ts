import { Command } from 'commander';

export function hubCommand(): Command {
  const cmd = new Command('hub').description('Hub-related operations');
  cmd
    .command('status <url>')
    .description('Query the health and capacity of a hub')
    .action(() => {
      throw new Error('not implemented');
    });
  return cmd;
}
