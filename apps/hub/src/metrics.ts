import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export interface HubMetrics {
  readonly channelsTotal: Gauge<string>;
  readonly htlcsInFlight: Gauge<string>;
  readonly inboundLiquidityUsdc: Gauge<string>;
  readonly outboundLiquidityUsdc: Gauge<string>;
  readonly paymentsTotal: Counter<string>;
  readonly disputesTotal: Counter<string>;
  refreshGauges(snapshot: GaugeSnapshot): void;
}

export interface GaugeSnapshot {
  readonly channelsTotal: number;
  readonly htlcsInFlight: number;
  readonly inboundLiquidity: bigint;
  readonly outboundLiquidity: bigint;
}

export function buildMetrics(reg: Registry): HubMetrics {
  for (const name of [
    'pico_hub_channels_total',
    'pico_hub_htlcs_in_flight',
    'pico_hub_inbound_liquidity_usdc',
    'pico_hub_outbound_liquidity_usdc',
    'pico_hub_payments_total',
    'pico_hub_disputes_total',
  ]) {
    reg.removeSingleMetric(name);
  }

  const channelsTotal = new Gauge({
    name: 'pico_hub_channels_total',
    help: 'Open channels held by the hub',
    registers: [reg],
  });
  const htlcsInFlight = new Gauge({
    name: 'pico_hub_htlcs_in_flight',
    help: 'In-flight HTLCs being routed by the hub',
    registers: [reg],
  });
  const inboundLiquidityUsdc = new Gauge({
    name: 'pico_hub_inbound_liquidity_usdc',
    help: 'Sum of inbound liquidity across all channels (smallest USDC unit)',
    registers: [reg],
  });
  const outboundLiquidityUsdc = new Gauge({
    name: 'pico_hub_outbound_liquidity_usdc',
    help: 'Sum of outbound liquidity across all channels (smallest USDC unit)',
    registers: [reg],
  });
  const paymentsTotal = new Counter({
    name: 'pico_hub_payments_total',
    help: 'Total payments processed by the hub',
    labelNames: ['result'],
    registers: [reg],
  });
  const disputesTotal = new Counter({
    name: 'pico_hub_disputes_total',
    help: 'Total disputes observed by the hub',
    labelNames: ['outcome'],
    registers: [reg],
  });

  return {
    channelsTotal,
    htlcsInFlight,
    inboundLiquidityUsdc,
    outboundLiquidityUsdc,
    paymentsTotal,
    disputesTotal,
    refreshGauges(snap) {
      channelsTotal.set(snap.channelsTotal);
      htlcsInFlight.set(snap.htlcsInFlight);
      inboundLiquidityUsdc.set(Number(snap.inboundLiquidity));
      outboundLiquidityUsdc.set(Number(snap.outboundLiquidity));
    },
  };
}
