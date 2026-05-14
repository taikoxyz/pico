import type { Address, ChainId, ChannelId, Hex, Signature } from '@inferenceroom/pico-protocol';
import {
  encodeChannelStateForOnChain,
  paymentChannelAbi,
  signatureToHex,
} from '@inferenceroom/pico-sdk';
import {
  http,
  type Hash,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, taiko } from 'viem/chains';
import type { ChannelPool } from './channel-pool.js';
import type { Repos } from './db/repos/index.js';
import type { Logger } from './logger.js';

export interface DisputeNotification {
  readonly channelId: ChannelId;
  readonly attackerVersion: bigint;
  readonly observedAtMs: number;
}

export interface DisputeHandlerDeps {
  readonly logger: Logger;
  readonly repos: Repos;
  readonly channelPool: ChannelPool;
  readonly rpcUrl: string;
  readonly chainId: ChainId;
  readonly paymentChannelAddress: Address;
  readonly hubPrivateKey: Hex;
  readonly publicClient?: PublicClient;
  readonly walletClient?: WalletClient;
  readonly maxAttemptsPerCall?: number;
  readonly retryBackoffMs?: number;
  readonly nowMs?: () => number;
}

const channelsReadAbi = parseAbi([
  'function channels(bytes32) view returns (address userA, address userB, address token, uint256 amountA, uint256 amountB, uint64 openedAt, uint64 disputeDeadline, uint64 postedVersion, uint256 postedBalanceA, uint256 postedBalanceB, bool penalized, uint8 status, address closer, bytes32 postedHtlcsRoot, uint256 htlcsTotalLocked, uint16 htlcsCount, uint64 htlcResolutionDeadline, uint256 pendingPayoutA, uint256 pendingPayoutB)',
]);

interface ChannelOnChain {
  readonly closer: Address;
  readonly disputeDeadlineMs: number;
}

/**
 * A "sentinel" signature has both `r` and `s` set to all-zero bytes. It
 * marks a state that the hub fabricated (bootstrap of an on-chain-only
 * channel, or a `prev` state seed for §8 propose envelopes) without a
 * counterparty's real ECDSA signature. The on-chain `dispute` function
 * recovers the signer and reverts with `bad sig` on these, so the hub
 * must refuse to submit them.
 */
function isSentinelSig(sig: Signature): boolean {
  const rDigits = sig.r.startsWith('0x') ? sig.r.slice(2) : sig.r;
  const sDigits = sig.s.startsWith('0x') ? sig.s.slice(2) : sig.s;
  return /^0+$/.test(rDigits) && /^0+$/.test(sDigits);
}

function viemChainFor(chainId: ChainId) {
  if (chainId === 167000) return taiko;
  return foundry;
}

export class DisputeHandler {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: DisputeHandlerDeps) {
    const chain = viemChainFor(deps.chainId);
    this.publicClient =
      deps.publicClient ??
      (createPublicClient({ chain, transport: http(deps.rpcUrl) }) as unknown as PublicClient);
    this.walletClient =
      deps.walletClient ??
      createWalletClient({
        account: privateKeyToAccount(deps.hubPrivateKey),
        chain,
        transport: http(deps.rpcUrl),
      });
    this.maxAttempts = deps.maxAttemptsPerCall ?? 3;
    this.backoffMs = deps.retryBackoffMs ?? 1_000;
    this.now = deps.nowMs ?? (() => Date.now());
  }

  async handle(notification: DisputeNotification): Promise<void> {
    const { channelId, attackerVersion, observedAtMs } = notification;
    await this.deps.repos.disputes.record(channelId, attackerVersion, observedAtMs);
    await this.attemptDispute(channelId, attackerVersion);
  }

  async retryPending(): Promise<void> {
    const pending = await this.deps.repos.disputes.listUnresponded();
    for (const d of pending) {
      await this.attemptDispute(d.channelId, d.observedVersion);
    }
  }

  private async attemptDispute(channelId: ChannelId, attackerVersion: bigint): Promise<void> {
    const ourLatest = await this.deps.repos.states.latestDisputeEligible(channelId);
    if (!ourLatest) {
      this.deps.logger.warn(
        { channelId, attackerVersion },
        'dispute notification: no dispute-eligible state in DB (conservation invariant required); cannot dispute',
      );
      await this.deps.repos.disputes.markResolution(channelId, attackerVersion, 'lost');
      return;
    }

    if (ourLatest.state.version <= attackerVersion) {
      this.deps.logger.error(
        {
          channelId,
          ourVersion: ourLatest.state.version.toString(),
          attackerVersion: attackerVersion.toString(),
        },
        'our state is not newer than the posted version; this is bad — possible compromised key or stale local DB',
      );
      await this.deps.repos.disputes.markResolution(channelId, attackerVersion, 'lost');
      return;
    }

    // Round-4 smoke (issue #100 follow-up): the chain-watcher bootstrap seeds
    // a v0 sentinel-signed state into the channel pool so the router has
    // something to apply HTLC updates onto. But the sentinel signatures are
    // not real userA/userB signatures, so submitting them to the on-chain
    // `dispute(...)` function reverts with `bad sig`. Without this guard the
    // hub busy-loops dispute retries for every observed unilateral close of
    // a freshly-bootstrapped channel.
    if (isSentinelSig(ourLatest.sigA) || isSentinelSig(ourLatest.sigB)) {
      this.deps.logger.warn(
        { channelId, attackerVersion: attackerVersion.toString() },
        'dispute: latest known state has sentinel signatures (bootstrap-only); cannot dispute — marking lost',
      );
      await this.deps.repos.disputes.markResolution(channelId, attackerVersion, 'lost');
      return;
    }

    const channel = this.deps.channelPool.get(channelId);
    if (!channel) {
      this.deps.logger.warn({ channelId }, 'dispute: channel not in pool');
      return;
    }

    let onChain: ChannelOnChain;
    try {
      onChain = await this.readChannelOnChain(channelId);
    } catch (err) {
      this.deps.logger.error(
        { err: (err as Error).message, channelId },
        'failed to read channel state to determine closer',
      );
      return;
    }

    if (onChain.disputeDeadlineMs > 0 && this.now() >= onChain.disputeDeadlineMs) {
      this.deps.logger.error(
        { channelId, deadlineMs: onChain.disputeDeadlineMs },
        'dispute deadline elapsed before we could respond — marking lost',
      );
      await this.deps.repos.disputes.markResolution(channelId, attackerVersion, 'lost');
      return;
    }

    const hubAddress = privateKeyToAccount(this.deps.hubPrivateKey).address;
    if (onChain.closer.toLowerCase() === hubAddress.toLowerCase()) {
      this.deps.logger.info(
        { channelId, closer: onChain.closer },
        'hub is the closer; not disputing own action — watchtower handles hub-key-compromise scenarios',
      );
      return;
    }

    let txHash: Hash | undefined;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const account = privateKeyToAccount(this.deps.hubPrivateKey);
        txHash = await this.walletClient.writeContract({
          account,
          chain: viemChainFor(this.deps.chainId),
          address: this.deps.paymentChannelAddress,
          abi: paymentChannelAbi,
          functionName: 'dispute',
          args: [
            channelId,
            encodeChannelStateForOnChain(ourLatest.state),
            signatureToHex(ourLatest.sigA),
            signatureToHex(ourLatest.sigB),
          ],
        });
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== 'success') {
          this.deps.logger.error(
            { channelId, txHash, status: receipt.status },
            'dispute tx mined but reverted; not marking won',
          );
          throw new Error(`dispute tx ${txHash} reverted on-chain`);
        }
        break;
      } catch (err) {
        lastErr = err;
        this.deps.logger.warn(
          { err: (err as Error).message, channelId, attempt, maxAttempts: this.maxAttempts },
          'dispute tx attempt failed',
        );
        if (attempt < this.maxAttempts) {
          await sleep(this.backoffMs * 2 ** (attempt - 1));
        }
      }
    }

    if (!txHash) {
      this.deps.logger.error(
        { err: (lastErr as Error | undefined)?.message, channelId },
        'dispute tx submission failed after all retries — will retry on next poll',
      );
      return;
    }

    await this.deps.repos.disputes.markResponded(channelId, attackerVersion, txHash, this.now());
    await this.deps.repos.disputes.markResolution(channelId, attackerVersion, 'won');
    this.deps.logger.info(
      { channelId, txHash, ourVersion: ourLatest.state.version.toString() },
      'dispute submitted',
    );
  }

  private async readChannelOnChain(channelId: ChannelId): Promise<ChannelOnChain> {
    const row = await this.publicClient.readContract({
      address: this.deps.paymentChannelAddress,
      abi: channelsReadAbi,
      functionName: 'channels',
      args: [channelId],
    });
    return {
      closer: row[12] as Address,
      disputeDeadlineMs: Number(row[6] as bigint) * 1000,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
