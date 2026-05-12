import type { Hex } from '@inferenceroom/pico-protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from './logger.js';
import { registry } from './metrics.js';

export interface HealthSnapshot {
  readonly rpc: { readonly up: boolean; readonly lastEventBlockNumber: bigint | null };
  readonly db: { readonly up: boolean };
  readonly channelsWatched: number;
}

/** H6: callback invoked by the `POST /v1/preimage` endpoint. */
export type PreimageSink = (paymentHash: Hex, preimage: Hex) => void;

export interface BuildHttpDeps {
  readonly logger: Logger;
  readonly healthProbe: () => HealthSnapshot;
  /**
   * H6: shared-secret bearer token gating the `POST /v1/preimage` endpoint.
   * Hubs and clients that share preimages with this watchtower MUST present
   * this token in the `Authorization: Bearer <token>` header. Omitted →
   * the preimage endpoint is not registered at all.
   */
  readonly preimageAuthToken?: string;
  /** H6: handler that persists a learned preimage into the resolver's cache. */
  readonly onPreimage?: PreimageSink;
}

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

export async function buildHttpServer(deps: BuildHttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get('/health', async (_req, reply) => {
    const snap = deps.healthProbe();
    const ok = snap.rpc.up && snap.db.up;
    void reply.code(ok ? 200 : 503);
    return {
      rpc: {
        up: snap.rpc.up,
        lastEventBlockNumber:
          snap.rpc.lastEventBlockNumber === null ? null : snap.rpc.lastEventBlockNumber.toString(),
      },
      db: { up: snap.db.up },
      channelsWatched: snap.channelsWatched,
    };
  });
  app.get('/metrics', async (_req, reply) => {
    void reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  if (deps.preimageAuthToken && deps.onPreimage) {
    const expectedAuth = `Bearer ${deps.preimageAuthToken}`;
    const sink = deps.onPreimage;
    app.post('/v1/preimage', async (req, reply) => {
      if (req.headers.authorization !== expectedAuth) {
        void reply.code(401);
        return { error: 'unauthorized' };
      }
      const body = req.body as { paymentHash?: unknown; preimage?: unknown } | undefined;
      const paymentHash = body?.paymentHash;
      const preimage = body?.preimage;
      if (typeof paymentHash !== 'string' || !HEX32_RE.test(paymentHash)) {
        void reply.code(400);
        return { error: 'paymentHash must be 0x-prefixed 32-byte hex' };
      }
      if (typeof preimage !== 'string' || !HEX_RE.test(preimage)) {
        void reply.code(400);
        return { error: 'preimage must be 0x-prefixed hex' };
      }
      sink(paymentHash as Hex, preimage as Hex);
      void reply.code(204);
      return null;
    });
  }

  return app;
}
