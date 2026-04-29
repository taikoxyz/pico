import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';

export interface AnvilForkOptions {
  readonly forkUrl?: string;
  readonly forkBlockNumber?: bigint;
  readonly chainId?: number;
  readonly port?: number;
  readonly mnemonic?: string;
  readonly accounts?: number;
  readonly balance?: bigint;
  readonly silent?: boolean;
}

export interface AnvilHandle {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  stop(): Promise<void>;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr !== null) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no port assigned')));
      }
    });
    srv.on('error', reject);
  });
}

export async function startAnvilFork(opts: AnvilForkOptions = {}): Promise<AnvilHandle> {
  const port = opts.port ?? (await pickFreePort());
  const args: string[] = ['--port', String(port), '--host', '127.0.0.1'];
  if (opts.forkUrl) args.push('--fork-url', opts.forkUrl);
  if (opts.forkBlockNumber !== undefined) {
    args.push('--fork-block-number', String(opts.forkBlockNumber));
  }
  if (opts.chainId !== undefined) args.push('--chain-id', String(opts.chainId));
  if (opts.mnemonic) args.push('--mnemonic', opts.mnemonic);
  if (opts.accounts !== undefined) args.push('--accounts', String(opts.accounts));
  if (opts.balance !== undefined) args.push('--balance', String(opts.balance));
  if (opts.silent) args.push('--silent');

  const child = spawn('anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const rpcUrl = `http://127.0.0.1:${port}`;
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    let exited = false;
    child.once('exit', (code) => {
      exited = true;
      reject(new Error(`anvil exited early (code=${code}); output: ${buffer.slice(-500)}`));
    });

    const probe = async (): Promise<void> => {
      while (!exited) {
        if (Date.now() > deadline) {
          reject(new Error(`anvil startup timeout; output: ${buffer.slice(-500)}`));
          return;
        }
        try {
          const r = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          });
          if (r.ok) {
            resolve();
            return;
          }
        } catch {
          // not listening yet
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    void probe();
  });

  return {
    rpcUrl,
    chainId: opts.chainId ?? 31337,
    process: child,
    async stop(): Promise<void> {
      if (child.exitCode !== null) return;
      child.kill('SIGINT');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 1000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}
