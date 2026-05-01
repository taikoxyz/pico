import {
  ANVIL_DEV_CHAIN_ID,
  CONTRACT_ADDRESSES,
  TAIKO_MAINNET_CHAIN_ID,
  ZERO_ADDRESS,
} from '@tainnel/protocol';
import type { WatchtowerConfig } from './config.js';

export const KNOWN_DEV_PRIVATE_KEYS: ReadonlySet<string> = new Set([
  '0x0000000000000000000000000000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000000000000000000000000000002',
  '0x0000000000000000000000000000000000000000000000000000000000000003',
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
]);

export interface ProductionAssertOpts {
  readonly env: NodeJS.ProcessEnv;
  readonly explicitPrivateKey: boolean;
}

export function assertProductionConfig(cfg: WatchtowerConfig, opts: ProductionAssertOpts): void {
  const { env, explicitPrivateKey } = opts;
  const isAnvil = cfg.chainId === ANVIL_DEV_CHAIN_ID;
  const allowZero = env.TAINNEL_DEV_ALLOW_ZERO_ADDRESS === 'true';

  if (!isAnvil && KNOWN_DEV_PRIVATE_KEYS.has(cfg.privateKey.toLowerCase())) {
    throw new Error(
      `WATCHTOWER_PRIVATE_KEY is a well-known development key; refuse to start on chainId=${cfg.chainId}. Set WATCHTOWER_PRIVATE_KEY to a real key (or use chainId=31337 for local dev).`,
    );
  }

  if (cfg.chainId === TAIKO_MAINNET_CHAIN_ID && !explicitPrivateKey) {
    throw new Error(
      'WATCHTOWER_PRIVATE_KEY must be explicitly set in environment for mainnet startup.',
    );
  }

  if (cfg.mode === 'service') {
    throw new Error('MODE=service is not implemented in v1. Set MODE=self-hosted (the default).');
  }

  if (!allowZero) {
    if (cfg.paymentChannelAddress === ZERO_ADDRESS) {
      throw new Error(
        `paymentChannelAddress is the zero address for chainId=${cfg.chainId}. Set PAYMENT_CHANNEL_ADDRESS or set TAINNEL_DEV_ALLOW_ZERO_ADDRESS=true for local dev only.`,
      );
    }
    const protocolEntry = CONTRACT_ADDRESSES[cfg.chainId];
    if (
      protocolEntry &&
      (protocolEntry.PaymentChannel === ZERO_ADDRESS ||
        protocolEntry.Adjudicator === ZERO_ADDRESS) &&
      cfg.chainId !== ANVIL_DEV_CHAIN_ID
    ) {
      throw new Error(
        `protocol CONTRACT_ADDRESSES for chainId=${cfg.chainId} contains zero placeholders; this chain is not yet deployed and is unsafe for production startup.`,
      );
    }
  }

  if (cfg.penaltyThreshold < 0 || cfg.penaltyThreshold > 1) {
    throw new Error(`PENALTY_THRESHOLD must be in [0, 1], got ${cfg.penaltyThreshold}`);
  }
  if (!Number.isFinite(cfg.schedulerIntervalMs) || cfg.schedulerIntervalMs <= 0) {
    throw new Error('SCHEDULER_INTERVAL_MS must be a positive number');
  }
  if (!Number.isFinite(cfg.confirmations) || cfg.confirmations < 0) {
    throw new Error('CONFIRMATIONS must be a non-negative number');
  }
  if (!Number.isFinite(cfg.rpcReconnectMaxBackoffMs) || cfg.rpcReconnectMaxBackoffMs <= 0) {
    throw new Error('RPC_RECONNECT_MAX_BACKOFF_MS must be a positive number');
  }
}
