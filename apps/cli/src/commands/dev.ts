import { Command } from 'commander';

export function devCommand(): Command {
  const cmd = new Command('dev').description('Local development helpers');
  cmd
    .command('anvil-fork')
    .description('Spawn a local anvil process forked from Taiko mainnet for testing')
    .action(() => {
      throw new Error('not implemented');
    });
  return cmd;
}
