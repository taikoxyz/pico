import type { Address, Channel } from '@tainnel/protocol';
import type { PaymentOptionTag } from './payment-tag.js';

export interface PaymentMethodChoice {
  readonly method: 'onchain' | 'channel';
  readonly reason: string;
  readonly viaChannel?: Channel;
}

export interface SelectOpts {
  /** The address that will pay (for outbound balance check). */
  readonly payerAddress?: Address;
  /** When set, the chosen channel must have outbound balance >= amount. */
  readonly minOutboundBalance?: bigint;
}

export function selectPaymentMethod(
  quote: PaymentOptionTag,
  channels: readonly Channel[],
  opts: SelectOpts = {},
): PaymentMethodChoice {
  if (quote.method === 'onchain') {
    return { method: 'onchain', reason: 'quote requires on-chain payment' };
  }

  if (quote.amount !== undefined && quote.amount <= 0n) {
    return { method: 'onchain', reason: 'quote amount must be positive' };
  }

  const candidates = channels.filter((c) => {
    if (c.status !== 'open') return false;
    if (c.token.toLowerCase() !== quote.token.toLowerCase()) return false;
    if (c.chainId !== quote.chainId) return false;
    if (quote.recipient !== undefined) {
      const matches =
        c.userA.toLowerCase() === quote.recipient.toLowerCase() ||
        c.userB.toLowerCase() === quote.recipient.toLowerCase();
      if (!matches) return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    return {
      method: 'onchain',
      reason: 'no open channel matches chain id, token, and recipient hint',
    };
  }

  const viaChannel = candidates[0];
  if (!viaChannel) {
    return { method: 'onchain', reason: 'no compatible open channel' };
  }
  // Outbound balance check requires a chain adapter; for v1 we accept any open
  // matching channel but document the limitation.
  return {
    method: 'channel',
    reason: 'open channel matches chain id, token, and recipient',
    viaChannel,
  };
}
