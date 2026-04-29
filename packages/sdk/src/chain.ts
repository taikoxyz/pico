import type { Address, ChainId, ChannelId, Hex, SignedState } from '@tainnel/protocol';

export interface OpenChannelTxArgs {
  readonly contract: Address;
  readonly userB: Address;
  readonly token: Address;
  readonly amountA: bigint;
  readonly amountB: bigint;
}

export interface OpenChannelReceipt {
  readonly channelId: ChannelId;
  readonly userA: Address;
  readonly userB: Address;
  readonly token: Address;
  readonly amountA: bigint;
  readonly amountB: bigint;
  readonly txHash: Hex;
  readonly blockTimestamp: bigint;
}

export interface CloseCooperativeTxArgs {
  readonly contract: Address;
  readonly channelId: ChannelId;
  readonly state: SignedState;
}

export interface CloseUnilateralTxArgs {
  readonly contract: Address;
  readonly channelId: ChannelId;
  readonly state: SignedState;
  /** Which side of the channel is the closing party. The other side's sig
   * is the on-chain `sigCounterparty` argument; the closer's sig is implicit
   * via msg.sender. */
  readonly closerSide?: 'A' | 'B';
}

export interface CloseReceipt {
  readonly channelId: ChannelId;
  readonly txHash: Hex;
}

export interface ChannelFinalizedReceipt {
  readonly channelId: ChannelId;
  readonly paidA: bigint;
  readonly paidB: bigint;
  readonly txHash: Hex;
}

export interface WaitForFinalizedOptions {
  readonly timeoutMs?: number;
}

export interface ChainAdapter {
  readonly chainId: ChainId;
  openChannel(args: OpenChannelTxArgs): Promise<OpenChannelReceipt>;
  closeCooperative(args: CloseCooperativeTxArgs): Promise<CloseReceipt>;
  closeUnilateral(args: CloseUnilateralTxArgs): Promise<CloseReceipt>;
  waitForFinalized?(
    channelId: ChannelId,
    opts?: WaitForFinalizedOptions,
  ): Promise<ChannelFinalizedReceipt>;
}
