/**
 * R-06: Per-token HTLC cap is read from env and surfaced on /v1/info.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Channel,
  ChannelState,
  Hex,
  HtlcId,
  PaymentHash,
  Signature,
  SignedState,
} from '@inferenceroom/pico-protocol';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelPool } from './channel-pool.js';
import { loadConfig } from './config.js';
import { type TestDb, makeTestDb } from './db/repos/_test-helpers.js';
import { FlatPlusBpsFeePolicy } from './fee-policy.js';
import { logger } from './logger.js';
import { Router } from './router.js';
import { type BuildServerResult, buildServer } from './server.js';

const HUB_PK = '0x00000000000000000000000000000000000000000000000000000000000000bb' as const;
const VERIFYING_CONTRACT = '0x0000000000000000000000000000000000000001' as const;
const ZERO_SIG: Signature = { r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}`, v: 27 };

// A token address we'll override via env.
const CUSTOM_TOKEN = '0x0000000000000000000000000000000000000099';
// Small cap so hub liquidity (1000 units) is not the bottleneck.
const CUSTOM_CAP = 500n;

function bytes32(prefix: string, idx: number): Hex {
  return `0x${prefix}${String(idx).padStart(64 - prefix.length, '0')}` as Hex;
}

function makeChannel(id: Hex, userA: `0x${string}`, userB: `0x${string}`): Channel {
  return {
    id,
    chainId: 31337,
    contract: VERIFYING_CONTRACT,
    userA,
    userB,
    token: CUSTOM_TOKEN,
    status: 'open',
    openedAt: 0n,
    disputeWindowMs: 86_400_000,
  };
}

function signed(channel: Channel, balanceA: bigint, balanceB: bigint, version = 1n): SignedState {
  const state: ChannelState = {
    channelId: channel.id,
    version,
    balanceA,
    balanceB,
    htlcs: [],
    htlcsCount: 0,
    htlcsTotalLocked: 0n,
    finalized: false,
  };
  return { state, sigA: ZERO_SIG, sigB: ZERO_SIG };
}

describe('R-06: per-token per-counterparty cap config', () => {
  describe('loadConfig parses PICO_HUB_PER_COUNTERPARTY_CAP_* env vars', () => {
    it('applies env override for a token', () => {
      const cfg = loadConfig({
        CHAIN_ID: '31337',
        HUB_PRIVATE_KEY: HUB_PK,
        PICO_SKIP_PROD_ASSERT: 'true',
        [`PICO_HUB_PER_COUNTERPARTY_CAP_${CUSTOM_TOKEN}`]: CUSTOM_CAP.toString(),
      } as NodeJS.ProcessEnv);
      expect(cfg.perCounterpartyCaps.get(CUSTOM_TOKEN.toLowerCase())).toBe(CUSTOM_CAP);
    });

    it('falls back to DEFAULT_CAPS for ETH when no override given', () => {
      const cfg = loadConfig({
        CHAIN_ID: '31337',
        HUB_PRIVATE_KEY: HUB_PK,
        PICO_SKIP_PROD_ASSERT: 'true',
      } as NodeJS.ProcessEnv);
      // ETH (zero address) default is 1 ETH
      expect(cfg.perCounterpartyCaps.get('0x0000000000000000000000000000000000000000')).toBe(
        1_000_000_000_000_000_000n,
      );
    });
  });

  describe('Router enforces env-configured cap', () => {
    let h: TestDb;
    let pool: ChannelPool;
    const hubAccount = privateKeyToAccount(HUB_PK);
    const alice = '0x00000000000000000000000000000000000000A1' as const;
    const bob = '0x00000000000000000000000000000000000000B0' as const;
    const aliceHubChannel = makeChannel(bytes32('aa', 1), alice, hubAccount.address);
    const hubBobChannel = makeChannel(bytes32('bb', 1), hubAccount.address, bob);

    beforeEach(async () => {
      h = await makeTestDb();
      pool = new ChannelPool({
        logger,
        channelRepo: h.repos.channels,
        stateRepo: h.repos.states,
      });
      // Hub has 1000 units balance on outgoing side; per-channel cap = min(1000, 1000) = 1000.
      // CUSTOM_CAP (500) < per-channel cap (1000), so the counterparty cap check fires first.
      await pool.register(aliceHubChannel, signed(aliceHubChannel, 1_000n, 0n), {
        amountA: 1_000n,
        amountB: 1_000n,
      });
      await pool.register(hubBobChannel, signed(hubBobChannel, 1_000n, 0n), {
        amountA: 1_000n,
        amountB: 1_000n,
      });
    });
    afterEach(async () => h.cleanup());

    it('rejects a payment that exceeds the per-counterparty cap', async () => {
      const caps = new Map([[CUSTOM_TOKEN.toLowerCase(), CUSTOM_CAP]]);
      const router = new Router({
        channelPool: pool,
        feePolicy: new FlatPlusBpsFeePolicy(0n, 0n),
        hubAccount,
        chainId: 31337,
        verifyingContract: VERIFYING_CONTRACT,
        logger,
        perCounterpartyCaps: caps,
      });

      const incomingHtlc = {
        id: bytes32('cc', 1) as HtlcId,
        direction: 'AtoB' as const,
        amount: CUSTOM_CAP + 1n, // one unit over the cap
        paymentHash: bytes32('dd', 1) as PaymentHash,
        expiryMs: BigInt(Date.now() + 2 * 60 * 60 * 1000),
      };

      await expect(
        router.route({
          incomingChannel: aliceHubChannel,
          incomingSignedState: signed(aliceHubChannel, 1_000n, 0n),
          incomingHtlc,
          recipient: bob,
          amount: CUSTOM_CAP + 1n,
          paymentHash: incomingHtlc.paymentHash,
        }),
      ).rejects.toThrow(/counterparty/i);
    });

    it('accepts a payment at exactly the per-counterparty cap', async () => {
      const caps = new Map([[CUSTOM_TOKEN.toLowerCase(), CUSTOM_CAP]]);
      const router = new Router({
        channelPool: pool,
        feePolicy: new FlatPlusBpsFeePolicy(0n, 0n),
        hubAccount,
        chainId: 31337,
        verifyingContract: VERIFYING_CONTRACT,
        logger,
        perCounterpartyCaps: caps,
      });

      const incomingHtlc = {
        id: bytes32('ee', 1) as HtlcId,
        direction: 'AtoB' as const,
        amount: CUSTOM_CAP,
        paymentHash: bytes32('ff', 1) as PaymentHash,
        expiryMs: BigInt(Date.now() + 2 * 60 * 60 * 1000),
      };

      const result = await router.route({
        incomingChannel: aliceHubChannel,
        incomingSignedState: signed(aliceHubChannel, 1_000n, 0n),
        incomingHtlc,
        recipient: bob,
        amount: CUSTOM_CAP,
        paymentHash: incomingHtlc.paymentHash,
      });
      expect(result.outgoingHtlc.amount).toBe(CUSTOM_CAP);
    });
  });

  describe('/v1/info exposes perCounterpartyCaps', () => {
    let tmp: string;
    let built: BuildServerResult;
    let baseUrl: string;

    beforeEach(async () => {
      tmp = mkdtempSync(join(tmpdir(), 'hub-cap-'));
      built = await buildServer({
        DB_DRIVER: 'sqlite',
        DB_URL: join(tmp, 'test.sqlite'),
        HUB_PRIVATE_KEY: HUB_PK,
        RPC_URL: 'http://127.0.0.1:1',
        CHAIN_ID: '31337',
        PAYMENT_CHANNEL_ADDRESS: VERIFYING_CONTRACT,
        ADJUDICATOR_ADDRESS: VERIFYING_CONTRACT,
        HUB_FEE_BPS: '0',
        HUB_FEE_FLAT: '0',
        LOG_LEVEL: 'silent',
        CHAIN_POLLING_INTERVAL_MS: '999999',
        PICO_DEV_ALLOW_ZERO_ADDRESS: 'true',
        PICO_SKIP_PROD_ASSERT: 'true',
        PROMETHEUS_PORT: '0',
        [`PICO_HUB_PER_COUNTERPARTY_CAP_${CUSTOM_TOKEN}`]: CUSTOM_CAP.toString(),
      } as NodeJS.ProcessEnv);
      baseUrl = await built.app.listen({ port: 0, host: '127.0.0.1' });
    });

    afterEach(async () => {
      await built.app.close();
      rmSync(tmp, { recursive: true, force: true });
    });

    it('GET /v1/info includes perCounterpartyCaps with env override', async () => {
      const r = await fetch(`${baseUrl}/v1/info`);
      const json = (await r.json()) as {
        perCounterpartyCaps: Record<string, string>;
      };
      expect(r.status).toBe(200);
      expect(json.perCounterpartyCaps).toBeDefined();
      expect(json.perCounterpartyCaps[CUSTOM_TOKEN.toLowerCase()]).toBe(CUSTOM_CAP.toString());
    });
  });
});
