import type { Address, ChainId, Channel, SignedState } from '@inferenceroom/pico-protocol';
import type { FastifyInstance } from 'fastify';
import { http, createPublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChannelPool } from '../channel-pool.js';
import type { Database } from '../db/index.js';
import type { Repos } from '../db/repos/index.js';
import type { LiquidityTracker } from '../liquidity.js';
import type { Logger } from '../logger.js';
import type { HubMetrics } from '../metrics.js';
import { type WsHandle, registerWsRoutes } from './ws.js';

export interface ApiDeps {
  readonly channelPool: ChannelPool;
  readonly liquidity: LiquidityTracker;
  readonly repos: Repos;
  readonly metrics: HubMetrics;
  readonly logger: Logger;
  readonly db: Database;
  readonly rpcUrl: string;
  readonly hubPrivateKey: `0x${string}`;
  readonly chainId: ChainId;
  readonly paymentChannelAddress: Address;
  readonly verifyingContract: Address;
  readonly hubFeeBps: bigint;
  readonly hubFeeFlat: bigint;
  readonly requireSignedEnvelope: boolean;
  readonly nonceWindowMs: number;
  readonly paymentRetentionPerChannel: number;
  readonly operatorToken: string | undefined;
}

export interface ApiHandle {
  readonly ws: WsHandle;
}

interface RawSignature {
  readonly r: `0x${string}`;
  readonly s: `0x${string}`;
  readonly v: number;
}

interface RawSignedState {
  readonly state: {
    readonly channelId: `0x${string}`;
    readonly version: string;
    readonly balanceA: string;
    readonly balanceB: string;
    readonly htlcs: ReadonlyArray<{
      id: `0x${string}`;
      direction: 'AtoB' | 'BtoA';
      amount: string;
      paymentHash: `0x${string}`;
      expiryMs: string;
    }>;
    readonly finalized: boolean;
  };
  readonly sigA: RawSignature;
  readonly sigB: RawSignature;
}

function reviveSignedState(raw: RawSignedState): SignedState {
  const htlcs = raw.state.htlcs.map((h) => ({
    id: h.id,
    direction: h.direction,
    amount: BigInt(h.amount),
    paymentHash: h.paymentHash,
    expiryMs: BigInt(h.expiryMs),
  }));
  let htlcsTotalLocked = 0n;
  for (const h of htlcs) htlcsTotalLocked += h.amount;
  return {
    state: {
      channelId: raw.state.channelId,
      version: BigInt(raw.state.version),
      balanceA: BigInt(raw.state.balanceA),
      balanceB: BigInt(raw.state.balanceB),
      htlcs,
      htlcsCount: htlcs.length,
      htlcsTotalLocked,
      finalized: raw.state.finalized,
    },
    sigA: raw.sigA,
    sigB: raw.sigB,
  };
}

export async function registerRoutes(app: FastifyInstance, deps: ApiDeps): Promise<ApiHandle> {
  const { operatorToken } = deps;
  const publicClient = createPublicClient({ transport: http(deps.rpcUrl) });
  const hubAddress = privateKeyToAccount(deps.hubPrivateKey).address;

  function isOperator(authHeader: string | undefined): boolean {
    if (!operatorToken) return true;
    return authHeader === `Bearer ${operatorToken}`;
  }

  app.get('/v1/health', async (_req, reply) => {
    const checks: Record<string, 'ok' | string> = {};
    let healthy = true;
    try {
      await deps.db.driver.ping();
      checks.db = 'ok';
    } catch (err) {
      checks.db = (err as Error).message;
      healthy = false;
    }
    try {
      await publicClient.getBlockNumber();
      checks.chain = 'ok';
    } catch (err) {
      checks.chain = (err as Error).message;
      healthy = false;
    }
    void reply.code(healthy ? 200 : 503);
    return {
      status: healthy ? 'ok' : 'degraded',
      version: process.env.npm_package_version ?? '0.0.0',
      checks,
      channels: deps.channelPool.list().length,
    };
  });

  app.get('/v1/channels', async (req, reply) => {
    if (!isOperator(req.headers.authorization)) {
      void reply.code(401);
      return { error: 'unauthorized' };
    }
    const list = deps.channelPool.list();
    return {
      channels: list.map((c) => ({
        id: c.id,
        userA: c.userA,
        userB: c.userB,
        token: c.token,
        status: c.status,
        chainId: c.chainId,
      })),
    };
  });

  app.post<{ Body: { channel: Channel; initialState?: RawSignedState } }>(
    '/v1/channels/open',
    async (req, reply) => {
      if (!isOperator(req.headers.authorization)) {
        void reply.code(401);
        return { error: 'unauthorized' };
      }
      const body = req.body;
      if (!body || !body.channel) {
        void reply.code(400);
        return { error: 'missing channel' };
      }
      const channel: Channel = {
        ...body.channel,
        openedAt: BigInt(body.channel.openedAt as unknown as string),
      };
      const state = body.initialState ? reviveSignedState(body.initialState) : undefined;
      await deps.channelPool.register(channel, state);
      return { channelId: channel.id, status: channel.status };
    },
  );

  app.post<{ Body: unknown }>('/v1/payments', async (_req, reply) => {
    void reply.code(501);
    return {
      error: 'one-shot REST payment not implemented in v1; use the WebSocket /ws endpoint',
    };
  });

  // Public hub identity. Clients use this to learn the hub's signing
  // address (which appears as one party on every channel) and the on-chain
  // contract addresses they should validate against before opening a
  // channel. Static for the lifetime of the process.
  app.get('/v1/info', async () => {
    return {
      version: 1,
      hubAddress,
      chainId: deps.chainId,
      contracts: {
        paymentChannel: deps.paymentChannelAddress,
        adjudicator: deps.verifyingContract,
      },
      requireSignedEnvelope: deps.requireSignedEnvelope,
      nonceWindowMs: deps.nonceWindowMs,
    };
  });

  // Public fee policy endpoint. Clients fetch this before sending pay
  // messages so they can gross-up amounts and reject hub fee changes that
  // exceed their max-fee cap. Returning base-unit strings to avoid
  // JS Number precision loss.
  app.get('/v1/fee-policy', async () => {
    return {
      version: 1,
      hubFeeBps: deps.hubFeeBps.toString(),
      hubFeeFlat: deps.hubFeeFlat.toString(),
      // Hint to clients: total fee = ceil(amount * bps / 10000) + flat
      formula: 'ceil(amount * hubFeeBps / 10000) + hubFeeFlat',
    };
  });

  // Aggregate hub statistics. Counters survive restarts because they are
  // backed by the `hub_stats` table; channel/dispute counts come from their
  // own tables (rows are not pruned). Payment counts and USDC sums are
  // returned as decimal strings to avoid JS Number precision loss for very
  // long-lived hubs.
  app.get('/v1/stats', async () => {
    const [byStatus, lifetime, htlcsInFlight, disputeRows] = await Promise.all([
      deps.repos.channels.countByStatus(),
      deps.repos.stats.getAll(),
      deps.repos.htlcs.countInflight(),
      deps.db.driver.query<{ n: number }>('SELECT COUNT(*) as n FROM disputes'),
    ]);
    const channelsTotal = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const paymentsTotal = lifetime.payments_settled + lifetime.payments_failed;
    return {
      version: 1,
      channels: {
        total: channelsTotal,
        open: byStatus.open,
        byStatus,
      },
      payments: {
        total: paymentsTotal.toString(),
        settled: lifetime.payments_settled.toString(),
        failed: lifetime.payments_failed.toString(),
        inFlightHtlcs: htlcsInFlight,
      },
      usdc: {
        settled: lifetime.usdc_settled.toString(),
        feesCollected: lifetime.fees_collected.toString(),
      },
      disputes: {
        total: Number(disputeRows[0]?.n ?? 0),
      },
    };
  });

  const ws = await registerWsRoutes(app, {
    channelPool: deps.channelPool,
    liquidity: deps.liquidity,
    repos: deps.repos,
    db: deps.db,
    metrics: deps.metrics,
    logger: deps.logger,
    hubPrivateKey: deps.hubPrivateKey,
    chainId: deps.chainId,
    verifyingContract: deps.verifyingContract,
    hubFeeBps: deps.hubFeeBps,
    hubFeeFlat: deps.hubFeeFlat,
    requireSignedEnvelope: deps.requireSignedEnvelope,
    nonceWindowMs: deps.nonceWindowMs,
    paymentRetentionPerChannel: deps.paymentRetentionPerChannel,
  });

  return { ws };
}
