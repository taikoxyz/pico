export const paymentChannelAbi = [
  {
    type: 'function',
    name: 'openChannel',
    stateMutability: 'payable',
    inputs: [
      { name: 'userB', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amountA', type: 'uint256' },
      { name: 'amountB', type: 'uint256' },
    ],
    outputs: [{ name: 'channelId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'closeCooperative',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'finalState', type: 'bytes' },
      { name: 'sigA', type: 'bytes' },
      { name: 'sigB', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'closeUnilateral',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'state', type: 'bytes' },
      { name: 'sigCounterparty', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'dispute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'state', type: 'bytes' },
      { name: 'sigCloser', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'finalize',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'ChannelOpened',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'userA', type: 'address', indexed: true },
      { name: 'userB', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: false },
      { name: 'amountA', type: 'uint256', indexed: false },
      { name: 'amountB', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ChannelClosedCooperative',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'finalVersion', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ChannelClosingUnilateral',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'postedVersion', type: 'uint64', indexed: false },
      { name: 'disputeDeadline', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ChannelFinalized',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'paidA', type: 'uint256', indexed: false },
      { name: 'paidB', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'DisputeRaised',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'challengerVersion', type: 'uint64', indexed: false },
    ],
  },
] as const;

export const channelStateSolidityStruct = [
  { name: 'channelId', type: 'bytes32' },
  { name: 'version', type: 'uint64' },
  { name: 'balanceA', type: 'uint256' },
  { name: 'balanceB', type: 'uint256' },
  { name: 'htlcsRoot', type: 'bytes32' },
  { name: 'finalized', type: 'bool' },
] as const;
