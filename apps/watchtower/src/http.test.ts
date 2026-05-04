import { describe, expect, it } from 'vitest';
import { type HealthSnapshot, buildHttpServer } from './http.js';
import { logger } from './logger.js';

function healthy(): HealthSnapshot {
  return {
    rpc: { up: true, lastEventBlockNumber: 12345n },
    db: { up: true },
    channelsWatched: 3,
  };
}

function unhealthy(): HealthSnapshot {
  return {
    rpc: { up: false, lastEventBlockNumber: null },
    db: { up: true },
    channelsWatched: 0,
  };
}

describe('buildHttpServer', () => {
  it('returns 200 with bigint serialized as string when healthy', async () => {
    const app = await buildHttpServer({ logger, healthProbe: healthy });
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        rpc: { up: boolean; lastEventBlockNumber: string | null };
        db: { up: boolean };
        channelsWatched: number;
      };
      expect(body.rpc.up).toBe(true);
      expect(body.rpc.lastEventBlockNumber).toBe('12345');
      expect(body.db.up).toBe(true);
      expect(body.channelsWatched).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when rpc is down', async () => {
    const app = await buildHttpServer({ logger, healthProbe: unhealthy });
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as {
        rpc: { up: boolean; lastEventBlockNumber: string | null };
      };
      expect(body.rpc.up).toBe(false);
      expect(body.rpc.lastEventBlockNumber).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('exposes prom-client metrics at /metrics', async () => {
    const app = await buildHttpServer({ logger, healthProbe: healthy });
    try {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      const contentType = res.headers['content-type'];
      expect(typeof contentType).toBe('string');
      expect(String(contentType).startsWith('text/plain')).toBe(true);
      expect(res.body).toContain('pico_watchtower_channels_watched');
    } finally {
      await app.close();
    }
  });
});
