import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const channelsWatched = new Gauge({
  name: 'tainnel_watchtower_channels_watched',
  help: 'Number of channels currently observed by this watchtower',
  registers: [registry],
});

export const penaltiesSubmittedTotal = new Counter({
  name: 'tainnel_watchtower_penalties_submitted_total',
  help: 'Total number of penalty proofs submitted on-chain',
  registers: [registry],
});

export const evaluationsTotal = new Counter({
  name: 'tainnel_watchtower_evaluations_total',
  help: 'Number of fraud evaluations performed',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const rpcUp = new Gauge({
  name: 'tainnel_watchtower_rpc_up',
  help: 'Whether the RPC connection is currently up (1) or down (0)',
  registers: [registry],
});
