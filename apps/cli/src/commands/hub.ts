import { Command } from 'commander';

export interface HubDeps {
  readonly fetch?: typeof fetch;
  readonly stdout?: { write(s: string): void };
}

export function hubCommand(deps: HubDeps = {}): Command {
  const cmd = new Command('hub').description('Hub-related operations');
  cmd
    .command('status <url>')
    .description('Query the health endpoint of a hub')
    .action(async (url: string) => {
      const f = deps.fetch ?? fetch;
      const base = url.replace(/\/$/, '');
      const r = await f(`${base}/v1/health`);
      if (!r.ok) {
        const fallback = await f(`${base}/health`);
        if (!fallback.ok) throw new Error(`hub status ${r.status}`);
        const body = await fallback.json();
        (deps.stdout ?? process.stdout).write(`${JSON.stringify(body)}\n`);
        return;
      }
      const body = await r.json();
      (deps.stdout ?? process.stdout).write(`${JSON.stringify(body)}\n`);
    });
  return cmd;
}
