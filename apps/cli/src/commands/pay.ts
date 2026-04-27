import { Command } from 'commander';

export function payCommand(): Command {
  return new Command('pay')
    .requiredOption('--to <address>', 'Recipient EVM address')
    .requiredOption('--amount <usdc>', 'Amount in USDC (6-decimals)')
    .requiredOption('--via <hub>', 'Hub WebSocket URL to route through')
    .description('Send a payment to a recipient via a hub')
    .action(() => {
      throw new Error('not implemented');
    });
}
