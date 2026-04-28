import {
  type Address,
  CHANNEL_STATE_TYPES,
  COOPERATIVE_CLOSE_TYPES,
  type ChainId,
  type ChannelState,
  type CooperativeClose,
  type Eip712Domain,
  HTLC_TYPES,
  type Hex,
  type Htlc,
  UPDATE_TYPES,
  type Update,
  buildDomain,
  htlcDirectionByte,
  htlcExpirySeconds,
  htlcMerkleRoot,
} from '@tainnel/protocol';
import { hashTypedData, recoverTypedDataAddress } from 'viem';

export interface ChannelStateTypedData {
  readonly domain: Eip712Domain;
  readonly types: typeof CHANNEL_STATE_TYPES;
  readonly primaryType: 'ChannelState';
  readonly message: {
    readonly channelId: Hex;
    readonly version: bigint;
    readonly balanceA: bigint;
    readonly balanceB: bigint;
    readonly htlcsRoot: Hex;
    readonly finalized: boolean;
  };
}

export interface HtlcTypedData {
  readonly domain: Eip712Domain;
  readonly types: typeof HTLC_TYPES;
  readonly primaryType: 'Htlc';
  readonly message: {
    readonly id: Hex;
    readonly amount: bigint;
    readonly paymentHash: Hex;
    readonly expiry: bigint;
    readonly direction: number;
  };
}

export interface UpdateTypedData {
  readonly domain: Eip712Domain;
  readonly types: typeof UPDATE_TYPES;
  readonly primaryType: 'Update';
  readonly message: {
    readonly channelId: Hex;
    readonly fromVersion: bigint;
    readonly toVersion: bigint;
    readonly nextState: ChannelStateTypedData['message'];
  };
}

export interface CooperativeCloseTypedData {
  readonly domain: Eip712Domain;
  readonly types: typeof COOPERATIVE_CLOSE_TYPES;
  readonly primaryType: 'CooperativeClose';
  readonly message: {
    readonly channelId: Hex;
    readonly finalBalanceA: bigint;
    readonly finalBalanceB: bigint;
    readonly signedAt: bigint;
  };
}

function channelStateMessage(state: ChannelState): ChannelStateTypedData['message'] {
  return {
    channelId: state.channelId,
    version: state.version,
    balanceA: state.balanceA,
    balanceB: state.balanceB,
    htlcsRoot: htlcMerkleRoot(state.htlcs),
    finalized: state.finalized,
  };
}

export function buildChannelStateTypedData(
  state: ChannelState,
  chainId: ChainId,
  verifyingContract: Address,
): ChannelStateTypedData {
  return {
    domain: buildDomain(chainId, verifyingContract),
    types: CHANNEL_STATE_TYPES,
    primaryType: 'ChannelState',
    message: channelStateMessage(state),
  };
}

export function buildHtlcTypedData(
  htlc: Htlc,
  chainId: ChainId,
  verifyingContract: Address,
): HtlcTypedData {
  return {
    domain: buildDomain(chainId, verifyingContract),
    types: HTLC_TYPES,
    primaryType: 'Htlc',
    message: {
      id: htlc.id,
      amount: htlc.amount,
      paymentHash: htlc.paymentHash,
      expiry: htlcExpirySeconds(htlc),
      direction: htlcDirectionByte(htlc.direction),
    },
  };
}

export function buildUpdateTypedData(
  update: Update,
  chainId: ChainId,
  verifyingContract: Address,
): UpdateTypedData {
  return {
    domain: buildDomain(chainId, verifyingContract),
    types: UPDATE_TYPES,
    primaryType: 'Update',
    message: {
      channelId: update.channelId,
      fromVersion: update.fromVersion,
      toVersion: update.toVersion,
      nextState: channelStateMessage(update.nextState),
    },
  };
}

export function buildCooperativeCloseTypedData(
  close: CooperativeClose,
  chainId: ChainId,
  verifyingContract: Address,
): CooperativeCloseTypedData {
  return {
    domain: buildDomain(chainId, verifyingContract),
    types: COOPERATIVE_CLOSE_TYPES,
    primaryType: 'CooperativeClose',
    message: {
      channelId: close.channelId,
      finalBalanceA: close.finalBalanceA,
      finalBalanceB: close.finalBalanceB,
      signedAt: close.signedAt,
    },
  };
}

async function recoveredMatches(
  data: Parameters<typeof recoverTypedDataAddress>[0],
  expectedSigner: Address,
): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress(data);
    return recovered.toLowerCase() === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}

export function hashChannelState(
  state: ChannelState,
  chainId: ChainId,
  verifyingContract: Address,
): Hex {
  return hashTypedData(buildChannelStateTypedData(state, chainId, verifyingContract));
}

export function verifyChannelStateSignature(
  state: ChannelState,
  signature: Hex,
  expectedSigner: Address,
  chainId: ChainId,
  verifyingContract: Address,
): Promise<boolean> {
  return recoveredMatches(
    { ...buildChannelStateTypedData(state, chainId, verifyingContract), signature },
    expectedSigner,
  );
}

export function hashHtlc(htlc: Htlc, chainId: ChainId, verifyingContract: Address): Hex {
  return hashTypedData(buildHtlcTypedData(htlc, chainId, verifyingContract));
}

export function verifyHtlcSignature(
  htlc: Htlc,
  signature: Hex,
  expectedSigner: Address,
  chainId: ChainId,
  verifyingContract: Address,
): Promise<boolean> {
  return recoveredMatches(
    { ...buildHtlcTypedData(htlc, chainId, verifyingContract), signature },
    expectedSigner,
  );
}

export function hashUpdate(update: Update, chainId: ChainId, verifyingContract: Address): Hex {
  return hashTypedData(buildUpdateTypedData(update, chainId, verifyingContract));
}

export function verifyUpdateSignature(
  update: Update,
  signature: Hex,
  expectedSigner: Address,
  chainId: ChainId,
  verifyingContract: Address,
): Promise<boolean> {
  return recoveredMatches(
    { ...buildUpdateTypedData(update, chainId, verifyingContract), signature },
    expectedSigner,
  );
}

export function hashCooperativeClose(
  close: CooperativeClose,
  chainId: ChainId,
  verifyingContract: Address,
): Hex {
  return hashTypedData(buildCooperativeCloseTypedData(close, chainId, verifyingContract));
}

export function verifyCooperativeCloseSignature(
  close: CooperativeClose,
  signature: Hex,
  expectedSigner: Address,
  chainId: ChainId,
  verifyingContract: Address,
): Promise<boolean> {
  return recoveredMatches(
    { ...buildCooperativeCloseTypedData(close, chainId, verifyingContract), signature },
    expectedSigner,
  );
}
