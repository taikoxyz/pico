import type { Address, Hex } from '@tainnel/protocol';

export interface KeyFixture {
  readonly name: string;
  readonly privateKey: Hex;
  readonly address: Address;
}

export const TEST_KEYS: Readonly<Record<'alice' | 'bob' | 'hub' | 'watchtower', KeyFixture>> = {
  alice: {
    name: 'alice',
    privateKey: '0x000000000000000000000000000000000000000000000000000000000000a11c',
    address: '0x00000000000000000000000000000000000000a1',
  },
  bob: {
    name: 'bob',
    privateKey: '0x0000000000000000000000000000000000000000000000000000000000000b0b',
    address: '0x00000000000000000000000000000000000000b0',
  },
  hub: {
    name: 'hub',
    privateKey: '0x00000000000000000000000000000000000000000000000000000000000000bb',
    address: '0x00000000000000000000000000000000000000c0',
  },
  watchtower: {
    name: 'watchtower',
    privateKey: '0x0000000000000000000000000000000000000000000000000000000000000ccc',
    address: '0x00000000000000000000000000000000000000d0',
  },
};
