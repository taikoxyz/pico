import {
  ANVIL_DEV_CHAIN_ID,
  CONTRACT_ADDRESSES,
  type ChainId,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
  ZERO_ADDRESS,
} from '@pico/protocol';
import type { HubConfig } from './config.js';

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
  readonly operatorToken: string | undefined;
  readonly explicitHubKey: boolean;
}

export function assertProductionConfig(cfg: HubConfig, opts: ProductionAssertOpts): void {
  const { env, operatorToken, explicitHubKey } = opts;
  const isAnvil = cfg.chainId === ANVIL_DEV_CHAIN_ID;
  const allowZero = env.PICO_DEV_ALLOW_ZERO_ADDRESS === 'true';

  if (!isAnvil && KNOWN_DEV_PRIVATE_KEYS.has(cfg.hubPrivateKey.toLowerCase())) {
    throw new Error(
      `HUB_PRIVATE_KEY is a well-known development key; refuse to start on chainId=${cfg.chainId}. Set HUB_PRIVATE_KEY to a real key (or use chainId=31337 for local dev).`,
    );
  }

  if (cfg.chainId === TAIKO_MAINNET_CHAIN_ID) {
    if (!explicitHubKey) {
      throw new Error('HUB_PRIVATE_KEY must be explicitly set in environment for mainnet startup.');
    }
    if (!cfg.requireSignedEnvelope) {
      throw new Error(
        'HUB_REQUIRE_SIGNED_ENVELOPE=true is required on mainnet (refusing to start with optional WS auth).',
      );
    }
    if (!operatorToken) {
      throw new Error(
        'HUB_OPERATOR_TOKEN is required on mainnet (refusing to expose unauthenticated operator endpoints).',
      );
    }
  }

  if (!allowZero) {
    if (cfg.paymentChannelAddress === ZERO_ADDRESS) {
      throw new Error(
        `paymentChannelAddress is the zero address for chainId=${cfg.chainId}. Set PAYMENT_CHANNEL_ADDRESS or set PICO_DEV_ALLOW_ZERO_ADDRESS=true for local dev only.`,
      );
    }
    if (cfg.adjudicatorAddress === ZERO_ADDRESS) {
      throw new Error(
        `adjudicatorAddress is the zero address for chainId=${cfg.chainId}. Set ADJUDICATOR_ADDRESS or set PICO_DEV_ALLOW_ZERO_ADDRESS=true for local dev only.`,
      );
    }
    const tokenInfo = USDC_TOKENS[cfg.chainId];
    if (tokenInfo && tokenInfo.address === ZERO_ADDRESS) {
      throw new Error(
        `default USDC token address is the zero address for chainId=${cfg.chainId}. Configure a real token address or set PICO_DEV_ALLOW_ZERO_ADDRESS=true.`,
      );
    }
  }

  // Cross-check derived addresses against the protocol map: any chain in
  // SUPPORTED_CHAIN_IDS must have a non-zero PaymentChannel/Adjudicator entry
  // unless the dev-allow flag is set.
  if (!allowZero) {
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
}
