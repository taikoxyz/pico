export const NOSTR_KIND_RANGE = { min: 30401, max: 30420 } as const;

export const NOSTR_EVENT_KINDS = {
  PaymentQuote: 30401,
  PaymentInvoice: 30402,
  PaymentReceipt: 30403,
  ChannelOpenAd: 30404,
  ChannelInfo: 30405,
  HubAd: 30406,
  HubStatus: 30407,
  DvmPaymentOption: 30408,
} as const;

export type NostrEventKind = (typeof NOSTR_EVENT_KINDS)[keyof typeof NOSTR_EVENT_KINDS];

export const TAINNEL_EVENT_PREFIX = 'tainnel.' as const;

export function isNostrTainnelKind(kind: number): boolean {
  return kind >= NOSTR_KIND_RANGE.min && kind <= NOSTR_KIND_RANGE.max;
}
