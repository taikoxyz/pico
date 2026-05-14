import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const channelsWatched = new Gauge({
  name: 'pico_watchtower_channels_watched',
  help: 'Number of channels currently observed by this watchtower',
  registers: [registry],
});

export const penaltiesSubmittedTotal = new Counter({
  name: 'pico_watchtower_penalties_submitted_total',
  help: 'Total number of penalty proofs submitted on-chain',
  registers: [registry],
});

export const evaluationsTotal = new Counter({
  name: 'pico_watchtower_evaluations_total',
  help: 'Number of fraud evaluations performed',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const rpcUp = new Gauge({
  name: 'pico_watchtower_rpc_up',
  help: 'Whether the RPC connection is currently up (1) or down (0)',
  registers: [registry],
});

export const hotWalletEthBalanceWei = new Gauge({
  name: 'pico_watchtower_hot_wallet_eth_balance_wei',
  help: 'Watchtower hot-wallet ETH balance (wei). Sampled periodically.',
  labelNames: ['address'] as const,
  registers: [registry],
});

export const oldestPendingTxAgeMs = new Gauge({
  name: 'pico_watchtower_oldest_pending_tx_age_ms',
  help: 'Age (ms) of the oldest in-flight penalty tx; 0 when none pending',
  registers: [registry],
});

export const oldestClosingDeadlineRemainingMs = new Gauge({
  name: 'pico_watchtower_oldest_closing_deadline_remaining_ms',
  help: 'Min dispute deadline remaining (ms) across closing channels; 0 when none',
  registers: [registry],
});

export const pendingTxCount = new Gauge({
  name: 'pico_watchtower_pending_tx_count',
  help: 'Count of in-flight penalty txs currently tracked',
  registers: [registry],
});

export const submissionFailedTotal = new Counter({
  name: 'pico_watchtower_submission_failed_total',
  help: 'Penalty submission failures, labelled by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const rpcErrorsTotal = new Counter({
  name: 'pico_watchtower_rpc_errors_total',
  help: 'Total errors raised while calling viem/RPC endpoints',
  labelNames: ['method'] as const,
  registers: [registry],
});
