import { describe, expect, it } from 'vitest';
import { WatchtowerHttpServer } from './http.js';
import { logger } from './logger.js';
import { WatchtowerMetrics } from './metrics.js';

describe('WatchtowerHttpServer', () => {
  it('serves /health and /metrics', async () => {
    const metrics = new WatchtowerMetrics();
    metrics.inc('penaltiesSubmittedTotal', 4);
    metrics.inc('evaluationsTotal', 7);
    const server = new WatchtowerHttpServer({
      port: 0,
      logger,
      metrics,
      probe: () => ({
        rpcUp: true,
        dbReady: true,
        lastEventBlock: 12345,
        channelsWatched: 3,
      }),
    });
    const { port } = await server.start();
    try {
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as Record<string, unknown>;
      expect(health.status).toBe('ok');
      expect(health.lastEventBlock).toBe(12345);
      expect(health.channelsWatched).toBe(3);

      const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(metricsRes.status).toBe(200);
      const text = await metricsRes.text();
      expect(text).toContain('tainnel_watchtower_penalties_submitted_total 4');
      expect(text).toContain('tainnel_watchtower_evaluations_total 7');
      expect(text).toContain('tainnel_watchtower_rpc_up 1');
      expect(text).toContain('tainnel_watchtower_channels_watched 3');

      const notFoundRes = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(notFoundRes.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
