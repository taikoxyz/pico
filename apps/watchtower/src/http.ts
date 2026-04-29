import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from './logger.js';
import type { WatchtowerMetrics } from './metrics.js';

export interface HealthSnapshot {
  readonly rpcUp: boolean;
  readonly dbReady: boolean;
  readonly lastEventBlock: number;
  readonly channelsWatched: number;
}

export type HealthProbe = () => HealthSnapshot;

export interface WatchtowerHttpServerDeps {
  readonly port: number;
  readonly probe: HealthProbe;
  readonly metrics: WatchtowerMetrics;
  readonly logger: Logger;
}

export class WatchtowerHttpServer {
  private server: Server | undefined;

  constructor(private readonly deps: WatchtowerHttpServerDeps) {}

  start(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', reject);
      server.listen(this.deps.port, () => {
        this.server = server;
        const addr = server.address();
        const port = addr && typeof addr === 'object' ? addr.port : this.deps.port;
        resolve({ port });
      });
    });
  }

  stop(): Promise<void> {
    if (!this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/health') {
      const snap = this.deps.probe();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: snap.rpcUp && snap.dbReady ? 'ok' : 'degraded',
          ...snap,
        }),
      );
      return;
    }
    if (req.method === 'GET' && url === '/metrics') {
      const snap = this.deps.probe();
      this.deps.metrics.set('rpcUp', snap.rpcUp ? 1 : 0);
      this.deps.metrics.set('channelsWatched', snap.channelsWatched);
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(this.deps.metrics.exposition());
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }
}
