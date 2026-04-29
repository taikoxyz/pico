import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const channelsTotal = new Gauge({
  name: 'tainnel_hub_channels_total',
  help: 'Number of channels currently tracked by the hub',
  registers: [registry],
});

export const paymentsTotal = new Counter({
  name: 'tainnel_hub_payments_total',
  help: 'Total payments observed (cumulative)',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const htlcsInFlight = new Gauge({
  name: 'tainnel_hub_htlcs_in_flight',
  help: 'Number of pending HTLCs across all channels',
  registers: [registry],
});

export const inboundLiquidity = new Gauge({
  name: 'tainnel_hub_inbound_liquidity_usdc',
  help: 'Aggregate inbound USDC liquidity (smallest unit)',
  registers: [registry],
});

export const outboundLiquidity = new Gauge({
  name: 'tainnel_hub_outbound_liquidity_usdc',
  help: 'Aggregate outbound USDC liquidity (smallest unit)',
  registers: [registry],
});

export const disputesTotal = new Counter({
  name: 'tainnel_hub_disputes_total',
  help: 'Total disputes observed by the hub (cumulative)',
  registers: [registry],
});
