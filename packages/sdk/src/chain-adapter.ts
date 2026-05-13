import {
  type Address,
  type ChannelId,
  type ChannelState,
  type CooperativeClose,
  type Hex,
  type Signature,
  type SignedCooperativeClose,
  type SignedState,
  ZERO_ADDRESS,
} from '@inferenceroom/pico-protocol';
import { computeHtlcsRoot } from '@inferenceroom/pico-state-machine';
import {
  type Hash,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  erc20Abi,
  parseEventLogs,
} from 'viem';
import {
  channelStateSolidityStruct,
  cooperativeCloseSolidityStruct,
  paymentChannelAbi,
} from './contracts-abi.js';
import { signatureToHex } from './signature-codec.js';

export interface OpenChannelOnChainArgs {
  readonly userB: Address;
  readonly token: Address;
  readonly amountA: bigint;
  readonly amountB: bigint;
}

export interface OpenChannelOnChainResult {
  readonly channelId: ChannelId;
  readonly userA: Address;
  readonly userB: Address;
  readonly token: Address;
  readonly amountA: bigint;
  readonly amountB: bigint;
  readonly openedAtMs: bigint;
  readonly txHash: Hash;
  readonly blockNumber: bigint;
}

export interface CloseCooperativeOnChainArgs {
  readonly channelId: ChannelId;
  readonly signedClose: SignedCooperativeClose;
}

export interface CloseUnilateralOnChainArgs {
  readonly channelId: ChannelId;
  readonly state: SignedState;
  readonly mySide: 'A' | 'B';
}

export interface CloseOnChainResult {
  readonly txHash: Hash;
  readonly blockNumber: bigint;
}

export interface CloseUnilateralOnChainResult {
  readonly txHash: Hash;
  readonly disputeDeadlineMs: bigint;
  readonly postedVersion: bigint;
  readonly blockNumber: bigint;
}

export interface FinalizedResult {
  readonly paidA: bigint;
  readonly paidB: bigint;
  readonly txHash: Hash;
}

export interface TopUpOnChainArgs {
  readonly channelId: ChannelId;
  readonly amount: bigint;
  /** Latest co-signed state, OR a synthetic version-0 sentinel for first top-up. */
  readonly prev: SignedState;
  /** version+1 state with depositor's balance bumped by `amount`. Both sigs required. */
  readonly next: SignedState;
  /** ERC-20 token used for the channel; required for the `approve()` call. */
  readonly token: Address;
  /** Default true. Skip the `approve()` call when caller already approved off-band. */
  readonly approve?: boolean;
}

export interface TopUpOnChainResult {
  readonly txHash: Hash;
  readonly newVersion: bigint;
  readonly amount: bigint;
}

export interface CloseUnilateralFromOpenOnChainArgs {
  readonly channelId: ChannelId;
}

/**
 * H4: client-side surface for the v2 on-chain HTLC settlement entry points.
 * Mirrors the contract's `claimHtlc(channelId, htlc, proof, sortedIndex,
 * totalLeaves, preimage)` and `refundHtlc(channelId, htlc, proof, sortedIndex,
 * totalLeaves)`. Watchtowers route through these; clients with a known
 * preimage may also self-settle without a watchtower.
 */
export interface OnChainHtlc {
  readonly id: Hex;
  readonly amount: bigint;
  readonly paymentHash: Hex;
  /** Unix-seconds (uint64 on chain). */
  readonly expiry: bigint;
  /** 0 = AtoB, 1 = BtoA. */
  readonly direction: number;
}

export interface ClaimHtlcOnChainArgs {
  readonly channelId: ChannelId;
  readonly htlc: OnChainHtlc;
  /** Ordered Merkle proof from `htlcMerkleProof(htlcs, htlc.id)`. */
  readonly proof: readonly Hex[];
  /** Index of `htlc` in the sort-by-id ordering of the posted HTLC set. */
  readonly sortedIndex: bigint;
  /** Number of leaves in the posted HTLC set. */
  readonly totalLeaves: bigint;
  /** Raw preimage bytes — the contract verifies `sha256(preimage) == paymentHash`. */
  readonly preimage: Hex;
}

export interface RefundHtlcOnChainArgs {
  readonly channelId: ChannelId;
  readonly htlc: OnChainHtlc;
  readonly proof: readonly Hex[];
  readonly sortedIndex: bigint;
  readonly totalLeaves: bigint;
}

export interface HtlcResolutionResult {
  readonly txHash: Hash;
}

export interface ChainAdapter {
  openChannel(args: OpenChannelOnChainArgs): Promise<OpenChannelOnChainResult>;
  closeCooperative(args: CloseCooperativeOnChainArgs): Promise<CloseOnChainResult>;
  closeUnilateral(args: CloseUnilateralOnChainArgs): Promise<CloseUnilateralOnChainResult>;
  closeUnilateralFromOpen(
    args: CloseUnilateralFromOpenOnChainArgs,
  ): Promise<CloseUnilateralOnChainResult>;
  topUp(args: TopUpOnChainArgs): Promise<TopUpOnChainResult>;
  finalize(channelId: ChannelId): Promise<FinalizedResult>;
  waitForFinalized(channelId: ChannelId, opts?: { timeoutMs?: number }): Promise<FinalizedResult>;
  /**
   * Post a `claimHtlc` tx. The htlc + proof come from off-chain; preimage
   * comes from the original payment session (or a watchtower's preimage
   * cache). Requires the channel to be in `Status.ResolvingHtlcs`.
   */
  claimHtlc(args: ClaimHtlcOnChainArgs): Promise<HtlcResolutionResult>;
  /**
   * Post a `refundHtlc` tx. Settles a pending HTLC back to its sender after
   * its own `expiry` OR after the channel-wide `htlcResolutionDeadline`
   * (forced-refund path, H1). Requires `Status.ResolvingHtlcs`.
   */
  refundHtlc(args: RefundHtlcOnChainArgs): Promise<HtlcResolutionResult>;
  dispose?(): Promise<void>;
}

export function encodeChannelStateForOnChain(state: ChannelState): Hex {
  return encodeAbiParameters(
    [{ type: 'tuple', components: [...channelStateSolidityStruct] }],
    [
      {
        channelId: state.channelId,
        version: state.version,
        balanceA: state.balanceA,
        balanceB: state.balanceB,
        htlcsRoot: computeHtlcsRoot(state.htlcs),
        htlcsCount: state.htlcsCount,
        htlcsTotalLocked: state.htlcsTotalLocked,
        finalized: state.finalized,
      },
    ],
  );
}

export function encodeCooperativeCloseForOnChain(close: CooperativeClose): Hex {
  return encodeAbiParameters(
    [{ type: 'tuple', components: [...cooperativeCloseSolidityStruct] }],
    [
      {
        channelId: close.channelId,
        version: close.version,
        finalBalanceA: close.finalBalanceA,
        finalBalanceB: close.finalBalanceB,
        signedAt: close.signedAt,
        validUntil: close.validUntil,
      },
    ],
  );
}

/**
 * Returns true when the signature is the all-zero sentinel used to mark an
 * unsigned slot in a synthetic version-0 `SignedState` (see protocol-spec
 * §8.3). The on-chain `topUp` accepts the sentinel branch only when both
 * `prev.sigA` and `prev.sigB` are zero-LENGTH bytes (`0x`); a 65-byte zero
 * string would fail the `prev.sigA.length == 0` check.
 */
export function isSentinelSig(sig: Signature): boolean {
  const allZero = (h: Hex): boolean => /^0x0+$/.test(h);
  return sig.v === 0 && allZero(sig.r) && allZero(sig.s);
}

function encodeTopUpSig(sig: Signature, sentinel: boolean): Hex {
  return sentinel && isSentinelSig(sig) ? ('0x' as Hex) : signatureToHex(sig);
}

function buildSignedStateTuple(
  signed: SignedState,
  sentinel: boolean,
): {
  state: {
    channelId: ChannelId;
    version: bigint;
    balanceA: bigint;
    balanceB: bigint;
    htlcsRoot: Hex;
    htlcsCount: number;
    htlcsTotalLocked: bigint;
    finalized: boolean;
  };
  sigA: Hex;
  sigB: Hex;
} {
  return {
    state: {
      channelId: signed.state.channelId,
      version: signed.state.version,
      balanceA: signed.state.balanceA,
      balanceB: signed.state.balanceB,
      htlcsRoot: computeHtlcsRoot(signed.state.htlcs),
      htlcsCount: signed.state.htlcsCount,
      htlcsTotalLocked: signed.state.htlcsTotalLocked,
      finalized: signed.state.finalized,
    },
    sigA: encodeTopUpSig(signed.sigA, sentinel),
    sigB: encodeTopUpSig(signed.sigB, sentinel),
  };
}

export interface ViemChainAdapterOptions {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly paymentChannelAddress: Address;
}

/**
 * Returns gas fee overrides for `walletClient.writeContract` that
 * decisively beat the chain's current basefee. On Taiko mainnet (round-3
 * smoke, issue #100 finding #13), viem's default `eth_gasPrice` returned
 * a stale value (~0.012 gwei) while the chain's actual floor was
 * ~0.039 gwei, leaving close-from-open txs stuck in mempool indefinitely.
 *
 * Strategy: read the latest block's `baseFeePerGas`. If EIP-1559 is
 * supported, return `maxFeePerGas = 4 × basefee + tip` so subsequent
 * basefee bumps don't strand the tx. If not, fall back to legacy
 * `gasPrice = 4 × eth_gasPrice`.
 */
export async function inflatedFeesFromBlock(
  publicClient: PublicClient,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint }> {
  // Minimum priority fee — keeps the tx attractive even when basefee dips.
  const MIN_PRIORITY_FEE = 1_000_000n; // 0.001 gwei
  try {
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    if (block.baseFeePerGas !== null && block.baseFeePerGas !== undefined) {
      const maxPriorityFeePerGas = MIN_PRIORITY_FEE;
      const maxFeePerGas = block.baseFeePerGas * 4n + maxPriorityFeePerGas;
      return { maxFeePerGas, maxPriorityFeePerGas };
    }
  } catch {
    // Block fetch failed — fall through to legacy path.
  }
  const gp = await publicClient.getGasPrice();
  return { gasPrice: gp * 4n };
}

export class ViemChainAdapter implements ChainAdapter {
  constructor(private readonly opts: ViemChainAdapterOptions) {}

  /** @internal */
  private fees(): Promise<
    { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint }
  > {
    return inflatedFeesFromBlock(this.opts.publicClient);
  }

  async openChannel(args: OpenChannelOnChainArgs): Promise<OpenChannelOnChainResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const isNative = args.token === ZERO_ADDRESS;
    const fees = await this.fees();
    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'openChannel',
      args: [args.userB, args.token, args.amountA, args.amountB],
      account,
      chain,
      value: isNative ? args.amountA : 0n,
      ...fees,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({
      abi: paymentChannelAbi,
      eventName: 'ChannelOpened',
      logs: receipt.logs,
    });
    const ev = logs[0];
    if (!ev) throw new Error('ChannelOpened event not found in receipt');
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

    return {
      channelId: ev.args.channelId,
      userA: ev.args.userA,
      userB: ev.args.userB,
      token: ev.args.token,
      amountA: ev.args.amountA,
      amountB: ev.args.amountB,
      openedAtMs: block.timestamp * 1000n,
      txHash,
      blockNumber: receipt.blockNumber,
    };
  }

  async closeCooperative(args: CloseCooperativeOnChainArgs): Promise<CloseOnChainResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const closeBytes = encodeCooperativeCloseForOnChain(args.signedClose.close);
    const sigA = signatureToHex(args.signedClose.sigA);
    const sigB = signatureToHex(args.signedClose.sigB);

    const fees = await this.fees();
    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'closeCooperative',
      args: [args.channelId, closeBytes, sigA, sigB],
      account,
      chain,
      ...fees,
    });
    const closeReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, blockNumber: closeReceipt.blockNumber };
  }

  async closeUnilateral(args: CloseUnilateralOnChainArgs): Promise<CloseUnilateralOnChainResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const stateBytes = encodeChannelStateForOnChain(args.state.state);
    const counterpartySig = signatureToHex(args.mySide === 'A' ? args.state.sigB : args.state.sigA);

    const fees = await this.fees();
    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'closeUnilateral',
      args: [args.channelId, stateBytes, counterpartySig],
      account,
      chain,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({
      abi: paymentChannelAbi,
      eventName: 'ChannelClosingUnilateral',
      logs: receipt.logs,
    });
    const ev = logs[0];
    if (!ev) throw new Error('ChannelClosingUnilateral event not found in receipt');
    return {
      txHash,
      disputeDeadlineMs: ev.args.disputeDeadline * 1000n,
      postedVersion: ev.args.postedVersion,
      blockNumber: receipt.blockNumber,
    };
  }

  async closeUnilateralFromOpen(
    args: CloseUnilateralFromOpenOnChainArgs,
  ): Promise<CloseUnilateralOnChainResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const fees = await this.fees();
    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'closeUnilateralFromOpen',
      args: [args.channelId],
      account,
      chain,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({
      abi: paymentChannelAbi,
      eventName: 'ChannelClosingUnilateral',
      logs: receipt.logs,
    });
    const ev = logs[0];
    if (!ev) throw new Error('ChannelClosingUnilateral event not found in receipt');
    return {
      txHash,
      disputeDeadlineMs: ev.args.disputeDeadline * 1000n,
      postedVersion: ev.args.postedVersion,
      blockNumber: receipt.blockNumber,
    };
  }

  async topUp(args: TopUpOnChainArgs): Promise<TopUpOnChainResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const isNative = args.token === ZERO_ADDRESS;
    if (!isNative && args.approve !== false) {
      const approveFees = await this.fees();
      const approveHash = await walletClient.writeContract({
        address: args.token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [paymentChannelAddress, args.amount],
        account,
        chain,
        ...approveFees,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    const prevSentinel =
      args.prev.state.version === 0n &&
      isSentinelSig(args.prev.sigA) &&
      isSentinelSig(args.prev.sigB);
    const prevTuple = buildSignedStateTuple(args.prev, prevSentinel);
    const nextTuple = buildSignedStateTuple(args.next, false);

    const fees = await this.fees();
    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'topUp',
      args: [args.channelId, args.amount, prevTuple, nextTuple],
      account,
      chain,
      value: isNative ? args.amount : 0n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({
      abi: paymentChannelAbi,
      eventName: 'ToppedUp',
      logs: receipt.logs,
    });
    const ev = logs[0];
    if (!ev) throw new Error('ToppedUp event not found in receipt');
    return { txHash, newVersion: ev.args.newVersion, amount: args.amount };
  }

  async finalize(channelId: ChannelId): Promise<FinalizedResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const fees = await this.fees();
    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'finalize',
      args: [channelId],
      account,
      chain,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({
      abi: paymentChannelAbi,
      eventName: 'ChannelFinalized',
      logs: receipt.logs,
    });
    const ev = logs[0];
    if (!ev) throw new Error('ChannelFinalized event not found in receipt');
    return { paidA: ev.args.paidA, paidB: ev.args.paidB, txHash };
  }

  async claimHtlc(args: ClaimHtlcOnChainArgs): Promise<HtlcResolutionResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const fees = await this.fees();
    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'claimHtlc',
      args: [
        args.channelId,
        {
          id: args.htlc.id,
          amount: args.htlc.amount,
          paymentHash: args.htlc.paymentHash,
          expiry: args.htlc.expiry,
          direction: args.htlc.direction,
        },
        args.proof,
        args.sortedIndex,
        args.totalLeaves,
        args.preimage,
      ],
      account,
      chain,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash };
  }

  async refundHtlc(args: RefundHtlcOnChainArgs): Promise<HtlcResolutionResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const fees = await this.fees();
    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'refundHtlc',
      args: [
        args.channelId,
        {
          id: args.htlc.id,
          amount: args.htlc.amount,
          paymentHash: args.htlc.paymentHash,
          expiry: args.htlc.expiry,
          direction: args.htlc.direction,
        },
        args.proof,
        args.sortedIndex,
        args.totalLeaves,
      ],
      account,
      chain,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash };
  }

  async waitForFinalized(
    channelId: ChannelId,
    opts: { timeoutMs?: number } = {},
  ): Promise<FinalizedResult> {
    const { publicClient, paymentChannelAddress } = this.opts;
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    return new Promise<FinalizedResult>((resolve, reject) => {
      const unwatch = publicClient.watchContractEvent({
        address: paymentChannelAddress,
        abi: paymentChannelAbi,
        eventName: 'ChannelFinalized',
        args: { channelId },
        onLogs(logs) {
          const ev = logs[0];
          if (!ev) return;
          const paidA = ev.args.paidA;
          const paidB = ev.args.paidB;
          if (paidA === undefined || paidB === undefined) return;
          unwatch();
          clearTimeout(timer);
          resolve({ paidA, paidB, txHash: ev.transactionHash });
        },
      });
      const timer = setTimeout(() => {
        unwatch();
        reject(new Error(`waitForFinalized timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }
}
