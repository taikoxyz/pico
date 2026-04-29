#!/usr/bin/env node
import { Command } from 'commander';
import { channelCommand } from './commands/channel.js';
import { devCommand } from './commands/dev.js';
import { helloCommand } from './commands/hello.js';
import { hubCommand } from './commands/hub.js';
import { invoiceCommand } from './commands/invoice.js';
import { keysCommand } from './commands/keys.js';
import { listenCommand } from './commands/listen.js';
import { payCommand } from './commands/pay.js';

const program = new Command();
program
  .name('tainnel')
  .description('tainnel — agent runtime CLI for Taiko payment channels')
  .version('0.0.0');

program.addCommand(helloCommand());
program.addCommand(keysCommand());
program.addCommand(channelCommand());
program.addCommand(invoiceCommand());
program.addCommand(payCommand());
program.addCommand(listenCommand());
program.addCommand(hubCommand());
program.addCommand(devCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
