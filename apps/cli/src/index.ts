#!/usr/bin/env node
import { Command } from 'commander';
import { channelCommand } from './commands/channel.js';
import { devCommand } from './commands/dev.js';
import { helloCommand } from './commands/hello.js';
import { hubCommand } from './commands/hub.js';
import { payCommand } from './commands/pay.js';
import { CliError } from './lib/errors.js';
import { pickRenderer } from './lib/render.js';

const program = new Command();
program
  .name('tainnel')
  .description('tainnel — trustless 1-hop payment channel network for Taiko L2')
  .version('0.0.0')
  .option('--json', 'machine-readable JSON output', false);

program.addCommand(helloCommand());
program.addCommand(channelCommand());
program.addCommand(payCommand());
program.addCommand(hubCommand());
program.addCommand(devCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  const useJson = Boolean((program.opts() as { json?: boolean }).json);
  const renderer = pickRenderer(useJson);
  const error = err instanceof Error ? err : new Error(String(err));
  renderer.error(error);
  if (err instanceof CliError) {
    process.exit(err.exitCode);
  }
  process.exit(1);
});
