import type { Address, ChainId } from '@tainnel/protocol';

export interface PaymentOptionTag {
  readonly method: 'onchain' | 'channel';
  readonly token: Address;
  readonly chainId: ChainId;
  readonly amount: bigint;
  readonly recipient: Address;
  readonly hubHints?: readonly string[];
}

export const TAG_NAME = 'tainnel-pay' as const;

export function encodePaymentOption(option: PaymentOptionTag): string[] {
  const tag: string[] = [
    TAG_NAME,
    option.method,
    option.token,
    option.chainId.toString(),
    option.amount.toString(),
    option.recipient,
  ];
  if (option.hubHints && option.hubHints.length > 0) {
    tag.push(option.hubHints.join(','));
  }
  return tag;
}

export function decodePaymentOption(raw: readonly string[]): PaymentOptionTag {
  if (raw[0] !== TAG_NAME) {
    throw new Error(`expected tag '${TAG_NAME}', got '${raw[0]}'`);
  }
  const method = raw[1];
  if (method !== 'onchain' && method !== 'channel') {
    throw new Error(`unknown payment method: ${method}`);
  }
  const token = raw[2] as Address | undefined;
  const chainIdStr = raw[3];
  const amountStr = raw[4];
  const recipient = raw[5] as Address | undefined;
  if (!token || !chainIdStr || !amountStr || !recipient) {
    throw new Error('malformed tainnel-pay tag');
  }
  const chainId = Number(chainIdStr) as ChainId;
  const amount = BigInt(amountStr);
  const hubHints = raw[6] ? raw[6].split(',').filter(Boolean) : undefined;
  return { method, token, chainId, amount, recipient, ...(hubHints ? { hubHints } : {}) };
}
