import type { Address, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { encodeChannelStateForOnChain, signatureToHex } from '@tainnel/sdk';
import {
  http,
  type Chain,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, taiko } from 'viem/chains';
import type { Logger } from './logger.js';
import { penaltiesSubmittedTotal } from './metrics.js';
import type { InFlightTx, WatchtowerStore } from './storage.js';

const penaltyAbi = parseAbi([
  'function submitPenaltyProof(bytes32 channelId, bytes penaltyState, bytes sigA, bytes sigB)',
]);

const DEFAULT_GAS_BUMP_PERCENT = 25;
const DEFAULT_INCLUSION_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const FALLBACK_GAS_LIMIT = 300_000n;

function chainForId(chainId: number): Chain {
  if (chainId === 167000) return taiko;
  return foundry;
}

function bumpFee(prev: bigint, bumpPercent: number): bigint {
  return (prev * (100n + BigInt(bumpPercent))) / 100n;
}

function clampToCap(value: bigint, cap: bigint): bigint {
  return value > cap ? cap : value;
}

export interface PenaltyResponderDeps {
  readonly rpcUrl: string;
  readonly privateKey: Hex;
  readonly paymentChannelAddress: Address;
  readonly chainId: number;
  readonly logger: Logger;
  readonly publicClient?: PublicClient;
  readonly walletClient?: WalletClient;
  readonly store?: WatchtowerStore;
  readonly gasBumpPercent?: number;
  readonly inclusionTimeoutMs?: number;
  readonly maxAttempts?: number;
}

interface InMemoryInFlightStore {
  get(channelId: ChannelId): InFlightTx | undefined;
  put(row: InFlightTx): void;
  clear(channelId: ChannelId): void;
}

function createMemoryInFlight(): InMemoryInFlightStore {
  const map = new Map<ChannelId, InFlightTx>();
  return {
    get: (id) => map.get(id),
    put: (row) => {
      map.set(row.channelId, row);
    },
    clear: (id) => {
      map.delete(id);
    },
  };
}

export class PenaltyResponder {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly memoryInFlight: InMemoryInFlightStore;
  private readonly gasBumpPercent: number;
  private readonly inclusionTimeoutMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly deps: PenaltyResponderDeps) {
    const chain = chainForId(deps.chainId);
    const transport = http(deps.rpcUrl);
    this.publicClient =
      deps.publicClient ?? (createPublicClient({ chain, transport }) as PublicClient);
    this.walletClient =
      deps.walletClient ??
      createWalletClient({
        account: privateKeyToAccount(deps.privateKey),
        chain,
        transport,
      });
    this.memoryInFlight = createMemoryInFlight();
    this.gasBumpPercent = deps.gasBumpPercent ?? DEFAULT_GAS_BUMP_PERCENT;
    this.inclusionTimeoutMs = deps.inclusionTimeoutMs ?? DEFAULT_INCLUSION_TIMEOUT_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async submitPenalty(
    channelId: ChannelId,
    evidence: SignedState,
    closerSide: 'A' | 'B',
    observationId?: number,
  ): Promise<Hash> {
    const account = this.walletClient.account;
    if (!account) throw new Error('responder: walletClient has no account');
    const chain = this.walletClient.chain ?? chainForId(this.deps.chainId);

    const existing = this.readInFlight(channelId);
    if (existing) {
      const receipt = await this.publicClient
        .getTransactionReceipt({ hash: existing.txHash })
        .catch(() => null);
      if (!receipt) {
        // WTW-003: if the tx has been waiting longer than the inclusion
        // timeout, replace it (same nonce, bumped fee). Otherwise it's
        // still legitimately pending; do nothing.
        const ageMs = Date.now() - existing.submittedAtMs;
        if (ageMs >= this.inclusionTimeoutMs) {
          this.deps.logger.warn(
            {
              channelId,
              txHash: existing.txHash,
              ageMs,
              inclusionTimeoutMs: this.inclusionTimeoutMs,
              attempts: existing.attempts,
            },
            'in-flight penalty tx exceeded inclusion timeout; rebuilding with bumped fee + same nonce',
          );
          // Clear and fall through to the normal submit path below; the new
          // submit will reuse the persisted nonce so the network treats it
          // as a replacement.
          this.clearInFlight(channelId);
          // Fall through to submit path.
        } else {
          this.deps.logger.info(
            { channelId, txHash: existing.txHash, attempts: existing.attempts, ageMs },
            'submitPenalty idempotent no-op: existing in-flight tx still pending',
          );
          return existing.txHash;
        }
      } else if (receipt.status === 'success') {
        this.recordIncluded(existing.observationId ?? observationId);
        this.clearInFlight(channelId);
        this.deps.logger.info(
          { channelId, txHash: existing.txHash, observationId: existing.observationId },
          'submitPenalty idempotent no-op: existing in-flight tx already included',
        );
        return existing.txHash;
      } else {
        // Reverted on-chain; clear and re-submit a fresh attempt.
        this.deps.logger.warn(
          { channelId, txHash: existing.txHash, status: receipt.status },
          'in-flight penalty tx reverted; resubmitting',
        );
        this.clearInFlight(channelId);
      }
    }

    const stateBytes = encodeChannelStateForOnChain(evidence.state);
    const sigA = signatureToHex(evidence.sigA);
    const sigB = signatureToHex(evidence.sigB);
    const args = [channelId, stateBytes, sigA, sigB] as const;

    const nonce = await this.publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    });

    const fees = await this.publicClient.estimateFeesPerGas();
    const initialMaxFee = fees.maxFeePerGas;
    const feeCap = 2n * initialMaxFee;
    let maxFeePerGas = initialMaxFee;
    let maxPriorityFeePerGas = fees.maxPriorityFeePerGas;

    let gasLimit: bigint;
    try {
      gasLimit = await this.publicClient.estimateContractGas({
        address: this.deps.paymentChannelAddress,
        abi: penaltyAbi,
        functionName: 'submitPenaltyProof',
        args,
        account,
      });
    } catch {
      gasLimit = FALLBACK_GAS_LIMIT;
    }

    let currentTxHash: Hash;
    let attempts = 1;
    try {
      currentTxHash = await this.walletClient.writeContract({
        address: this.deps.paymentChannelAddress,
        abi: penaltyAbi,
        functionName: 'submitPenaltyProof',
        args,
        account,
        chain,
        nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gas: gasLimit,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (/stale/i.test(msg)) {
        this.clearInFlight(channelId);
        this.deps.logger.error(
          { channelId, version: evidence.state.version },
          'dispute reverted as stale; our state is not newer than posted version',
        );
      }
      throw err;
    }

    const submittedAtMs = Date.now();
    this.persistInFlight({
      channelId,
      txHash: currentTxHash,
      submittedAtMs,
      nonce,
      maxFeePerGas,
      attempts,
      ...(observationId !== undefined ? { observationId } : {}),
    });
    if (observationId !== undefined && this.deps.store) {
      this.deps.store.markObservationSubmitted(observationId, currentTxHash, submittedAtMs);
    }

    while (true) {
      const receipt = await this.tryWaitForReceipt(currentTxHash, this.inclusionTimeoutMs);
      if (receipt) {
        if (receipt.status !== 'success') {
          this.deps.logger.error(
            {
              channelId,
              version: evidence.state.version,
              txHash: currentTxHash,
              status: receipt.status,
              attempts,
            },
            'penalty proof tx mined but reverted; not marking included',
          );
          throw new Error(
            `responder: penalty tx ${currentTxHash} reverted on-chain (status=${receipt.status})`,
          );
        }
        penaltiesSubmittedTotal.inc();
        this.recordIncluded(observationId);
        this.clearInFlight(channelId);
        this.deps.logger.info(
          {
            channelId,
            version: evidence.state.version,
            txHash: currentTxHash,
            attempts,
          },
          'penalty proof submitted (100% slash)',
        );
        return currentTxHash;
      }

      if (attempts >= this.maxAttempts) {
        throw new Error(
          `responder: penalty inclusion timed out after ${attempts} attempts (channelId=${channelId})`,
        );
      }

      maxFeePerGas = clampToCap(bumpFee(maxFeePerGas, this.gasBumpPercent), feeCap);
      maxPriorityFeePerGas = clampToCap(bumpFee(maxPriorityFeePerGas, this.gasBumpPercent), feeCap);
      attempts += 1;

      try {
        currentTxHash = await this.walletClient.writeContract({
          address: this.deps.paymentChannelAddress,
          abi: penaltyAbi,
          functionName: 'submitPenaltyProof',
          args,
          account,
          chain,
          nonce,
          maxFeePerGas,
          maxPriorityFeePerGas,
          gas: gasLimit,
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (/stale/i.test(msg)) {
          this.clearInFlight(channelId);
          this.deps.logger.error(
            { channelId, version: evidence.state.version },
            'dispute reverted as stale on retry; clearing in-flight',
          );
        }
        throw err;
      }

      this.persistInFlight({
        channelId,
        txHash: currentTxHash,
        submittedAtMs: Date.now(),
        nonce,
        maxFeePerGas,
        attempts,
        ...(observationId !== undefined ? { observationId } : {}),
      });
      this.deps.logger.warn(
        {
          channelId,
          txHash: currentTxHash,
          attempts,
          maxFeePerGas: maxFeePerGas.toString(),
        },
        'penalty inclusion timed out; resubmitted with bumped fees',
      );
    }
  }

  private async tryWaitForReceipt(
    hash: Hash,
    timeoutMs: number,
  ): Promise<TransactionReceipt | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const receiptPromise = this.publicClient
        .waitForTransactionReceipt({ hash, timeout: timeoutMs })
        .then((r) => r as TransactionReceipt | null)
        .catch((err: unknown) => {
          const msg = (err as Error).message ?? '';
          if (/timeout|timed out/i.test(msg)) return null;
          throw err;
        });
      const result = await Promise.race([receiptPromise, timeoutPromise]);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private readInFlight(channelId: ChannelId): InFlightTx | undefined {
    if (this.deps.store) return this.deps.store.getInFlight(channelId);
    return this.memoryInFlight.get(channelId);
  }

  private persistInFlight(row: InFlightTx): void {
    if (this.deps.store) {
      this.deps.store.putInFlight(row);
      return;
    }
    this.memoryInFlight.put(row);
  }

  private clearInFlight(channelId: ChannelId): void {
    if (this.deps.store) {
      this.deps.store.clearInFlight(channelId);
      return;
    }
    this.memoryInFlight.clear(channelId);
  }

  private recordIncluded(observationId: number | undefined): void {
    if (observationId === undefined || !this.deps.store) return;
    this.deps.store.markObservationIncluded(observationId, Date.now());
  }
}
