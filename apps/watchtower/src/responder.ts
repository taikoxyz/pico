import type { Address, ChannelId, Hex, Signature, SignedState } from '@tainnel/protocol';
import { htlcMerkleRoot } from '@tainnel/protocol';
import {
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHANNEL_STATE_ABI_PARAMS, SUBMIT_PENALTY_PROOF_ABI } from './abi.js';
import type { Logger } from './logger.js';

export type CloserSide = 'A' | 'B';

export interface PenaltyResponderDeps {
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly contractAddress: Address;
  readonly privateKey: Hex;
  readonly logger: Logger;
  readonly publicClient?: PublicClient;
  readonly walletClient?: WalletClient;
  readonly maxAttempts?: number;
  readonly receiptTimeoutMs?: number;
  readonly gasBumpNumerator?: bigint;
  readonly gasBumpDenominator?: bigint;
}

export class PenaltySubmissionRevertedError extends Error {
  readonly code = 'penalty_submission_reverted';
  constructor(
    readonly txHash: Hex,
    readonly channelId: ChannelId,
  ) {
    super(`penalty submission reverted: ${txHash} on channel ${channelId}`);
  }
}

export class PenaltySubmissionExhaustedError extends Error {
  readonly code = 'penalty_submission_exhausted';
  constructor(
    readonly channelId: ChannelId,
    readonly attempts: number,
  ) {
    super(`penalty submission exhausted ${attempts} attempts on channel ${channelId}`);
  }
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RECEIPT_TIMEOUT_MS = 60_000;
const DEFAULT_GAS_BUMP_NUM = 125n;
const DEFAULT_GAS_BUMP_DEN = 100n;

interface InFlightEntry {
  readonly evidence: SignedState;
  readonly promise: Promise<Hex>;
}

export class PenaltyResponder {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly inFlight = new Map<ChannelId, InFlightEntry>();
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(private readonly deps: PenaltyResponderDeps) {
    this.account = privateKeyToAccount(deps.privateKey);
    this.publicClient =
      deps.publicClient ??
      (createPublicClient({
        chain: deps.chain,
        transport: http(deps.rpcUrl),
      }) as unknown as PublicClient);
    this.walletClient =
      deps.walletClient ??
      (createWalletClient({
        account: this.account,
        chain: deps.chain,
        transport: http(deps.rpcUrl),
      }) as unknown as WalletClient);
  }

  get walletAddress(): Address {
    return this.account.address;
  }

  submitPenalty(channelId: ChannelId, evidence: SignedState, closerSide: CloserSide): Promise<Hex> {
    const existing = this.inFlight.get(channelId);
    if (existing && evidence.state.version <= existing.evidence.state.version) {
      return existing.promise;
    }
    const previous = existing?.promise;
    const run = (): Promise<Hex> => this.runWithRetries(channelId, evidence, closerSide);
    const next = previous ? previous.then(run, run) : run();
    const entry: InFlightEntry = { evidence, promise: next };
    this.inFlight.set(channelId, entry);
    const cleanup = (): void => {
      if (this.inFlight.get(channelId) === entry) this.inFlight.delete(channelId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private async runWithRetries(
    channelId: ChannelId,
    evidence: SignedState,
    closerSide: CloserSide,
  ): Promise<Hex> {
    const max = this.deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const bumpNum = this.deps.gasBumpNumerator ?? DEFAULT_GAS_BUMP_NUM;
    const bumpDen = this.deps.gasBumpDenominator ?? DEFAULT_GAS_BUMP_DEN;
    const receiptTimeout = this.deps.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;

    const encodedState = encodePenaltyState(evidence);
    const sig = packSignature(closerSide === 'A' ? evidence.sigA : evidence.sigB);
    const data = encodeFunctionData({
      abi: SUBMIT_PENALTY_PROOF_ABI,
      functionName: 'submitPenaltyProof',
      args: [channelId, encodedState, sig],
    });

    let bumpExp = 0;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        const fees = await this.publicClient.estimateFeesPerGas();
        const factorNum = bumpNum ** BigInt(bumpExp + 1);
        const factorDen = bumpDen ** BigInt(bumpExp + 1);
        const maxFeePerGas =
          fees.maxFeePerGas !== undefined ? (fees.maxFeePerGas * factorNum) / factorDen : undefined;
        const maxPriorityFeePerGas =
          fees.maxPriorityFeePerGas !== undefined
            ? (fees.maxPriorityFeePerGas * factorNum) / factorDen
            : undefined;
        const gas = await this.publicClient
          .estimateGas({
            account: this.account.address,
            to: this.deps.contractAddress,
            data,
          })
          .catch(() => 500_000n);
        const txHash = (await this.walletClient.sendTransaction({
          account: this.account,
          chain: this.deps.chain,
          to: this.deps.contractAddress,
          data,
          gas,
          ...(maxFeePerGas !== undefined ? { maxFeePerGas } : {}),
          ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
        })) as Hex;
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash: txHash,
          timeout: receiptTimeout,
        });
        if (receipt.status === 'reverted') {
          throw new PenaltySubmissionRevertedError(txHash, channelId);
        }
        this.deps.logger.info({ channelId, txHash, attempt }, 'penalty submitted');
        return txHash;
      } catch (err) {
        lastErr = err;
        if (err instanceof PenaltySubmissionRevertedError) throw err;
        this.deps.logger.warn({ err, attempt, channelId }, 'penalty attempt failed; retrying');
        bumpExp += 1;
      }
    }
    if (lastErr instanceof PenaltySubmissionRevertedError) throw lastErr;
    throw new PenaltySubmissionExhaustedError(channelId, max);
  }
}

export function encodePenaltyState(s: SignedState): Hex {
  const htlcsRoot = htlcMerkleRoot(s.state.htlcs);
  return encodeAbiParameters(CHANNEL_STATE_ABI_PARAMS, [
    {
      channelId: s.state.channelId,
      version: s.state.version,
      balanceA: s.state.balanceA,
      balanceB: s.state.balanceB,
      htlcsRoot,
      finalized: s.state.finalized,
    },
  ]);
}

export function packSignature(sig: Signature): Hex {
  const r = strip0x(sig.r).padStart(64, '0');
  const s = strip0x(sig.s).padStart(64, '0');
  const v = sig.v.toString(16).padStart(2, '0');
  return `0x${r}${s}${v}` as Hex;
}

function strip0x(h: Hex): string {
  return h.startsWith('0x') ? h.slice(2) : h;
}
