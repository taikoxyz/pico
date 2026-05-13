import { Command } from 'commander';
import { emit } from '../runtime/output.js';

export interface HubDeps {
  readonly fetch?: typeof fetch;
  readonly stdout?: { write(s: string): void };
  readonly stderr?: { write(s: string): void };
}

export function hubCommand(deps: HubDeps = {}): Command {
  const cmd = new Command('hub').description('Hub-related operations');
  cmd
    .command('status <url>')
    .description('Query the health, identity, and contract addresses of a hub')
    .option('--json', 'Emit JSON output', false)
    .action(async (url: string, opts: { json: boolean }) => {
      const f = deps.fetch ?? fetch;
      const stdout = deps.stdout ?? process.stdout;
      const stderr = deps.stderr ?? process.stderr;
      const base = url.replace(/\/$/, '');

      const safeJson = async (path: string): Promise<unknown> => {
        try {
          const r = await f(`${base}${path}`);
          if (!r.ok) return { error: `HTTP ${r.status}` };
          return await r.json();
        } catch (e) {
          return { error: (e as Error).message };
        }
      };

      const [health, info, stats] = await Promise.all([
        safeJson('/v1/health'),
        safeJson('/v1/info'),
        safeJson('/v1/stats'),
      ]);

      if (opts.json) {
        emit({ hubUrl: base, health, info, stats }, stdout);
        return;
      }

      // Human render — pull common fields out.
      const i = info as Record<string, unknown>;
      const h = health as Record<string, unknown>;
      const s = stats as Record<string, unknown>;
      stdout.write(`hub:         ${base}\n`);
      if (typeof i.hubAddress === 'string') stdout.write(`hubAddress:  ${i.hubAddress}\n`);
      if (typeof i.chainId === 'number') stdout.write(`chainId:     ${i.chainId}\n`);
      const contracts = i.contracts as Record<string, string> | undefined;
      if (contracts) {
        if (contracts.PaymentChannel) stdout.write(`PaymentChannel: ${contracts.PaymentChannel}\n`);
        if (contracts.Adjudicator) stdout.write(`Adjudicator:    ${contracts.Adjudicator}\n`);
      }
      if (h.status) stdout.write(`health:      ${h.status}\n`);
      if (h.checks) stdout.write(`checks:      ${JSON.stringify(h.checks)}\n`);
      const channels = s.channels as Record<string, unknown> | undefined;
      if (channels) stdout.write(`channels:    ${JSON.stringify(channels)}\n`);
      if ((h as { error?: string }).error) {
        stderr.write(`warning: /v1/health returned ${(h as { error: string }).error}\n`);
      }
    });
  return cmd;
}
