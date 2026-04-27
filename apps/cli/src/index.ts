#!/usr/bin/env node
import { Command } from 'commander';
import { channelCommand } from './commands/channel.js';
import { devCommand } from './commands/dev.js';
import { helloCommand } from './commands/hello.js';
import { hubCommand } from './commands/hub.js';
import { payCommand } from './commands/pay.js';

const program = new Command();
program
  .name('tainnel')
  .description('tainnel — trustless 1-hop payment channel network for Taiko L2')
  .version('0.0.0');

program.addCommand(helloCommand());
program.addCommand(channelCommand());
program.addCommand(payCommand());
program.addCommand(hubCommand());
program.addCommand(devCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
