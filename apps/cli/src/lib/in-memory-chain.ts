/* TEST-ONLY chain adapter. Used when TAINNEL_CHAIN_MODE=memory so the CLI's
 * E2E test can spawn subprocesses without anvil or a real RPC. Returns
 * deterministic synthetic receipts; the mock hub does not verify them. */
import type { Address, ChainId, ChannelId, Hex } from '@tainnel/protocol';
import type {
  ChainAdapter,
  CloseCooperativeTxArgs,
  CloseReceipt,
  CloseUnilateralTxArgs,
  OpenChannelReceipt,
  OpenChannelTxArgs,
} from '@tainnel/sdk';
import { keccak256, toHex } from 'viem';

export interface InMemoryChainAdapterOptions {
  readonly chainId: ChainId;
  readonly userA: Address;
}

export class InMemoryChainAdapter implements ChainAdapter {
  readonly chainId: ChainId;
  private readonly userA: Address;

  constructor(opts: InMemoryChainAdapterOptions) {
    this.chainId = opts.chainId;
    this.userA = opts.userA;
  }

  async openChannel(args: OpenChannelTxArgs): Promise<OpenChannelReceipt> {
    const seed = keccak256(
      toHex(`${this.userA}${args.userB}${args.token}${args.amountA}${args.amountB}${Date.now()}`),
    );
    return {
      channelId: seed as ChannelId,
      userA: this.userA,
      userB: args.userB,
      token: args.token,
      amountA: args.amountA,
      amountB: args.amountB,
      txHash: `0x${'11'.repeat(32)}` as Hex,
      blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    };
  }

  async closeCooperative(args: CloseCooperativeTxArgs): Promise<CloseReceipt> {
    return { channelId: args.channelId, txHash: `0x${'22'.repeat(32)}` as Hex };
  }

  async closeUnilateral(args: CloseUnilateralTxArgs): Promise<CloseReceipt> {
    return { channelId: args.channelId, txHash: `0x${'33'.repeat(32)}` as Hex };
  }
}
