import { Command } from 'commander';
import pc from 'picocolors';
import { listWorkspacePackages } from '../utils/workspace.js';

export function helloCommand(): Command {
  return new Command('hello')
    .description('Print every workspace package and its current version')
    .action(() => {
      const packages = listWorkspacePackages();
      console.info(pc.bold('tainnel — workspace packages'));
      for (const pkg of packages) {
        console.info(`  ${pc.cyan(pkg.name.padEnd(28))} ${pc.dim(pkg.version)}  (${pkg.path})`);
      }
      console.info('');
      console.info(pc.green(`✓ ${packages.length} packages wired into the monorepo`));
    });
}
