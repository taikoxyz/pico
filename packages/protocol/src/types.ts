export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type ChannelId = Hex;
export type HtlcId = Hex;
export type PaymentHash = Hex;
export type Preimage = Hex;

export type ChainId = 167000 | 167009;

export type Asset = 'ETH' | 'USDC';

export interface TokenInfo {
  readonly asset: Asset;
  readonly address: Address;
  readonly decimals: number;
  readonly chainId: ChainId;
}

export type ChannelStatus =
  | 'pending'
  | 'open'
  | 'closing-cooperative'
  | 'closing-unilateral'
  | 'disputed'
  | 'closed';

export interface Channel {
  readonly id: ChannelId;
  readonly chainId: ChainId;
  readonly contract: Address;
  readonly userA: Address;
  readonly userB: Address;
  readonly token: Address;
  readonly status: ChannelStatus;
  readonly openedAt: bigint;
  readonly disputeWindowMs: number;
}

export interface ChannelState {
  readonly channelId: ChannelId;
  readonly version: bigint;
  readonly balanceA: bigint;
  readonly balanceB: bigint;
  readonly htlcs: readonly Htlc[];
  readonly finalized: boolean;
}

export interface Htlc {
  readonly id: HtlcId;
  readonly direction: 'AtoB' | 'BtoA';
  readonly amount: bigint;
  readonly paymentHash: PaymentHash;
  readonly expiryMs: bigint;
}

export interface Update {
  readonly channelId: ChannelId;
  readonly fromVersion: bigint;
  readonly toVersion: bigint;
  readonly nextState: ChannelState;
}

export interface CooperativeClose {
  readonly channelId: ChannelId;
  readonly finalBalanceA: bigint;
  readonly finalBalanceB: bigint;
  readonly signedAt: bigint;
}

export interface Signature {
  readonly r: Hex;
  readonly s: Hex;
  readonly v: number;
}

export interface SignedState {
  readonly state: ChannelState;
  readonly sigA: Signature;
  readonly sigB: Signature;
}
