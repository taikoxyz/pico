import type { Address, Hex } from '@tainnel/protocol';
import { privateKeyToAccount } from 'viem/accounts';

export interface KeyFixture {
  readonly name: string;
  readonly privateKey: Hex;
  readonly address: Address;
}

function fixture(name: string, privateKey: Hex): KeyFixture {
  return { name, privateKey, address: privateKeyToAccount(privateKey).address };
}

export const TEST_KEYS: Readonly<Record<'alice' | 'bob' | 'hub' | 'watchtower', KeyFixture>> = {
  alice: fixture('alice', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'),
  bob: fixture('bob', '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'),
  hub: fixture('hub', '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'),
  watchtower: fixture(
    'watchtower',
    '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  ),
};
