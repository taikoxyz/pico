import { type Abi, parseAbi } from 'viem';

export const PAYMENT_CHANNEL_EVENTS_ABI: Abi = parseAbi([
  'event ChannelOpened(bytes32 indexed channelId, address indexed userA, address indexed userB, address token, uint256 amountA, uint256 amountB)',
  'event ChannelClosingUnilateral(bytes32 indexed channelId, uint64 postedVersion, uint256 disputeDeadline)',
  'event DisputeRaised(bytes32 indexed channelId, uint64 challengerVersion)',
  'event ChannelFinalized(bytes32 indexed channelId, uint256 paidA, uint256 paidB)',
]);

export const SUBMIT_PENALTY_PROOF_ABI: Abi = parseAbi([
  'function submitPenaltyProof(bytes32 channelId, bytes penaltyState, bytes signature) external',
]);

export const CHANNEL_STATE_ABI_PARAMS = [
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
