import type { Channel } from '@tainnel/protocol';
import type { PaymentOptionTag } from './payment-tag.js';

export interface PaymentMethodChoice {
  readonly method: 'onchain' | 'channel';
  readonly reason: string;
  readonly viaChannel?: Channel;
}

export function selectPaymentMethod(
  quote: PaymentOptionTag,
  channels: readonly Channel[],
): PaymentMethodChoice {
  if (quote.method === 'onchain') {
    return { method: 'onchain', reason: 'quote requires on-chain payment' };
  }
  const candidate = channels.find((c) => c.status === 'open' && c.token === quote.token);
  if (candidate) {
    return { method: 'channel', reason: 'open channel available', viaChannel: candidate };
  }
  return { method: 'onchain', reason: 'no compatible open channel' };
}
