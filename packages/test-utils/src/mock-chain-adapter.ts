import type { Address, ChainId, Channel, ChannelId, Hex } from '@inferenceroom/pico-protocol';
import type {
  ChainAdapter,
  CloseCooperativeOnChainArgs,
  CloseOnChainResult,
  CloseUnilateralOnChainArgs,
  CloseUnilateralOnChainResult,
  FinalizedResult,
  OpenChannelOnChainArgs,
  OpenChannelOnChainResult,
} from '@inferenceroom/pico-sdk';
import { keccak256, toHex } from 'viem';

export interface MockChainAdapterOptions {
  readonly chainId: ChainId;
  readonly contract: Address;
  readonly disputeWindowMs?: number;
  readonly openLatencyMs?: number;
  readonly closeLatencyMs?: number;
  readonly userA: Address;
}

interface InternalChannel {
  readonly userA: Address;
  readonly userB: Address;
  readonly token: Address;
  readonly amountA: bigint;
  readonly amountB: bigint;
  readonly openedAtMs: bigint;
  postedBalanceA: bigint;
  postedBalanceB: bigint;
  status: 'open' | 'closing' | 'closed';
}

function fakeHash(seed: string): Hex {
  return keccak256(toHex(seed));
}

export class MockChainAdapter implements ChainAdapter {
  private readonly opts: Required<Omit<MockChainAdapterOptions, 'userA'>> & { userA: Address };
  private readonly channels = new Map<ChannelId, InternalChannel>();
  private nonce = 0n;
  private readonly finalizedListeners = new Map<ChannelId, Set<(r: FinalizedResult) => void>>();

  constructor(opts: MockChainAdapterOptions) {
    this.opts = {
      chainId: opts.chainId,
      contract: opts.contract,
      disputeWindowMs: opts.disputeWindowMs ?? 24 * 60 * 60 * 1000,
      openLatencyMs: opts.openLatencyMs ?? 0,
      closeLatencyMs: opts.closeLatencyMs ?? 0,
      userA: opts.userA,
    };
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((r) => setTimeout(r, ms));
  }

  async openChannel(args: OpenChannelOnChainArgs): Promise<OpenChannelOnChainResult> {
    await this.sleep(this.opts.openLatencyMs);
    const id = fakeHash(`${this.opts.userA}|${args.userB}|${this.nonce++}`);
    const openedAtMs = BigInt(Date.now());
    this.channels.set(id, {
      userA: this.opts.userA,
      userB: args.userB,
      token: args.token,
      amountA: args.amountA,
      amountB: args.amountB,
      openedAtMs,
      postedBalanceA: args.amountA,
      postedBalanceB: args.amountB,
      status: 'open',
    });
    return {
      channelId: id,
      userA: this.opts.userA,
      userB: args.userB,
      token: args.token,
      amountA: args.amountA,
      amountB: args.amountB,
      openedAtMs,
      txHash: fakeHash(`open-tx|${id}`),
    };
  }

  async closeCooperative(args: CloseCooperativeOnChainArgs): Promise<CloseOnChainResult> {
    await this.sleep(this.opts.closeLatencyMs);
    const ch = this.channels.get(args.channelId);
    if (!ch) throw new Error(`mock: unknown channel ${args.channelId}`);
    ch.postedBalanceA = args.signedClose.close.finalBalanceA;
    ch.postedBalanceB = args.signedClose.close.finalBalanceB;
    ch.status = 'closed';
    const txHash = fakeHash(`close-coop|${args.channelId}`);
    this.emitFinalized(args.channelId, ch.postedBalanceA, ch.postedBalanceB, txHash);
    return { txHash };
  }

  async closeUnilateral(args: CloseUnilateralOnChainArgs): Promise<CloseUnilateralOnChainResult> {
    await this.sleep(this.opts.closeLatencyMs);
    const ch = this.channels.get(args.channelId);
    if (!ch) throw new Error(`mock: unknown channel ${args.channelId}`);
    ch.postedBalanceA = args.state.state.balanceA;
    ch.postedBalanceB = args.state.state.balanceB;
    ch.status = 'closing';
    return {
      txHash: fakeHash(`close-uni|${args.channelId}`),
      disputeDeadlineMs: BigInt(Date.now() + this.opts.disputeWindowMs),
      postedVersion: args.state.state.version,
    };
  }

  async finalize(channelId: ChannelId): Promise<FinalizedResult> {
    const ch = this.channels.get(channelId);
    if (!ch) throw new Error(`mock: unknown channel ${channelId}`);
    ch.status = 'closed';
    const txHash = fakeHash(`finalize|${channelId}`);
    const result = { paidA: ch.postedBalanceA, paidB: ch.postedBalanceB, txHash };
    this.emitFinalized(channelId, ch.postedBalanceA, ch.postedBalanceB, txHash);
    return result;
  }

  async waitForFinalized(
    channelId: ChannelId,
    opts: { timeoutMs?: number } = {},
  ): Promise<FinalizedResult> {
    const ch = this.channels.get(channelId);
    if (ch?.status === 'closed') {
      return {
        paidA: ch.postedBalanceA,
        paidB: ch.postedBalanceB,
        txHash: fakeHash(`already-closed|${channelId}`),
      };
    }
    return new Promise<FinalizedResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finalizedListeners.get(channelId)?.delete(handler);
        reject(new Error('mock waitForFinalized timeout'));
      }, opts.timeoutMs ?? 60_000);
      const handler = (r: FinalizedResult): void => {
        clearTimeout(timer);
        resolve(r);
      };
      let set = this.finalizedListeners.get(channelId);
      if (!set) {
        set = new Set();
        this.finalizedListeners.set(channelId, set);
      }
      set.add(handler);
    });
  }

  private emitFinalized(channelId: ChannelId, paidA: bigint, paidB: bigint, txHash: Hex): void {
    const set = this.finalizedListeners.get(channelId);
    if (!set) return;
    for (const h of set) h({ paidA, paidB, txHash });
    this.finalizedListeners.delete(channelId);
  }

  asChannel(channelId: ChannelId, status: Channel['status'] = 'open'): Channel {
    const ch = this.channels.get(channelId);
    if (!ch) throw new Error(`mock: unknown channel ${channelId}`);
    return {
      id: channelId,
      chainId: this.opts.chainId,
      contract: this.opts.contract,
      userA: ch.userA,
      userB: ch.userB,
      token: ch.token,
      status,
      openedAt: ch.openedAtMs,
      disputeWindowMs: this.opts.disputeWindowMs,
    };
  }
}
