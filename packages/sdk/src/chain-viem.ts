import type { Address, ChainId, ChannelId, Hex, Signature, SignedState } from '@tainnel/protocol';
import { htlcMerkleRoot } from '@tainnel/protocol';
import {
  type Account,
  type Chain,
  type Log,
  type PublicClient,
  type WalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
} from 'viem';
import type {
  ChainAdapter,
  ChannelFinalizedReceipt,
  CloseCooperativeTxArgs,
  CloseReceipt,
  CloseUnilateralTxArgs,
  OpenChannelReceipt,
  OpenChannelTxArgs,
  WaitForFinalizedOptions,
} from './chain.js';

export const PAYMENT_CHANNEL_ABI = parseAbi([
  'function openChannel(address userB, address token, uint256 amountA, uint256 amountB) external payable returns (bytes32 channelId)',
  'function closeCooperative(bytes32 channelId, bytes finalState, bytes sigA, bytes sigB) external',
  'function closeUnilateral(bytes32 channelId, bytes state, bytes sigCounterparty) external',
  'event ChannelOpened(bytes32 indexed channelId, address indexed userA, address indexed userB, address token, uint256 amountA, uint256 amountB)',
  'event ChannelClosedCooperative(bytes32 indexed channelId, uint64 finalVersion)',
  'event ChannelClosingUnilateral(bytes32 indexed channelId, uint64 postedVersion, uint256 disputeDeadline)',
  'event ChannelFinalized(bytes32 indexed channelId, uint256 paidA, uint256 paidB)',
]);

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);

const CHANNEL_STATE_ABI_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'version', type: 'uint64' },
      { name: 'balanceA', type: 'uint256' },
      { name: 'balanceB', type: 'uint256' },
      { name: 'htlcsRoot', type: 'bytes32' },
      { name: 'finalized', type: 'bool' },
    ],
  },
] as const;

const DEFAULT_RECEIPT_TIMEOUT_MS = 60_000;
const DEFAULT_FINALIZE_TIMEOUT_MS = 60_000;
const DEFAULT_FINALIZE_POLL_MS = 4_000;

export interface ViemChainAdapterOptions {
  readonly walletClient: WalletClient;
  readonly publicClient: PublicClient;
  readonly chain: Chain;
  readonly account: Account;
  /** When true (default), `openChannel` checks the ERC-20 allowance and submits
   * an `approve` tx if it's insufficient. Set false if approvals are managed
   * out-of-band. */
  readonly autoApprove?: boolean;
  readonly receiptTimeoutMs?: number;
  readonly finalizePollMs?: number;
}

export class ViemChainAdapter implements ChainAdapter {
  readonly chainId: ChainId;
  private readonly walletClient: WalletClient;
  private readonly publicClient: PublicClient;
  private readonly chain: Chain;
  private readonly account: Account;
  private readonly autoApprove: boolean;
  private readonly receiptTimeoutMs: number;
  private readonly finalizePollMs: number;

  constructor(opts: ViemChainAdapterOptions) {
    this.walletClient = opts.walletClient;
    this.publicClient = opts.publicClient;
    this.chain = opts.chain;
    this.account = opts.account;
    this.chainId = opts.chain.id as ChainId;
    this.autoApprove = opts.autoApprove ?? true;
    this.receiptTimeoutMs = opts.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.finalizePollMs = opts.finalizePollMs ?? DEFAULT_FINALIZE_POLL_MS;
  }

  async openChannel(args: OpenChannelTxArgs): Promise<OpenChannelReceipt> {
    if (this.autoApprove && args.amountA > 0n) {
      await this.ensureAllowance(args.token, args.contract, args.amountA);
    }
    const data = encodeFunctionData({
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'openChannel',
      args: [args.userB, args.token, args.amountA, args.amountB],
    });
    const receipt = await this.sendTx(args.contract, data);
    const opened = this.findChannelOpened(receipt.logs);
    if (!opened) {
      throw new Error('openChannel succeeded but no ChannelOpened event was emitted');
    }
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    return {
      channelId: opened.channelId,
      userA: opened.userA,
      userB: opened.userB,
      token: opened.token,
      amountA: opened.amountA,
      amountB: opened.amountB,
      txHash: receipt.transactionHash as Hex,
      blockTimestamp: block.timestamp,
    };
  }

  async closeCooperative(args: CloseCooperativeTxArgs): Promise<CloseReceipt> {
    const encodedState = encodeStateForContract(args.state);
    const sigA = packSignature(args.state.sigA);
    const sigB = packSignature(args.state.sigB);
    const data = encodeFunctionData({
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'closeCooperative',
      args: [args.channelId, encodedState, sigA, sigB],
    });
    const receipt = await this.sendTx(args.contract, data);
    return { channelId: args.channelId, txHash: receipt.transactionHash as Hex };
  }

  async closeUnilateral(args: CloseUnilateralTxArgs): Promise<CloseReceipt> {
    const encodedState = encodeStateForContract(args.state);
    // Without an explicit closerSide we can't know which sig is the
    // counterparty's. Default to passing sigB as the counterparty (assumes
    // the closer is userA). Callers using ChannelClient pass closerSide.
    const counterpartySig = args.closerSide === 'B' ? args.state.sigA : args.state.sigB;
    const data = encodeFunctionData({
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'closeUnilateral',
      args: [args.channelId, encodedState, packSignature(counterpartySig)],
    });
    const receipt = await this.sendTx(args.contract, data);
    return { channelId: args.channelId, txHash: receipt.transactionHash as Hex };
  }

  async waitForFinalized(
    channelId: ChannelId,
    opts?: WaitForFinalizedOptions,
  ): Promise<ChannelFinalizedReceipt> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let fromBlock = await this.publicClient.getBlockNumber();
    while (Date.now() < deadline) {
      const events = await this.publicClient.getContractEvents({
        abi: PAYMENT_CHANNEL_ABI,
        eventName: 'ChannelFinalized',
        args: { channelId },
        fromBlock,
      });
      const found = events.find((e) => {
        const a = (e as Log & { args?: { channelId?: Hex } }).args;
        return a?.channelId === channelId;
      });
      if (found) {
        const args = (
          found as Log & {
            args: { channelId: Hex; paidA: bigint; paidB: bigint };
          }
        ).args;
        return {
          channelId: args.channelId as ChannelId,
          paidA: args.paidA,
          paidB: args.paidB,
          txHash: (found.transactionHash ?? '0x') as Hex,
        };
      }
      const head = await this.publicClient.getBlockNumber();
      if (head > fromBlock) fromBlock = head;
      await sleep(this.finalizePollMs);
    }
    throw new Error(`waitForFinalized: timed out after ${timeoutMs}ms for ${channelId}`);
  }

  private async ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<void> {
    const current = (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [this.account.address, spender],
    })) as bigint;
    if (current >= amount) return;
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, amount],
    });
    await this.sendTx(token, data);
  }

  private async sendTx(
    to: Address,
    data: Hex,
  ): ReturnType<PublicClient['waitForTransactionReceipt']> {
    const txHash = (await this.walletClient.sendTransaction({
      account: this.account,
      chain: this.chain,
      to,
      data,
    })) as Hex;
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: this.receiptTimeoutMs,
    });
    if (receipt.status !== 'success') {
      throw new Error(`tx ${txHash} reverted on-chain (to=${to})`);
    }
    return receipt;
  }

  private findChannelOpened(logs: readonly Log[]):
    | {
        channelId: ChannelId;
        userA: Address;
        userB: Address;
        token: Address;
        amountA: bigint;
        amountB: bigint;
      }
    | undefined {
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: PAYMENT_CHANNEL_ABI,
          data: log.data,
          topics: log.topics,
        }) as { eventName: string; args: Record<string, unknown> };
        if (decoded.eventName !== 'ChannelOpened') continue;
        const a = decoded.args as {
          channelId: Hex;
          userA: Address;
          userB: Address;
          token: Address;
          amountA: bigint;
          amountB: bigint;
        };
        return {
          channelId: a.channelId as ChannelId,
          userA: a.userA,
          userB: a.userB,
          token: a.token,
          amountA: a.amountA,
          amountB: a.amountB,
        };
      } catch {
        // not a log we can decode; skip
      }
    }
    return undefined;
  }
}

function encodeStateForContract(s: SignedState): Hex {
  return encodeAbiParameters(CHANNEL_STATE_ABI_PARAMS, [
    {
      channelId: s.state.channelId,
      version: s.state.version,
      balanceA: s.state.balanceA,
      balanceB: s.state.balanceB,
      htlcsRoot: htlcMerkleRoot(s.state.htlcs),
      finalized: s.state.finalized,
    },
  ]);
}

function packSignature(sig: Signature): Hex {
  const r = strip0x(sig.r).padStart(64, '0');
  const s = strip0x(sig.s).padStart(64, '0');
  const v = sig.v.toString(16).padStart(2, '0');
  return `0x${r}${s}${v}` as Hex;
}

function strip0x(h: string): string {
  return h.startsWith('0x') ? h.slice(2) : h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
