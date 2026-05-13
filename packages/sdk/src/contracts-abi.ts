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
      { name: 'closeData', type: 'bytes' },
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
    name: 'closeUnilateralFromOpen',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'topUp',
    stateMutability: 'payable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      {
        name: 'prev',
        type: 'tuple',
        components: [
          {
            name: 'state',
            type: 'tuple',
            components: [
              { name: 'channelId', type: 'bytes32' },
              { name: 'version', type: 'uint64' },
              { name: 'balanceA', type: 'uint256' },
              { name: 'balanceB', type: 'uint256' },
              { name: 'htlcsRoot', type: 'bytes32' },
              { name: 'htlcsCount', type: 'uint16' },
              { name: 'htlcsTotalLocked', type: 'uint256' },
              { name: 'finalized', type: 'bool' },
            ],
          },
          { name: 'sigA', type: 'bytes' },
          { name: 'sigB', type: 'bytes' },
        ],
      },
      {
        name: 'next',
        type: 'tuple',
        components: [
          {
            name: 'state',
            type: 'tuple',
            components: [
              { name: 'channelId', type: 'bytes32' },
              { name: 'version', type: 'uint64' },
              { name: 'balanceA', type: 'uint256' },
              { name: 'balanceB', type: 'uint256' },
              { name: 'htlcsRoot', type: 'bytes32' },
              { name: 'htlcsCount', type: 'uint16' },
              { name: 'htlcsTotalLocked', type: 'uint256' },
              { name: 'finalized', type: 'bool' },
            ],
          },
          { name: 'sigA', type: 'bytes' },
          { name: 'sigB', type: 'bytes' },
        ],
      },
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
      { name: 'sigA', type: 'bytes' },
      { name: 'sigB', type: 'bytes' },
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
    type: 'function',
    name: 'claimHtlc',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      {
        name: 'htlc',
        type: 'tuple',
        components: [
          { name: 'id', type: 'bytes32' },
          { name: 'amount', type: 'uint256' },
          { name: 'paymentHash', type: 'bytes32' },
          { name: 'expiry', type: 'uint64' },
          { name: 'direction', type: 'uint8' },
        ],
      },
      { name: 'proof', type: 'bytes32[]' },
      { name: 'sortedIndex', type: 'uint256' },
      { name: 'totalLeaves', type: 'uint256' },
      { name: 'preimage', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'refundHtlc',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      {
        name: 'htlc',
        type: 'tuple',
        components: [
          { name: 'id', type: 'bytes32' },
          { name: 'amount', type: 'uint256' },
          { name: 'paymentHash', type: 'bytes32' },
          { name: 'expiry', type: 'uint64' },
          { name: 'direction', type: 'uint8' },
        ],
      },
      { name: 'proof', type: 'bytes32[]' },
      { name: 'sortedIndex', type: 'uint256' },
      { name: 'totalLeaves', type: 'uint256' },
    ],
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
      { name: 'finalBalanceA', type: 'uint256', indexed: false },
      { name: 'finalBalanceB', type: 'uint256', indexed: false },
      { name: 'signedAt', type: 'uint64', indexed: false },
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
  {
    type: 'event',
    name: 'ToppedUp',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'depositor', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'newVersion', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'HtlcResolutionStarted',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'htlcResolutionDeadline', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'HtlcClaimed',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'htlcId', type: 'bytes32', indexed: true },
      { name: 'receiver', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'preimage', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'HtlcRefunded',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'htlcId', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const channelStateSolidityStruct = [
  { name: 'channelId', type: 'bytes32' },
  { name: 'version', type: 'uint64' },
  { name: 'balanceA', type: 'uint256' },
  { name: 'balanceB', type: 'uint256' },
  { name: 'htlcsRoot', type: 'bytes32' },
  { name: 'htlcsCount', type: 'uint16' },
  { name: 'htlcsTotalLocked', type: 'uint256' },
  { name: 'finalized', type: 'bool' },
] as const;

export const htlcSolidityStruct = [
  { name: 'id', type: 'bytes32' },
  { name: 'amount', type: 'uint256' },
  { name: 'paymentHash', type: 'bytes32' },
  { name: 'expiry', type: 'uint64' },
  { name: 'direction', type: 'uint8' },
] as const;

export const cooperativeCloseSolidityStruct = [
  { name: 'channelId', type: 'bytes32' },
  { name: 'version', type: 'uint64' },
  { name: 'finalBalanceA', type: 'uint256' },
  { name: 'finalBalanceB', type: 'uint256' },
  { name: 'signedAt', type: 'uint64' },
  { name: 'validUntil', type: 'uint64' },
] as const;
