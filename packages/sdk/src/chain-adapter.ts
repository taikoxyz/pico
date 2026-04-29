import type { Address, ChannelId, ChannelState, Hex, SignedState } from '@tainnel/protocol';
import { computeHtlcsRoot } from '@tainnel/state-machine';
import {
  type Hash,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  parseEventLogs,
} from 'viem';
import { channelStateSolidityStruct, paymentChannelAbi } from './contracts-abi.js';
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
}

export interface CloseCooperativeOnChainArgs {
  readonly channelId: ChannelId;
  readonly finalState: SignedState;
}

export interface CloseUnilateralOnChainArgs {
  readonly channelId: ChannelId;
  readonly state: SignedState;
  readonly mySide: 'A' | 'B';
}

export interface CloseOnChainResult {
  readonly txHash: Hash;
}

export interface CloseUnilateralOnChainResult {
  readonly txHash: Hash;
  readonly disputeDeadlineMs: bigint;
  readonly postedVersion: bigint;
}

export interface FinalizedResult {
  readonly paidA: bigint;
  readonly paidB: bigint;
  readonly txHash: Hash;
}

export interface ChainAdapter {
  openChannel(args: OpenChannelOnChainArgs): Promise<OpenChannelOnChainResult>;
  closeCooperative(args: CloseCooperativeOnChainArgs): Promise<CloseOnChainResult>;
  closeUnilateral(args: CloseUnilateralOnChainArgs): Promise<CloseUnilateralOnChainResult>;
  finalize(channelId: ChannelId): Promise<FinalizedResult>;
  waitForFinalized(channelId: ChannelId, opts?: { timeoutMs?: number }): Promise<FinalizedResult>;
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
        finalized: state.finalized,
      },
    ],
  );
}

export interface ViemChainAdapterOptions {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly paymentChannelAddress: Address;
}

export class ViemChainAdapter implements ChainAdapter {
  constructor(private readonly opts: ViemChainAdapterOptions) {}

  async openChannel(args: OpenChannelOnChainArgs): Promise<OpenChannelOnChainResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'openChannel',
      args: [args.userB, args.token, args.amountA, args.amountB],
      account,
      chain,
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
    };
  }

  async closeCooperative(args: CloseCooperativeOnChainArgs): Promise<CloseOnChainResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const stateBytes = encodeChannelStateForOnChain(args.finalState.state);
    const sigA = signatureToHex(args.finalState.sigA);
    const sigB = signatureToHex(args.finalState.sigB);

    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'closeCooperative',
      args: [args.channelId, stateBytes, sigA, sigB],
      account,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash };
  }

  async closeUnilateral(args: CloseUnilateralOnChainArgs): Promise<CloseUnilateralOnChainResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const stateBytes = encodeChannelStateForOnChain(args.state.state);
    const counterpartySig = signatureToHex(args.mySide === 'A' ? args.state.sigB : args.state.sigA);

    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'closeUnilateral',
      args: [args.channelId, stateBytes, counterpartySig],
      account,
      chain,
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
    };
  }

  async finalize(channelId: ChannelId): Promise<FinalizedResult> {
    const { walletClient, publicClient, paymentChannelAddress } = this.opts;
    const account = walletClient.account;
    if (!account) throw new Error('ViemChainAdapter: walletClient has no account');
    const chain = walletClient.chain;
    if (!chain) throw new Error('ViemChainAdapter: walletClient has no chain');

    const txHash = await walletClient.writeContract({
      address: paymentChannelAddress,
      abi: paymentChannelAbi,
      functionName: 'finalize',
      args: [channelId],
      account,
      chain,
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
