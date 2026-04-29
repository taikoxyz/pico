import { Command } from 'commander';
import { fetchHubInfo } from '../lib/client.js';
import { type Renderer, pickRenderer } from '../lib/render.js';
import { deriveHubUrls } from '../lib/url.js';

interface GlobalOpts {
  json?: boolean;
}

function rendererFromCmd(cmd: Command): Renderer {
  const root = cmd.parent?.parent ?? cmd.parent ?? cmd;
  const opts = root.opts() as GlobalOpts;
  return pickRenderer(Boolean(opts.json));
}

export function hubCommand(): Command {
  const cmd = new Command('hub').description('Hub-related operations');
  cmd
    .command('status <url>')
    .description('Query the health and capacity of a hub')
    .action(async (urlArg: string, _opts: unknown, cmd: Command) => {
      const renderer = rendererFromCmd(cmd);
      const urls = deriveHubUrls(urlArg);
      const info = await fetchHubInfo(urls.http);
      renderer.hubStatus({ ...info, url: urls.http });
      if (info.status !== 'ok') process.exitCode = 2;
    });
  return cmd;
}
