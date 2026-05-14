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
  readonly hotWalletEthBalanceWei: Gauge<'address'>;
  readonly chainWatcherLagBlocks: Gauge<string>;
  readonly wsActiveConnections: Gauge<string>;
  readonly rpcErrorsTotal: Counter<'method'>;
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
    'pico_hub_hot_wallet_eth_balance_wei',
    'pico_hub_chain_watcher_lag_blocks',
    'pico_hub_ws_active_connections',
    'pico_hub_rpc_errors_total',
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
  const hotWalletEthBalanceWei = new Gauge({
    name: 'pico_hub_hot_wallet_eth_balance_wei',
    help: 'Hub hot-wallet ETH balance (wei). Sampled periodically.',
    labelNames: ['address'] as const,
    registers: [reg],
  });
  const chainWatcherLagBlocks = new Gauge({
    name: 'pico_hub_chain_watcher_lag_blocks',
    help: 'Blocks between chain head and the chain-watcher cursor',
    registers: [reg],
  });
  const wsActiveConnections = new Gauge({
    name: 'pico_hub_ws_active_connections',
    help: 'Currently open WebSocket client connections',
    registers: [reg],
  });
  const rpcErrorsTotal = new Counter({
    name: 'pico_hub_rpc_errors_total',
    help: 'Total errors raised while calling viem/RPC endpoints',
    labelNames: ['method'] as const,
    registers: [reg],
  });

  return {
    channelsTotal,
    htlcsInFlight,
    inboundLiquidityUsdc,
    outboundLiquidityUsdc,
    paymentsTotal,
    disputesTotal,
    hotWalletEthBalanceWei,
    chainWatcherLagBlocks,
    wsActiveConnections,
    rpcErrorsTotal,
    refreshGauges(snap) {
      channelsTotal.set(snap.channelsTotal);
      htlcsInFlight.set(snap.htlcsInFlight);
      inboundLiquidityUsdc.set(Number(snap.inboundLiquidity));
      outboundLiquidityUsdc.set(Number(snap.outboundLiquidity));
    },
  };
}
